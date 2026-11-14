// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Drip} from "../src/Drip.sol";

contract Rejector {
    receive() external payable { revert("no"); }
}

contract DripTest is Test {
    Drip drip;
    address sponsor = makeAddr("sponsor");
    address alice = makeAddr("alice");

    function setUp() public {
        drip = new Drip{value: 1 ether}(sponsor);
        vm.deal(sponsor, drip.SPONSOR_FLOAT());
    }

    function test_DripsOnce() public {
        vm.prank(sponsor);
        drip.drip(alice);
        assertEq(alice.balance, drip.AMOUNT());
        assertTrue(drip.dripped(alice));
        vm.deal(alice, 0); // even after spending it all
        vm.prank(sponsor);
        vm.expectRevert(Drip.AlreadyFunded.selector);
        drip.drip(alice);
    }

    function test_OnlySponsor() public {
        vm.prank(alice);
        vm.expectRevert(Drip.NotSponsor.selector);
        drip.drip(alice);
    }

    function test_SkipsFundedAddresses() public {
        vm.deal(alice, 0.001 ether);
        vm.prank(sponsor);
        vm.expectRevert(Drip.AlreadyFunded.selector);
        drip.drip(alice);
    }

    function test_RefillsSponsorFloat() public {
        vm.deal(sponsor, 0.0001 ether);
        vm.prank(sponsor);
        drip.drip(alice);
        assertEq(sponsor.balance, drip.SPONSOR_FLOAT());
    }

    function test_RateLimitPerWindow() public {
        uint256 n = drip.PER_WINDOW();
        for (uint256 i = 0; i < n; i++) {
            vm.prank(sponsor);
            drip.drip(address(uint160(1000 + i)));
        }
        vm.prank(sponsor);
        vm.expectRevert(Drip.RateLimited.selector);
        drip.drip(address(uint160(5000)));
        vm.warp(block.timestamp + drip.WINDOW());
        vm.prank(sponsor);
        drip.drip(address(uint160(5000)));
        assertEq(address(uint160(5000)).balance, drip.AMOUNT());
    }

    function test_EmptyReverts() public {
        Drip poor = new Drip(sponsor);
        vm.prank(sponsor);
        vm.expectRevert(Drip.Empty.selector);
        poor.drip(alice);
    }

    function test_OwnerControls() public {
        address next = makeAddr("next");
        vm.prank(alice);
        vm.expectRevert(Drip.NotOwner.selector);
        drip.setSponsor(next);
        drip.setSponsor(next);
        assertEq(drip.sponsor(), next);
        vm.prank(sponsor);
        vm.expectRevert(Drip.NotSponsor.selector);
        drip.drip(alice);

        uint256 before = address(this).balance;
        drip.withdraw(0.5 ether);
        assertEq(address(this).balance, before + 0.5 ether);
        vm.prank(alice);
        vm.expectRevert(Drip.NotOwner.selector);
        drip.withdraw(1);
    }

    function test_FailedTransferReverts() public {
        Rejector r = new Rejector();
        vm.prank(sponsor);
        vm.expectRevert(Drip.TransferFailed.selector);
        drip.drip(address(r));
        assertFalse(drip.dripped(address(r)));
    }

    function testFuzz_NeverPaysTwice(address to) public {
        vm.assume(to != address(0) && to.code.length == 0 && to.balance == 0 && to != sponsor && uint160(to) > 0x100);
        vm.prank(sponsor);
        drip.drip(to);
        vm.deal(to, 0);
        vm.prank(sponsor);
        vm.expectRevert(Drip.AlreadyFunded.selector);
        drip.drip(to);
    }

    receive() external payable {}
}
