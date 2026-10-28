// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PoolEscrow
/// @notice Holds equal stakes for a 1v1 pool match and pays the pot to the winner named in a
///         result signed by the game server. The server never holds funds; the owner can never
///         touch stakes. If the server disappears, either player can reclaim their stake.
contract PoolEscrow is Ownable, EIP712, ReentrancyGuard {
    enum Status { None, Open, Active, Settled, Cancelled }

    struct Match {
        address playerA;
        address playerB;
        uint256 stake; // each player's stake
        uint64 activeAt; // when B joined
        uint16 rakeBps; // fixed at join time so later fee changes can't affect a running match
        Status status;
    }

    uint256 public constant MAX_MATCH_DURATION = 1 hours;
    uint16 public constant MAX_RAKE_BPS = 1000; // 10%
    bytes32 private constant RESULT_TYPEHASH = keccak256("Result(bytes32 matchId,address winner)");

    address public resultSigner;
    address public feeRecipient;
    uint16 public rakeBps;

    mapping(bytes32 => Match) public matches;
    /// @dev Payouts whose push failed (e.g. recipient contract reverts) wait here for `withdraw`.
    mapping(address => uint256) public pending;

    event MatchCreated(bytes32 indexed matchId, address indexed playerA, address indexed playerB, uint256 stake);
    event MatchJoined(bytes32 indexed matchId);
    /// @param winner address(0) means the match was voided and both stakes were refunded.
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 payout, uint256 rake);
    event MatchCancelled(bytes32 indexed matchId);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ResultSignerChanged(address signer);
    event FeeConfigChanged(address recipient, uint16 bps);

    error ZeroAddress();
    error InvalidStake();
    error InvalidOpponent();
    error MatchExists();
    error NotOpen();
    error NotActive();
    error NotOpponent();
    error StakeMismatch();
    error NotPlayerA();
    error NotPlayer();
    error TooEarly();
    error InvalidWinner();
    error BadSignature();
    error RakeTooHigh();
    error NothingPending();
    error TransferFailed();

    constructor(address owner_, address resultSigner_, address feeRecipient_, uint16 rakeBps_)
        Ownable(owner_)
        EIP712("PoolEscrow", "1")
    {
        _setResultSigner(resultSigner_);
        _setFeeConfig(feeRecipient_, rakeBps_);
    }

    // ---------------------------------------------------------------- match lifecycle

    /// @notice Match ids are derived from the creator so nobody can squat an id the server handed out.
    function matchIdFor(address playerA, address playerB, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(playerA, playerB, salt));
    }

    /// @notice Player A opens a match against a specific opponent, depositing the stake.
    function createMatch(address opponent, bytes32 salt) external payable returns (bytes32 matchId) {
        if (msg.value == 0) revert InvalidStake();
        if (opponent == address(0) || opponent == msg.sender) revert InvalidOpponent();
        matchId = matchIdFor(msg.sender, opponent, salt);
        Match storage m = matches[matchId];
        if (m.status != Status.None) revert MatchExists();

        m.playerA = msg.sender;
        m.playerB = opponent;
        m.stake = msg.value;
        m.status = Status.Open;
        emit MatchCreated(matchId, msg.sender, opponent, msg.value);
    }

    /// @notice The named opponent matches the stake, which starts the match.
    function joinMatch(bytes32 matchId) external payable {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert NotOpen();
        if (msg.sender != m.playerB) revert NotOpponent();
        if (msg.value != m.stake) revert StakeMismatch();

        m.status = Status.Active;
        m.activeAt = uint64(block.timestamp);
        m.rakeBps = rakeBps;
        emit MatchJoined(matchId);
    }

    /// @notice Player A withdraws an unjoined match.
    function cancel(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert NotOpen();
        if (msg.sender != m.playerA) revert NotPlayerA();
        m.status = Status.Cancelled;
        emit MatchCancelled(matchId);
        _pay(m.playerA, m.stake);
    }

    /// @notice Anyone may submit the server-signed result. `winner == address(0)` voids the match
    ///         and refunds both players.
    function settle(bytes32 matchId, address winner, bytes calldata signature) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();
        if (winner != address(0) && winner != m.playerA && winner != m.playerB) revert InvalidWinner();
        if (ECDSA.recover(resultDigest(matchId, winner), signature) != resultSigner) revert BadSignature();

        m.status = Status.Settled;
        uint256 stake = m.stake;

        if (winner == address(0)) {
            emit MatchSettled(matchId, address(0), 0, 0);
            _pay(m.playerA, stake);
            _pay(m.playerB, stake);
            return;
        }

        uint256 pot = stake * 2;
        uint256 rake = (pot * m.rakeBps) / 10_000;
        uint256 payout = pot - rake;
        emit MatchSettled(matchId, winner, payout, rake);
        _pay(winner, payout);
        _pay(feeRecipient, rake);
    }

    /// @notice Escape hatch if the server never settles: after MAX_MATCH_DURATION either player
    ///         can return both stakes.
    function refund(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();
        if (msg.sender != m.playerA && msg.sender != m.playerB) revert NotPlayer();
        if (block.timestamp < uint256(m.activeAt) + MAX_MATCH_DURATION) revert TooEarly();

        m.status = Status.Cancelled;
        emit MatchCancelled(matchId);
        _pay(m.playerA, m.stake);
        _pay(m.playerB, m.stake);
    }

    /// @notice Claim payouts that couldn't be pushed.
    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingPending();
        pending[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- views

    /// @notice EIP-712 digest the result signer must sign.
    function resultDigest(bytes32 matchId, address winner) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, matchId, winner)));
    }

    // ---------------------------------------------------------------- admin

    function setResultSigner(address signer) external onlyOwner {
        _setResultSigner(signer);
    }

    function setFeeConfig(address recipient, uint16 bps) external onlyOwner {
        _setFeeConfig(recipient, bps);
    }

    // ---------------------------------------------------------------- internals

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

    /// @dev Push payment; on failure park the funds so one bad recipient can't block the other player.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            pending[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }
}
