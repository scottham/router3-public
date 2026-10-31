// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {WalletPrepaidPool} from "../src/WalletPrepaidPool.sol";

contract PoolTestUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// A contract wallet that accepts signatures from one owner key (ERC-1271).
contract TestSmartWallet is IERC1271 {
    address immutable owner;
    constructor(address key) { owner = key; }
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
        return ecrecover(hash, v, r, s) == owner ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

contract WalletPrepaidPoolTest is Test {
    PoolTestUSDC token;
    WalletPrepaidPool pool;
    uint256 payerKey = 0xA11CE;
    address payer;
    address treasury = makeAddr("treasury");
    address settler = makeAddr("settler");
    uint256 constant DELAY = 30 minutes;
    uint256 nextKey = 1;

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(payerKey);
        token = new PoolTestUSDC();
        // max debit 1000, refill ceiling 1000, default target 2, default daily limit 20 USDC.
        pool = new WalletPrepaidPool(token, treasury, address(this), settler, 1000e6, 1000e6, 2e6, 20e6, DELAY);
        token.mint(payer, 100e6);
        vm.prank(payer); token.approve(address(pool), 50e6);
    }

    function key() internal returns (bytes32) { return keccak256(abi.encode(nextKey++)); }

    function settle(uint256 debit, uint256 refill) internal returns (bytes32 batchKey) {
        batchKey = key();
        vm.prank(settler); pool.settle(batchKey, payer, key(), debit, refill, keccak256("usage"));
    }

    function account() internal view returns (uint256 balance, uint256 withdrawal, uint256 at, uint256 target, uint256 limit, uint256 remaining) {
        return pool.accountOf(payer);
    }

    function sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", pool.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function testRefillMovesWalletFundsIntoTheUsersOwnPoolUpToTarget() public {
        settle(0, 5e6);
        (uint256 balance,,, uint256 target,,) = account();
        assertEq(target, 2e6);
        assertEq(balance, 2e6, "refill is capped by the target");
        assertEq(token.balanceOf(payer), 98e6);
        assertEq(token.balanceOf(address(pool)), 2e6);
        assertEq(pool.totalPooled(), 2e6);
    }

    function testDebitAccruesForTreasuryWithoutATokenTransferUntilSweep() public {
        settle(0, 2e6);
        settle(1e6, 0);
        (uint256 balance,,,,, uint256 remaining) = account();
        assertEq(balance, 1e6);
        assertEq(remaining, 19e6);
        assertEq(pool.treasuryAccrued(), 1e6);
        assertEq(token.balanceOf(treasury), 0);
        vm.prank(makeAddr("anyone")); assertEq(pool.sweep(), 1e6);
        assertEq(token.balanceOf(treasury), 1e6);
        assertEq(pool.treasuryAccrued(), 0);
        assertEq(pool.sweep(), 0);
    }

    function testDebitAndRefillInOneSettlement() public {
        settle(0, 2e6);
        settle(1.5e6, 2e6);
        (uint256 balance,,,,,) = account();
        assertEq(balance, 2e6, "refilled back to target after the debit");
        assertEq(pool.treasuryAccrued(), 1.5e6);
        assertEq(token.balanceOf(payer), 96.5e6);
    }

    function testRevokedAllowanceSkipsRefillButStillDebits() public {
        settle(0, 2e6);
        vm.prank(payer); token.approve(address(pool), 0);
        bytes32 batchKey = key();
        vm.expectEmit(true, true, false, true); emit WalletPrepaidPool.RefillSkipped(batchKey, payer, 2e6);
        vm.prank(settler); pool.settle(batchKey, payer, key(), 1e6, 2e6, bytes32(0));
        (uint256 balance,,,,,) = account();
        assertEq(balance, 1e6);
        assertEq(pool.treasuryAccrued(), 1e6);
    }

    function testDebitCannotExceedPoolOrDailyLimitOrMaxDebit() public {
        settle(0, 2e6);
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.InsufficientPool.selector);
        pool.settle(key(), payer, key(), 3e6, 0, bytes32(0));
        vm.prank(payer); pool.configure(1000e6, 3e6);
        vm.warp(block.timestamp + DELAY); // a lower limit applies after the delay
        settle(0, 40e6);
        settle(3e6, 0);
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.DailyLimitExceeded.selector);
        pool.settle(key(), payer, key(), 1, 0, bytes32(0));
        vm.warp(block.timestamp + 1 days);
        settle(3e6, 0);
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.InvalidSettlement.selector);
        pool.settle(key(), payer, key(), 1001e6, 0, bytes32(0));
    }

    function testBatchAndClaimCannotBeReplayed() public {
        settle(0, 2e6);
        bytes32 batchKey = key(); bytes32 claim = key();
        vm.prank(settler); pool.settle(batchKey, payer, claim, 1e5, 0, bytes32(0));
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.DuplicateBatch.selector);
        pool.settle(batchKey, payer, key(), 1e5, 0, bytes32(0));
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.DuplicateClaim.selector);
        pool.settle(key(), payer, claim, 1e5, 0, bytes32(0));
    }

    function testOnlySettlerSettlesAndPauseStopsSettlementButNotExit() public {
        vm.expectRevert(); pool.settle(key(), payer, key(), 0, 1e6, bytes32(0));
        settle(0, 2e6);
        pool.setSettlementsPaused(true);
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.SettlementPaused.selector);
        pool.settle(key(), payer, key(), 1e6, 0, bytes32(0));
        vm.prank(payer); pool.requestWithdrawal(type(uint128).max);
        vm.warp(block.timestamp + DELAY);
        pool.withdraw(payer);
        assertEq(token.balanceOf(payer), 100e6);
    }

    function testWithdrawalWaitsForTheDelayAndUsageCanStillSettleMeanwhile() public {
        settle(0, 2e6);
        vm.prank(payer); pool.requestWithdrawal(2e6);
        (, uint256 withdrawal, uint256 at,,,) = account();
        assertEq(withdrawal, 2e6);
        assertEq(at, block.timestamp + DELAY);
        vm.expectRevert(WalletPrepaidPool.WithdrawalNotReady.selector); pool.withdraw(payer);
        // Usage accepted before the request still settles during the delay.
        settle(0.5e6, 2e6);
        (uint256 balance,,,,,) = account();
        assertEq(balance, 1.5e6, "no refill while a withdrawal is pending");
        vm.warp(block.timestamp + DELAY);
        // Anyone may execute it, but the funds only go to the owner.
        vm.prank(makeAddr("relayer")); assertEq(pool.withdraw(payer), 1.5e6);
        assertEq(token.balanceOf(payer), 99.5e6);
        (balance, withdrawal, at,,,) = account();
        assertEq(balance + withdrawal + at, 0);
        assertEq(token.balanceOf(address(pool)), pool.treasuryAccrued());
        // A completed withdrawal turns refills off until the user turns them back on.
        (,,, uint256 target, uint256 limit,) = account();
        assertEq(target, 0);
        assertEq(limit, 20e6, "the daily limit is kept");
        bytes32 batchKey = key();
        vm.expectEmit(true, true, false, true); emit WalletPrepaidPool.RefillSkipped(batchKey, payer, 2e6);
        vm.prank(settler); pool.settle(batchKey, payer, bytes32(0), 0, 2e6, bytes32(0));
        vm.prank(payer); pool.configure(2e6, 20e6);
        settle(0, 2e6);
        (balance,,,,,) = account();
        assertEq(balance, 2e6);
    }

    function testRerequestingRestartsTheDelayAndCancelStopsIt() public {
        settle(0, 2e6);
        vm.prank(payer); pool.requestWithdrawal(1e6);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(payer); pool.requestWithdrawal(2e6);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(WalletPrepaidPool.WithdrawalNotReady.selector); pool.withdraw(payer);
        vm.prank(payer); pool.cancelWithdrawal();
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(WalletPrepaidPool.NoWithdrawal.selector); pool.withdraw(payer);
        settle(1e6, 2e6);
        (uint256 balance,,,,,) = account();
        assertEq(balance, 2e6, "refills resume after cancelling");
    }

    function testLoweringTheDailyLimitWaitsButRaisingIsImmediate() public {
        settle(0, 2e6);
        vm.prank(payer); pool.configure(2e6, 1e6);
        (,,,, uint256 limit, uint256 remaining) = account();
        assertEq(limit, 20e6, "the old limit stays in force");
        assertEq(remaining, 1e6, "but what may be accepted now already respects the lower one");
        settle(1.5e6, 0);
        vm.warp(block.timestamp + DELAY);
        (,,,, limit,) = account();
        assertEq(limit, 1e6);
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.DailyLimitExceeded.selector);
        pool.settle(key(), payer, key(), 1, 0, bytes32(0));
        vm.prank(payer); pool.configure(2e6, 5e6);
        (,,,, limit,) = account();
        assertEq(limit, 5e6);
        settle(0.5e6, 0);
    }

    function testRefillTargetIsBoundedByTheCeiling() public {
        vm.prank(payer); vm.expectRevert(WalletPrepaidPool.InvalidAmount.selector); pool.configure(1001e6, 1e6);
        vm.prank(payer); vm.expectRevert(WalletPrepaidPool.InvalidAmount.selector); pool.configure(1e6, 0);
        vm.prank(payer); pool.configure(0, 1e6);
        bytes32 batchKey = key();
        vm.expectEmit(true, true, false, true); emit WalletPrepaidPool.RefillSkipped(batchKey, payer, 1e6);
        vm.prank(settler); pool.settle(batchKey, payer, bytes32(0), 0, 1e6, bytes32(0));
    }

    function testSignedRequestsAreRelayedOnceAndBoundToTheOwner() public {
        settle(0, 2e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = sign(payerKey, keccak256(abi.encode(pool.REQUEST_WITHDRAWAL_TYPEHASH(), payer, 2e6, 0, deadline)));
        vm.prank(settler); pool.requestWithdrawalBySig(payer, 2e6, 0, deadline, sig);
        (, uint256 withdrawal,,,,) = account();
        assertEq(withdrawal, 2e6);
        vm.expectRevert(); pool.requestWithdrawalBySig(payer, 2e6, 0, deadline, sig);
        bytes memory cancel = sign(payerKey, keccak256(abi.encode(pool.CANCEL_WITHDRAWAL_TYPEHASH(), payer, 1, deadline)));
        bytes memory forged = sign(0xBAD, keccak256(abi.encode(pool.CANCEL_WITHDRAWAL_TYPEHASH(), payer, 1, deadline)));
        vm.expectRevert(WalletPrepaidPool.InvalidSignature.selector); pool.cancelWithdrawalBySig(payer, 1, deadline, forged);
        pool.cancelWithdrawalBySig(payer, 1, deadline, cancel);
        bytes memory config = sign(payerKey, keccak256(abi.encode(pool.CONFIGURE_TYPEHASH(), payer, 5e6, 7e6, 2, deadline)));
        vm.warp(deadline + 1);
        vm.expectRevert(WalletPrepaidPool.SignatureExpired.selector); pool.configureBySig(payer, 5e6, 7e6, 2, deadline, config);
    }

    function testContractWalletsSignThroughERC1271() public {
        TestSmartWallet wallet = new TestSmartWallet(vm.addr(payerKey));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", pool.domainSeparator(),
            keccak256(abi.encode(pool.CONFIGURE_TYPEHASH(), address(wallet), 3e6, 4e6, 0, deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        pool.configureBySig(address(wallet), 3e6, 4e6, 0, deadline, abi.encode(v, r, s));
        (,,, uint256 target, uint256 limit, uint256 remaining) = pool.accountOf(address(wallet));
        assertEq(target, 3e6);
        assertEq(limit, 20e6, "a lower limit waits for the delay");
        assertEq(remaining, 4e6);
    }

    // 2026-10-20: the Treasury granted the pool an allowance and the platform
    // queued a refill-only batch. The pool must refuse it, so the settler can
    // never pull revenue back into a pool, whatever the Treasury approved.
    function testTreasuryAllowanceNeverFundsAPool() public {
        token.mint(treasury, 10e6);
        vm.prank(treasury); token.approve(address(pool), 10e6);
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.InvalidSettlement.selector);
        pool.settle(key(), treasury, bytes32(0), 0, 2e6, bytes32(0));
        assertEq(token.balanceOf(treasury), 10e6);
        assertEq(token.balanceOf(address(pool)), 0);
    }

    function testUserDepositAndInvalidInputs() public {
        vm.prank(payer); pool.deposit(5e6);
        (uint256 balance,,,,,) = account();
        assertEq(balance, 5e6, "a direct deposit may exceed the refill target");
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.InvalidSettlement.selector);
        pool.settle(key(), payer, key(), 0, 0, bytes32(0));
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.InvalidSettlement.selector);
        pool.settle(key(), payer, bytes32(0), 1, 0, bytes32(0));
        vm.prank(settler); vm.expectRevert(WalletPrepaidPool.InvalidSettlement.selector);
        pool.settle(key(), treasury, key(), 1, 0, bytes32(0));
        vm.expectRevert(WalletPrepaidPool.InvalidConfiguration.selector);
        new WalletPrepaidPool(token, treasury, address(this), settler, 1, 1, 1, 1, 5 minutes);
    }

    /// Funds held always cover every pool balance plus the Treasury accrual.
    function testFuzzSolvency(uint96[8] memory amounts, uint8 ops) public {
        vm.prank(payer); pool.configure(1000e6, 1000e6);
        token.mint(payer, 10_000e6);
        vm.prank(payer); token.approve(address(pool), type(uint256).max);
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = uint256(amounts[i]) % 600e6 + 1;
            uint8 op = uint8(ops >> (i % 8)) & 3;
            (uint256 balance, uint256 withdrawal,,,, uint256 remaining) = account();
            if (op == 0) settle(0, amount);
            else if (op == 1 && amount <= balance && amount <= remaining) settle(amount, 0);
            else if (op == 2 && withdrawal == 0) { vm.prank(payer); pool.requestWithdrawal(amount); }
            else if (withdrawal != 0) { vm.warp(block.timestamp + DELAY); pool.withdraw(payer); }
            if (i % 3 == 2) pool.sweep();
            assertGe(token.balanceOf(address(pool)), pool.totalPooled() + pool.treasuryAccrued());
            (balance,,,,,) = account();
            assertEq(balance, pool.totalPooled());
        }
    }
}
