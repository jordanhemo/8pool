// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PoolEscrow} from "../src/PoolEscrow.sol";

/// forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
/// Env: DEPLOYER_ADDRESS (becomes owner), RESULT_SIGNER_ADDRESS, FEE_RECIPIENT (optional), RAKE_BPS (optional, default 0)
contract Deploy is Script {
    function run() external {
        // Not msg.sender: inside run() that is Foundry's default sender, not the broadcaster.
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address signer = vm.envAddress("RESULT_SIGNER_ADDRESS");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        uint16 rakeBps = uint16(vm.envOr("RAKE_BPS", uint256(0)));

        vm.startBroadcast();
        PoolEscrow escrow = new PoolEscrow(deployer, signer, feeRecipient, rakeBps);
        vm.stopBroadcast();

        console.log("PoolEscrow deployed at", address(escrow));
    }
}
