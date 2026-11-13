// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BrainVault} from "../src/BrainVault.sol";

contract BrainVaultTest is Test {
    BrainVault vault;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address app = makeAddr("app");
    bytes32 constant FP = keccak256("ciphertext-1");

    event SessionStored(address indexed owner, uint256 indexed sessionId, bytes32 fingerprint);
    event AccessGranted(address indexed owner, address indexed app);
    event AccessRevoked(address indexed owner, address indexed app);
    event ReadAllowed(address indexed owner, address indexed app, uint256 indexed sessionId);
    event ReadDenied(address indexed owner, address indexed app, uint256 indexed sessionId);

    function setUp() public {
        vault = new BrainVault();
        vm.prank(alice);
        vault.storeSession(FP);
    }

    function test_StoreSessionRecordsFingerprintAndTime() public {
        vm.warp(1_800_000_000);
        vm.expectEmit();
        emit SessionStored(alice, 1, keccak256("ciphertext-2"));
        vm.prank(alice);
        uint256 id = vault.storeSession(keccak256("ciphertext-2"));
        assertEq(id, 1);
        assertEq(vault.sessionCount(alice), 2);
        (bytes32 fp, uint64 at) = vault.session(alice, 1);
        assertEq(fp, keccak256("ciphertext-2"));
        assertEq(at, 1_800_000_000);
    }

    function test_StoreSessionRejectsZeroFingerprint() public {
        vm.expectRevert(BrainVault.ZeroFingerprint.selector);
        vault.storeSession(bytes32(0));
    }

    function test_SessionsAreSeparatePerOwner() public view {
        assertEq(vault.sessionCount(alice), 1);
        assertEq(vault.sessionCount(bob), 0);
    }

    function test_SessionRevertsForUnknownId() public {
        vm.expectRevert(BrainVault.NoSuchSession.selector);
        vault.session(alice, 1);
    }

    function test_ReadIsDeniedByDefaultAndLogged() public {
        vm.expectEmit();
        emit ReadDenied(alice, app, 0);
        vm.prank(app);
        assertFalse(vault.requestRead(alice, 0));
    }

    function test_GrantAllowsReadAndLogsIt() public {
        vm.expectEmit();
        emit AccessGranted(alice, app);
        vm.prank(alice);
        vault.grant(app);
        assertTrue(vault.canRead(alice, app));

        vm.expectEmit();
        emit ReadAllowed(alice, app, 0);
        vm.prank(app);
        assertTrue(vault.requestRead(alice, 0));
    }

    function test_RevokeStopsReads() public {
        vm.startPrank(alice);
        vault.grant(app);
        vm.expectEmit();
        emit AccessRevoked(alice, app);
        vault.revoke(app);
        vm.stopPrank();
        assertFalse(vault.canRead(alice, app));
        vm.prank(app);
        assertFalse(vault.requestRead(alice, 0));
    }

    function test_GrantRejectsZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(BrainVault.ZeroAddress.selector);
        vault.grant(address(0));
    }

    function test_GrantOnlyCoversTheGrantingOwner() public {
        vm.prank(bob);
        vault.storeSession(keccak256("bob-data"));
        vm.prank(alice);
        vault.grant(app);
        vm.prank(app);
        assertFalse(vault.requestRead(bob, 0));
    }

    function test_OnlyTheOwnerCanGrantAccessToTheirData() public {
        vm.prank(bob);
        vault.grant(app); // grants access to bob's data, not alice's
        assertFalse(vault.canRead(alice, app));
    }

    function test_OwnerCanAlwaysReadOwnSession() public {
        vm.prank(alice);
        assertTrue(vault.requestRead(alice, 0));
    }

    function test_RequestReadRevertsForUnknownSession() public {
        vm.prank(app);
        vm.expectRevert(BrainVault.NoSuchSession.selector);
        vault.requestRead(alice, 5);
    }

    function testFuzz_ReadMatchesPermission(address reader, bool granted) public {
        vm.assume(reader != address(0) && reader != alice);
        if (granted) {
            vm.prank(alice);
            vault.grant(reader);
        }
        vm.prank(reader);
        assertEq(vault.requestRead(alice, 0), granted);
    }
}
