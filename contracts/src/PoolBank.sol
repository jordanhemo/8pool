// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PoolBank
/// @notice Players keep a balance in this contract. A signed, expiring `Play` authorization lets the
///         game operator lock up to `maxStake` of it per match, so there is no wallet popup per game.
///         The winner named in a server-signed result is credited inside the contract (no claim step)
///         and can withdraw any unlocked balance at any time. If the server vanishes, either player
///         can unlock both stakes after `MAX_MATCH_DURATION`.
contract PoolBank is Ownable, EIP712, ReentrancyGuard {
    enum Status { None, Active, Settled, Cancelled }

    struct Match {
        address playerA;
        address playerB;
        uint256 stake; // each player's stake
        uint64 activeAt;
        uint16 rakeBps; // fixed at start so later fee changes can't affect a running match
        Status status;
    }

    /// @dev What a player signs once: "the operator may lock up to `maxStake` of my balance per match
    ///      until `expiry`". `nonce` must equal `authNonce[player]`, so `revokeAuthorizations` kills all.
    struct Auth {
        uint256 maxStake;
        uint256 expiry;
        bytes signature;
    }

    uint256 public constant MAX_MATCH_DURATION = 1 hours;
    uint16 public constant MAX_RAKE_BPS = 1000; // 10%
    bytes32 private constant RESULT_TYPEHASH = keccak256("Result(bytes32 matchId,address winner)");
    bytes32 private constant PLAY_TYPEHASH = keccak256("Play(address player,uint256 maxStake,uint256 expiry,uint256 nonce)");

    address public operator; // starts matches (and may settle them); can never move unlocked balances
    address public resultSigner;
    address public feeRecipient;
    uint16 public rakeBps;

    mapping(address => uint256) public balanceOf; // withdrawable
    mapping(address => bytes32) public activeMatch; // the match a player's locked stake is in (0 = none)
    mapping(address => uint256) public authNonce;
    mapping(bytes32 => Match) public matches;

    event Deposited(address indexed player, uint256 amount);
    event Withdrawn(address indexed player, uint256 amount);
    event AuthorizationsRevoked(address indexed player, uint256 newNonce);
    event MatchStarted(bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint256 stake);
    /// @param winner address(0) means the match was voided and both stakes were returned.
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 payout, uint256 rake);
    event MatchCancelled(bytes32 indexed matchId);
    event OperatorChanged(address operator);
    event ResultSignerChanged(address signer);
    event FeeConfigChanged(address recipient, uint16 bps);

    error ZeroAddress();
    error NotOperator();
    error InvalidStake();
    error InvalidOpponent();
    error MatchExists();
    error AlreadyPlaying();
    error InsufficientBalance();
    error BadAuthorization();
    error NotActive();
    error NotPlayer();
    error TooEarly();
    error InvalidWinner();
    error BadSignature();
    error RakeTooHigh();
    error TransferFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address owner_, address operator_, address resultSigner_, address feeRecipient_, uint16 rakeBps_)
        Ownable(owner_)
        EIP712("PoolBank", "1")
    {
        _setOperator(operator_);
        _setResultSigner(resultSigner_);
        _setFeeConfig(feeRecipient_, rakeBps_);
    }

    receive() external payable {
        _deposit();
    }

    // ---------------------------------------------------------------- bankroll

    function deposit() external payable {
        _deposit();
    }

    /// @notice Withdraw any balance that isn't locked in a running match.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Invalidate every `Play` authorization signed so far.
    function revokeAuthorizations() external {
        emit AuthorizationsRevoked(msg.sender, ++authNonce[msg.sender]);
    }

    // ---------------------------------------------------------------- match lifecycle

    function matchIdFor(address playerA, address playerB, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(playerA, playerB, salt));
    }

    /// @notice Lock `stake` from both players' balances and start the match, atomically.
    function startMatch(address playerA, address playerB, uint256 stake, bytes32 salt, Auth calldata authA, Auth calldata authB)
        external
        onlyOperator
        returns (bytes32 matchId)
    {
        if (stake == 0) revert InvalidStake();
        if (playerA == address(0) || playerB == address(0) || playerA == playerB) revert InvalidOpponent();
        if (activeMatch[playerA] != 0 || activeMatch[playerB] != 0) revert AlreadyPlaying();
        if (balanceOf[playerA] < stake || balanceOf[playerB] < stake) revert InsufficientBalance();
        _checkAuth(playerA, stake, authA);
        _checkAuth(playerB, stake, authB);

        matchId = matchIdFor(playerA, playerB, salt);
        Match storage m = matches[matchId];
        if (m.status != Status.None) revert MatchExists();

        balanceOf[playerA] -= stake;
        balanceOf[playerB] -= stake;
        activeMatch[playerA] = matchId;
        activeMatch[playerB] = matchId;
        m.playerA = playerA;
        m.playerB = playerB;
        m.stake = stake;
        m.activeAt = uint64(block.timestamp);
        m.rakeBps = rakeBps;
        m.status = Status.Active;
        emit MatchStarted(matchId, playerA, playerB, stake);
    }

    /// @notice Anyone may submit the server-signed result. `winner == address(0)` voids the match.
    ///         Credits go to in-contract balances, so there is nothing for a player to claim.
    function settle(bytes32 matchId, address winner, bytes calldata signature) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();
        if (winner != address(0) && winner != m.playerA && winner != m.playerB) revert InvalidWinner();
        if (ECDSA.recover(resultDigest(matchId, winner), signature) != resultSigner) revert BadSignature();

        m.status = Status.Settled;
        _unlock(m);
        uint256 stake = m.stake;

        if (winner == address(0)) {
            balanceOf[m.playerA] += stake;
            balanceOf[m.playerB] += stake;
            emit MatchSettled(matchId, address(0), 0, 0);
            return;
        }

        uint256 pot = stake * 2;
        uint256 rake = (pot * m.rakeBps) / 10_000;
        uint256 payout = pot - rake;
        balanceOf[winner] += payout;
        if (rake > 0) balanceOf[feeRecipient] += rake;
        emit MatchSettled(matchId, winner, payout, rake);
    }

    /// @notice Escape hatch if nobody settles: after MAX_MATCH_DURATION either player unlocks both stakes.
    function refund(bytes32 matchId) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();
        if (msg.sender != m.playerA && msg.sender != m.playerB) revert NotPlayer();
        if (block.timestamp < uint256(m.activeAt) + MAX_MATCH_DURATION) revert TooEarly();

        m.status = Status.Cancelled;
        _unlock(m);
        balanceOf[m.playerA] += m.stake;
        balanceOf[m.playerB] += m.stake;
        emit MatchCancelled(matchId);
    }

    // ---------------------------------------------------------------- views

    function resultDigest(bytes32 matchId, address winner) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, matchId, winner)));
    }

    function playDigest(address player, uint256 maxStake, uint256 expiry, uint256 nonce) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PLAY_TYPEHASH, player, maxStake, expiry, nonce)));
    }

    // ---------------------------------------------------------------- admin

    function setOperator(address operator_) external onlyOwner {
        _setOperator(operator_);
    }

    function setResultSigner(address signer) external onlyOwner {
        _setResultSigner(signer);
    }

    function setFeeConfig(address recipient, uint16 bps) external onlyOwner {
        _setFeeConfig(recipient, bps);
    }

    // ---------------------------------------------------------------- internals

    function _deposit() private {
        if (msg.value == 0) revert InvalidStake();
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function _unlock(Match storage m) private {
        delete activeMatch[m.playerA];
        delete activeMatch[m.playerB];
    }

    /// @dev Supports contract wallets (ERC-1271) as well as EOAs.
    function _checkAuth(address player, uint256 stake, Auth calldata a) private view {
        if (stake > a.maxStake || block.timestamp > a.expiry) revert BadAuthorization();
        bytes32 digest = playDigest(player, a.maxStake, a.expiry, authNonce[player]);
        if (!SignatureChecker.isValidSignatureNow(player, digest, a.signature)) revert BadAuthorization();
    }

    function _setOperator(address operator_) private {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function _setResultSigner(address signer) private {
        if (signer == address(0)) revert ZeroAddress();
        resultSigner = signer;
        emit ResultSignerChanged(signer);
    }

    function _setFeeConfig(address recipient, uint16 bps) private {
        if (recipient == address(0)) revert ZeroAddress();
        if (bps > MAX_RAKE_BPS) revert RakeTooHigh();
        feeRecipient = recipient;
        rakeBps = bps;
        emit FeeConfigChanged(recipient, bps);
    }
}
