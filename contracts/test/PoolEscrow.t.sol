// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PoolEscrow} from "../src/PoolEscrow.sol";

/// Contract that can refuse ETH, to exercise the pull-payment fallback.
contract Rejecter {
    bool public accept;
    receive() external payable { require(accept, "no"); }
    function setAccept(bool a) external { accept = a; }
    function create(PoolEscrow e, address opp, bytes32 salt) external payable returns (bytes32) {
        return e.createMatch{value: msg.value}(opp, salt);
    }
    function withdraw(PoolEscrow e) external { e.withdraw(); }
}

contract PoolEscrowTest is Test {
    PoolEscrow escrow;
    uint256 signerKey = 0xA11CE;
    address signer;
    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("fee");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    uint256 constant STAKE = 0.01 ether;
    bytes32 constant SALT = keccak256("salt");

    function setUp() public {
        signer = vm.addr(signerKey);
        escrow = new PoolEscrow(owner, signer, feeRecipient, 0);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    function _create() internal returns (bytes32 id) {
        vm.prank(alice);
        id = escrow.createMatch{value: STAKE}(bob, SALT);
    }

    function _active() internal returns (bytes32 id) {
        id = _create();
        vm.prank(bob);
        escrow.joinMatch{value: STAKE}(id);
    }

    function _sign(bytes32 id, address winner) internal view returns (bytes memory) {
        return _signWith(signerKey, id, winner);
    }

    function _signWith(uint256 key, bytes32 id, address winner) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, escrow.resultDigest(id, winner));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ create / join

    function test_createAndJoin() public {
        bytes32 id = _create();
        assertEq(id, escrow.matchIdFor(alice, bob, SALT));
        assertEq(address(escrow).balance, STAKE);
        (, , , , , PoolEscrow.Status st) = escrow.matches(id);
        assertEq(uint8(st), uint8(PoolEscrow.Status.Open));

        vm.prank(bob);
        escrow.joinMatch{value: STAKE}(id);
        (, , , , , st) = escrow.matches(id);
        assertEq(uint8(st), uint8(PoolEscrow.Status.Active));
        assertEq(address(escrow).balance, 2 * STAKE);
    }

    function test_create_revertsOnZeroStake() public {
        vm.prank(alice);
        vm.expectRevert(PoolEscrow.InvalidStake.selector);
        escrow.createMatch{value: 0}(bob, SALT);
    }

    function test_create_revertsOnBadOpponent() public {
        vm.startPrank(alice);
        vm.expectRevert(PoolEscrow.InvalidOpponent.selector);
        escrow.createMatch{value: STAKE}(address(0), SALT);
        vm.expectRevert(PoolEscrow.InvalidOpponent.selector);
        escrow.createMatch{value: STAKE}(alice, SALT);
        vm.stopPrank();
    }

    function test_create_revertsOnDuplicate() public {
        _create();
        vm.prank(alice);
        vm.expectRevert(PoolEscrow.MatchExists.selector);
        escrow.createMatch{value: STAKE}(bob, SALT);
    }

    function test_idCannotBeSquatted() public {
        // Carol using the same salt gets a different id, so alice's create still works.
        vm.prank(carol);
        bytes32 other = escrow.createMatch{value: STAKE}(bob, SALT);
        bytes32 id = _create();
        assertTrue(other != id);
    }

    function test_join_revertsForWrongStake() public {
        bytes32 id = _create();
        vm.prank(bob);
        vm.expectRevert(PoolEscrow.StakeMismatch.selector);
        escrow.joinMatch{value: STAKE - 1}(id);
    }

    function test_join_revertsForNonOpponent() public {
        bytes32 id = _create();
        vm.prank(carol);
        vm.expectRevert(PoolEscrow.NotOpponent.selector);
        escrow.joinMatch{value: STAKE}(id);
    }

    function test_join_revertsWhenNotOpen() public {
        bytes32 id = _active();
        vm.prank(bob);
        vm.expectRevert(PoolEscrow.NotOpen.selector);
        escrow.joinMatch{value: STAKE}(id);
    }

    // ------------------------------------------------------------ cancel

    function test_cancel_refundsA() public {
        bytes32 id = _create();
        uint256 before_ = alice.balance;
        vm.prank(alice);
        escrow.cancel(id);
        assertEq(alice.balance, before_ + STAKE);
        assertEq(address(escrow).balance, 0);

        vm.prank(bob);
        vm.expectRevert(PoolEscrow.NotOpen.selector);
        escrow.joinMatch{value: STAKE}(id);
    }

    function test_cancel_onlyPlayerA() public {
        bytes32 id = _create();
        vm.prank(bob);
        vm.expectRevert(PoolEscrow.NotPlayerA.selector);
        escrow.cancel(id);
    }

    function test_cancel_revertsOnceActive() public {
        bytes32 id = _active();
        vm.prank(alice);
        vm.expectRevert(PoolEscrow.NotOpen.selector);
        escrow.cancel(id);
    }

    // ------------------------------------------------------------ settle

    function test_settle_paysWinnerFullPot() public {
        bytes32 id = _active();
        uint256 before_ = bob.balance;
        escrow.settle(id, bob, _sign(id, bob)); // anyone can relay
        assertEq(bob.balance, before_ + 2 * STAKE);
        assertEq(address(escrow).balance, 0);
    }

    function test_settle_rakeMath() public {
        vm.prank(owner);
        escrow.setFeeConfig(feeRecipient, 250); // 2.5%
        bytes32 id = _active();
        uint256 pot = 2 * STAKE;
        uint256 rake = (pot * 250) / 10_000;
        uint256 before_ = alice.balance;
        escrow.settle(id, alice, _sign(id, alice));
        assertEq(alice.balance, before_ + pot - rake);
        assertEq(feeRecipient.balance, rake);
        assertEq(address(escrow).balance, 0);
    }

    function test_settle_rakeFixedAtJoin() public {
        vm.prank(owner);
        escrow.setFeeConfig(feeRecipient, 100);
        bytes32 id = _active();
        vm.prank(owner);
        escrow.setFeeConfig(feeRecipient, 1000); // raised after the match started
        escrow.settle(id, alice, _sign(id, alice));
        assertEq(feeRecipient.balance, (2 * STAKE * 100) / 10_000);
    }

    function test_settle_rejectsBadSigner() public {
        bytes32 id = _active();
        bytes memory sig = _signWith(0xBAD, id, bob);
        vm.expectRevert(PoolEscrow.BadSignature.selector);
        escrow.settle(id, bob, sig);
    }

    function test_settle_signatureBoundToWinner() public {
        bytes32 id = _active();
        bytes memory sigForAlice = _sign(id, alice);
        vm.expectRevert(PoolEscrow.BadSignature.selector);
        escrow.settle(id, bob, sigForAlice);
    }

    function test_settle_signatureBoundToMatch() public {
        bytes32 id = _active();
        vm.prank(alice);
        bytes32 id2 = escrow.createMatch{value: STAKE}(bob, keccak256("other"));
        vm.prank(bob);
        escrow.joinMatch{value: STAKE}(id2);
        bytes memory sig2 = _sign(id2, alice);
        vm.expectRevert(PoolEscrow.BadSignature.selector);
        escrow.settle(id, alice, sig2);
    }

    function test_settle_rejectsOutsideWinner() public {
        bytes32 id = _active();
        bytes memory sig = _sign(id, carol);
        vm.expectRevert(PoolEscrow.InvalidWinner.selector);
        escrow.settle(id, carol, sig);
    }

    function test_settle_cannotReplay() public {
        bytes32 id = _active();
        bytes memory sig = _sign(id, bob);
        escrow.settle(id, bob, sig);
        vm.expectRevert(PoolEscrow.NotActive.selector);
        escrow.settle(id, bob, sig);
    }

    function test_settle_revertsIfNotActive() public {
        bytes32 id = _create();
        bytes memory sig = _sign(id, bob);
        vm.expectRevert(PoolEscrow.NotActive.selector);
        escrow.settle(id, bob, sig);
    }

    function test_settle_voidRefundsBoth() public {
        bytes32 id = _active();
        uint256 a = alice.balance;
        uint256 b = bob.balance;
        escrow.settle(id, address(0), _sign(id, address(0)));
        assertEq(alice.balance, a + STAKE);
        assertEq(bob.balance, b + STAKE);
        assertEq(address(escrow).balance, 0);
    }

    // ------------------------------------------------------------ refund timeout

    function test_refund_tooEarly() public {
        bytes32 id = _active();
        vm.warp(block.timestamp + escrow.MAX_MATCH_DURATION() - 1);
        vm.prank(alice);
        vm.expectRevert(PoolEscrow.TooEarly.selector);
        escrow.refund(id);
    }

    function test_refund_afterTimeout() public {
        bytes32 id = _active();
        vm.warp(block.timestamp + escrow.MAX_MATCH_DURATION());
        uint256 a = alice.balance;
        uint256 b = bob.balance;
        vm.prank(bob);
        escrow.refund(id);
        assertEq(alice.balance, a + STAKE);
        assertEq(bob.balance, b + STAKE);
        assertEq(address(escrow).balance, 0);
    }

    function test_refund_onlyPlayers() public {
        bytes32 id = _active();
        vm.warp(block.timestamp + escrow.MAX_MATCH_DURATION());
        vm.prank(carol);
        vm.expectRevert(PoolEscrow.NotPlayer.selector);
        escrow.refund(id);
    }

    function test_refund_blocksLaterSettle() public {
        bytes32 id = _active();
        bytes memory sig = _sign(id, alice);
        vm.warp(block.timestamp + escrow.MAX_MATCH_DURATION());
        vm.prank(alice);
        escrow.refund(id);
        vm.expectRevert(PoolEscrow.NotActive.selector);
        escrow.settle(id, alice, sig);
    }

    function test_settle_stillWorksAfterTimeoutIfNotRefunded() public {
        bytes32 id = _active();
        vm.warp(block.timestamp + 5 hours);
        escrow.settle(id, alice, _sign(id, alice));
    }

    // ------------------------------------------------------------ pull-payment fallback

    function test_rejectingWinnerDoesNotLoseFunds() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 1 ether);
        bytes32 id = r.create{value: STAKE}(escrow, bob, SALT);
        vm.prank(bob);
        escrow.joinMatch{value: STAKE}(id);

        escrow.settle(id, address(r), _sign(id, address(r)));
        assertEq(escrow.pending(address(r)), 2 * STAKE);

        vm.expectRevert(); // still rejects
        r.withdraw(escrow);

        r.setAccept(true);
        uint256 before_ = address(r).balance;
        r.withdraw(escrow);
        assertEq(address(r).balance, before_ + 2 * STAKE);
        assertEq(escrow.pending(address(r)), 0);
    }

    function test_rejectingPlayerCannotBlockOthersRefund() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 1 ether);
        bytes32 id = r.create{value: STAKE}(escrow, bob, SALT);
        vm.prank(bob);
        escrow.joinMatch{value: STAKE}(id);

        uint256 b = bob.balance;
        escrow.settle(id, address(0), _sign(id, address(0)));
        assertEq(bob.balance, b + STAKE);
        assertEq(escrow.pending(address(r)), STAKE);
    }

    function test_withdraw_revertsWhenNothingPending() public {
        vm.prank(alice);
        vm.expectRevert(PoolEscrow.NothingPending.selector);
        escrow.withdraw();
    }

    // ------------------------------------------------------------ admin

    function test_admin_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.setResultSigner(alice);
        vm.prank(alice);
        vm.expectRevert();
        escrow.setFeeConfig(alice, 0);
    }

    function test_admin_rakeCap() public {
        vm.prank(owner);
        vm.expectRevert(PoolEscrow.RakeTooHigh.selector);
        escrow.setFeeConfig(feeRecipient, 1001);
    }

    function test_admin_rotateSigner() public {
        bytes32 id = _active();
        uint256 newKey = 0xB0B;
        vm.prank(owner);
        escrow.setResultSigner(vm.addr(newKey));

        bytes memory oldSig = _sign(id, alice);
        vm.expectRevert(PoolEscrow.BadSignature.selector);
        escrow.settle(id, alice, oldSig);

        escrow.settle(id, alice, _signWith(newKey, id, alice));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(PoolEscrow.ZeroAddress.selector);
        new PoolEscrow(owner, address(0), feeRecipient, 0);
        vm.expectRevert(PoolEscrow.ZeroAddress.selector);
        new PoolEscrow(owner, signer, address(0), 0);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_settleConservesFunds(uint96 stake, uint16 bps, bool aWins) public {
        stake = uint96(bound(stake, 1, 100 ether));
        bps = uint16(bound(bps, 0, 1000));
        vm.prank(owner);
        escrow.setFeeConfig(feeRecipient, bps);
        vm.deal(alice, stake);
        vm.deal(bob, stake);
        vm.prank(alice);
        bytes32 id = escrow.createMatch{value: stake}(bob, SALT);
        vm.prank(bob);
        escrow.joinMatch{value: stake}(id);

        address w = aWins ? alice : bob;
        escrow.settle(id, w, _sign(id, w));
        assertEq(address(escrow).balance, 0);
        assertEq(w.balance + feeRecipient.balance, uint256(stake) * 2);
    }
}
