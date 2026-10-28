// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PoolBank} from "../src/PoolBank.sol";

contract PoolBankTest is Test {
    PoolBank bank;
    uint256 signerKey = 0xA11CE;
    uint256 aliceKey = 0xA1;
    uint256 bobKey = 0xB0B;
    address signer;
    address operator = makeAddr("operator");
    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("fee");
    address alice;
    address bob;
    uint256 constant STAKE = 0.01 ether;
    bytes32 constant SALT = keccak256("salt");

    function setUp() public {
        signer = vm.addr(signerKey);
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        bank = new PoolBank(owner, operator, signer, feeRecipient, 0);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.warp(1_000_000);
    }

    // ------------------------------------------------------------ helpers

    function _fund(address who, uint256 amount) internal {
        vm.prank(who);
        bank.deposit{value: amount}();
    }

    function _auth(uint256 key, uint256 maxStake, uint256 expiry) internal view returns (PoolBank.Auth memory) {
        address who = vm.addr(key);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, bank.playDigest(who, maxStake, expiry, bank.authNonce(who)));
        return PoolBank.Auth(maxStake, expiry, abi.encodePacked(r, s, v));
    }

    function _good(uint256 key) internal view returns (PoolBank.Auth memory) {
        return _auth(key, 1 ether, block.timestamp + 1 days);
    }

    function _start() internal returns (bytes32 id) {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        id = bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function _sign(bytes32 id, address winner) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, bank.resultDigest(id, winner));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ bankroll

    function test_depositWithdraw() public {
        _fund(alice, 1 ether);
        assertEq(bank.balanceOf(alice), 1 ether);
        vm.prank(alice);
        bank.withdraw(0.4 ether);
        assertEq(bank.balanceOf(alice), 0.6 ether);
        assertEq(alice.balance, 10 ether - 1 ether + 0.4 ether);
    }

    function test_receiveCredits() public {
        vm.prank(alice);
        (bool ok,) = address(bank).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(bank.balanceOf(alice), 1 ether);
    }

    function test_withdrawMoreThanBalanceReverts() public {
        _fund(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(PoolBank.InsufficientBalance.selector);
        bank.withdraw(1 ether + 1);
    }

    function test_zeroDepositReverts() public {
        vm.prank(alice);
        vm.expectRevert(PoolBank.InvalidStake.selector);
        bank.deposit();
    }

    // ------------------------------------------------------------ startMatch

    function test_startLocksStakes() public {
        bytes32 id = _start();
        assertEq(bank.balanceOf(alice), 1 ether - STAKE);
        assertEq(bank.balanceOf(bob), 1 ether - STAKE);
        assertEq(bank.activeMatch(alice), id);
        assertEq(bank.activeMatch(bob), id);
        assertEq(address(bank).balance, 2 ether);
    }

    function test_lockedStakeCannotBeWithdrawn() public {
        _fund(alice, STAKE);
        _fund(bob, STAKE);
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
        vm.prank(alice);
        vm.expectRevert(PoolBank.InsufficientBalance.selector);
        bank.withdraw(1);
    }

    function test_onlyOperatorStarts() public {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(alice);
        vm.expectRevert(PoolBank.NotOperator.selector);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function test_insufficientBalanceReverts() public {
        _fund(alice, 1 ether);
        _fund(bob, STAKE - 1);
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        vm.expectRevert(PoolBank.InsufficientBalance.selector);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function test_stakeAboveMaxReverts() public {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        PoolBank.Auth memory a = _auth(aliceKey, STAKE - 1, block.timestamp + 1 days);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        vm.expectRevert(PoolBank.BadAuthorization.selector);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function test_expiredAuthReverts() public {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        PoolBank.Auth memory a = _auth(aliceKey, 1 ether, block.timestamp + 1 hours);
        PoolBank.Auth memory b = _good(bobKey);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        vm.expectRevert(PoolBank.BadAuthorization.selector);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function test_signedByWrongKeyReverts() public {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        // Bob's key signs Alice's authorization.
        PoolBank.Auth memory forged = _auth(bobKey, 1 ether, block.timestamp + 1 days);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        vm.expectRevert(PoolBank.BadAuthorization.selector);
        bank.startMatch(alice, bob, STAKE, SALT, forged, b);
    }

    function test_tamperedMaxStakeReverts() public {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        PoolBank.Auth memory a = _auth(aliceKey, STAKE, block.timestamp + 1 days);
        a.maxStake = 100 ether; // operator tries to widen it
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        vm.expectRevert(PoolBank.BadAuthorization.selector);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function test_revokeInvalidatesAuth() public {
        _fund(alice, 1 ether);
        _fund(bob, 1 ether);
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(alice);
        bank.revokeAuthorizations();
        vm.prank(operator);
        vm.expectRevert(PoolBank.BadAuthorization.selector);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
        // A fresh signature after the revoke works (bob's old one was signed at the same nonce).
        a = _good(aliceKey);
        vm.prank(operator);
        bank.startMatch(alice, bob, STAKE, SALT, a, b);
    }

    function test_cannotPlayTwiceAtOnce() public {
        _start();
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        vm.expectRevert(PoolBank.AlreadyPlaying.selector);
        bank.startMatch(alice, bob, STAKE, keccak256("other"), a, b);
    }

    function test_selfMatchReverts() public {
        _fund(alice, 1 ether);
        PoolBank.Auth memory a = _good(aliceKey);
        vm.prank(operator);
        vm.expectRevert(PoolBank.InvalidOpponent.selector);
        bank.startMatch(alice, alice, STAKE, SALT, a, a);
    }

    // ------------------------------------------------------------ settle

    function test_winnerCreditedNoClaimNeeded() public {
        bytes32 id = _start();
        bank.settle(id, alice, _sign(id, alice)); // anyone may submit
        assertEq(bank.balanceOf(alice), 1 ether - STAKE + 2 * STAKE);
        assertEq(bank.balanceOf(bob), 1 ether - STAKE);
        assertEq(bank.activeMatch(alice), 0);
        assertEq(bank.activeMatch(bob), 0);
        assertEq(address(bank).balance, 2 ether);
    }

    function test_voidReturnsBothStakes() public {
        bytes32 id = _start();
        bank.settle(id, address(0), _sign(id, address(0)));
        assertEq(bank.balanceOf(alice), 1 ether);
        assertEq(bank.balanceOf(bob), 1 ether);
    }

    function test_rakeCreditedToFeeRecipient() public {
        vm.prank(owner);
        bank.setFeeConfig(feeRecipient, 500); // 5%
        bytes32 id = _start();
        bank.settle(id, bob, _sign(id, bob));
        assertEq(bank.balanceOf(feeRecipient), (2 * STAKE * 500) / 10_000);
        assertEq(bank.balanceOf(bob), 1 ether - STAKE + 2 * STAKE - (2 * STAKE * 500) / 10_000);
    }

    function test_rakeFixedAtStart() public {
        vm.prank(owner);
        bank.setFeeConfig(feeRecipient, 100);
        bytes32 id = _start();
        vm.prank(owner);
        bank.setFeeConfig(feeRecipient, 1000);
        bank.settle(id, alice, _sign(id, alice));
        assertEq(bank.balanceOf(feeRecipient), (2 * STAKE * 100) / 10_000);
    }

    function test_cannotSettleTwice() public {
        bytes32 id = _start();
        bytes memory sig = _sign(id, alice);
        bank.settle(id, alice, sig);
        vm.expectRevert(PoolBank.NotActive.selector);
        bank.settle(id, alice, sig);
    }

    function test_badSignatureReverts() public {
        bytes32 id = _start();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, bank.resultDigest(id, alice));
        vm.expectRevert(PoolBank.BadSignature.selector);
        bank.settle(id, alice, abi.encodePacked(r, s, v));
    }

    function test_signatureForOtherWinnerReverts() public {
        bytes32 id = _start();
        bytes memory sig = _sign(id, alice);
        vm.expectRevert(PoolBank.BadSignature.selector);
        bank.settle(id, bob, sig);
    }

    function test_nonPlayerWinnerReverts() public {
        bytes32 id = _start();
        address mallory = makeAddr("mallory");
        bytes memory sig = _sign(id, mallory);
        vm.expectRevert(PoolBank.InvalidWinner.selector);
        bank.settle(id, mallory, sig);
    }

    function test_canPlayAgainAfterSettle() public {
        bytes32 id = _start();
        bank.settle(id, alice, _sign(id, alice));
        PoolBank.Auth memory a = _good(aliceKey);
        PoolBank.Auth memory b = _good(bobKey);
        vm.prank(operator);
        bank.startMatch(alice, bob, STAKE, keccak256("round2"), a, b);
    }

    // ------------------------------------------------------------ refund

    function test_refundTooEarlyReverts() public {
        bytes32 id = _start();
        vm.warp(block.timestamp + 1 hours - 1);
        vm.prank(alice);
        vm.expectRevert(PoolBank.TooEarly.selector);
        bank.refund(id);
    }

    function test_refundAfterTimeoutUnlocksBoth() public {
        bytes32 id = _start();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        bank.refund(id);
        assertEq(bank.balanceOf(alice), 1 ether);
        assertEq(bank.balanceOf(bob), 1 ether);
        assertEq(bank.activeMatch(alice), 0);
        bytes memory sig = _sign(id, alice);
        vm.expectRevert(PoolBank.NotActive.selector);
        bank.settle(id, alice, sig);
    }

    function test_refundByStrangerReverts() public {
        bytes32 id = _start();
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(PoolBank.NotPlayer.selector);
        bank.refund(id);
    }

    // ------------------------------------------------------------ admin

    function test_onlyOwnerAdmin() public {
        vm.expectRevert();
        bank.setOperator(alice);
        vm.prank(owner);
        bank.setOperator(alice);
        assertEq(bank.operator(), alice);
        vm.prank(owner);
        vm.expectRevert(PoolBank.RakeTooHigh.selector);
        bank.setFeeConfig(feeRecipient, 1001);
    }

    // ------------------------------------------------------------ accounting fuzz

    /// The contract's ETH always equals unlocked balances plus locked stakes.
    function testFuzz_accountingConserved(uint96 depA, uint96 depB, uint96 stake, uint8 outcome) public {
        depA = uint96(bound(depA, 1, 100 ether));
        depB = uint96(bound(depB, 1, 100 ether));
        stake = uint96(bound(stake, 1, 100 ether));
        vm.deal(alice, depA);
        vm.deal(bob, depB);
        _fund(alice, depA);
        _fund(bob, depB);
        if (stake > depA || stake > depB) return;

        PoolBank.Auth memory a = _auth(aliceKey, stake, block.timestamp + 1 days);
        PoolBank.Auth memory b = _auth(bobKey, stake, block.timestamp + 1 days);
        vm.prank(operator);
        bytes32 id = bank.startMatch(alice, bob, stake, SALT, a, b);
        assertEq(address(bank).balance, uint256(depA) + depB);

        address winner = outcome % 3 == 0 ? alice : outcome % 3 == 1 ? bob : address(0);
        bank.settle(id, winner, _sign(id, winner));

        assertEq(bank.balanceOf(alice) + bank.balanceOf(bob) + bank.balanceOf(feeRecipient), address(bank).balance);
    }
}
