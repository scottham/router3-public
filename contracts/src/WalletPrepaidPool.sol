// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @notice Per-user prepaid USDC pools for metered API usage.
/// @dev Each user's pool is theirs: only they can withdraw it, after a delay
/// long enough for usage they already started to be settled. The settler can
/// only (a) move a user's pool balance to the Treasury accrual, within the
/// user's daily limit, against a unique claim, and (b) top the pool up from the
/// user's wallet allowance, never above the user's refill target. Metering is
/// trusted off-chain; the daily limit bounds what a compromised settler can take.
/// There is no admin withdrawal and no upgrade path.
contract WalletPrepaidPool is AccessControl, ReentrancyGuard, EIP712, Nonces {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant CONFIGURE_TYPEHASH =
        keccak256("Configure(address owner,uint256 refillTarget,uint256 dailyLimit,uint256 nonce,uint256 deadline)");
    bytes32 public constant REQUEST_WITHDRAWAL_TYPEHASH =
        keccak256("RequestWithdrawal(address owner,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 public constant CANCEL_WITHDRAWAL_TYPEHASH =
        keccak256("CancelWithdrawal(address owner,uint256 nonce,uint256 deadline)");

    IERC20 public immutable usdc;
    address public immutable treasury;
    /// Largest single debit.
    uint256 public immutable maxDebit;
    /// Highest refill target a user may choose.
    uint256 public immutable maxRefillTarget;
    /// Used until a user configures their own values.
    uint256 public immutable defaultRefillTarget;
    uint256 public immutable defaultDailyLimit;
    /// Delay before a withdrawal, or a lower daily limit, takes effect.
    uint256 public immutable withdrawalDelay;

    bool public settlementsPaused;
    /// Debited usage owed to the Treasury, sent by `sweep`.
    uint256 public treasuryAccrued;
    /// Sum of all pool balances. Solvency: USDC held >= totalPooled + treasuryAccrued.
    uint256 public totalPooled;

    struct Account {
        uint128 balance;
        uint128 withdrawalAmount;
        uint64 withdrawableAt;
        uint64 day;
        uint128 spentToday;
        uint128 refillTarget;
        uint128 dailyLimit;
        uint128 pendingDailyLimit;
        uint64 dailyLimitEffectiveAt;
        bool configured;
    }

    mapping(address => Account) private _accounts;
    mapping(bytes32 => bool) public processedBatches;
    mapping(bytes32 => bool) public processedClaims;

    error InvalidConfiguration();
    error InvalidSettlement();
    error DuplicateBatch();
    error DuplicateClaim();
    error SettlementPaused();
    error InsufficientPool();
    error DailyLimitExceeded();
    error InvalidAmount();
    error InvalidSignature();
    error SignatureExpired();
    error NoWithdrawal();
    error WithdrawalNotReady();
    error UnsupportedToken();

    event Configured(address indexed owner, uint256 refillTarget, uint256 dailyLimit, uint256 dailyLimitEffectiveAt);
    event Deposited(address indexed owner, uint256 amount);
    event Debited(bytes32 indexed batchKey, bytes32 indexed claimKey, address indexed payer, uint256 amount, bytes32 usageRoot);
    event Refilled(bytes32 indexed batchKey, address indexed payer, uint256 amount);
    event RefillSkipped(bytes32 indexed batchKey, address indexed payer, uint256 requested);
    event WithdrawalRequested(address indexed owner, uint256 amount, uint256 withdrawableAt);
    event WithdrawalCancelled(address indexed owner);
    event Withdrawn(address indexed owner, uint256 amount);
    event Swept(uint256 amount);
    event SettlementPauseUpdated(bool paused);

    constructor(
        IERC20 token,
        address recipient,
        address admin,
        address settler,
        uint256 debitLimit,
        uint256 refillCeiling,
        uint256 refillTarget,
        uint256 dailyLimit,
        uint256 delay
    ) EIP712("Router3 Prepaid Pool", "1") {
        if (address(token) == address(0) || address(token).code.length == 0 || recipient == address(0)
            || recipient == address(this) || admin == address(0) || settler == address(0) || debitLimit == 0
            || refillCeiling == 0 || refillCeiling > type(uint128).max || refillTarget > refillCeiling
            || dailyLimit == 0 || dailyLimit > type(uint128).max || delay < 10 minutes || delay > 7 days) {
            revert InvalidConfiguration();
        }
        usdc = token;
        treasury = recipient;
        maxDebit = debitLimit;
        maxRefillTarget = refillCeiling;
        defaultRefillTarget = refillTarget;
        defaultDailyLimit = dailyLimit;
        withdrawalDelay = delay;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTLER_ROLE, settler);
    }

    // ------------------------------------------------------------------ views

    /// @return balance Pool balance, including any amount requested for withdrawal.
    /// @return withdrawalAmount Requested withdrawal (0 when none).
    /// @return withdrawableAt When the requested withdrawal may be executed.
    /// @return refillTarget Highest balance a refill may bring the pool to.
    /// @return dailyLimit The daily debit limit in force now.
    /// @return dailyRemaining What may still be debited today, also counting a
    /// pending lower limit, since usage accepted now may settle after it applies.
    function accountOf(address owner) external view returns (
        uint256 balance, uint256 withdrawalAmount, uint256 withdrawableAt,
        uint256 refillTarget, uint256 dailyLimit, uint256 dailyRemaining
    ) {
        Account storage a = _accounts[owner];
        uint256 limit = _limitNow(a);
        uint256 spent = a.day == _today() ? a.spentToday : 0;
        uint256 bound = a.dailyLimitEffectiveAt != 0 && a.pendingDailyLimit < limit ? a.pendingDailyLimit : limit;
        return (a.balance, a.withdrawalAmount, a.withdrawableAt, _target(a), limit, bound > spent ? bound - spent : 0);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------ user actions

    function configure(uint256 refillTarget, uint256 dailyLimit) external {
        _configure(msg.sender, refillTarget, dailyLimit);
    }

    function configureBySig(address owner, uint256 refillTarget, uint256 dailyLimit, uint256 nonce, uint256 deadline,
        bytes calldata signature) external
    {
        _verify(owner, keccak256(abi.encode(CONFIGURE_TYPEHASH, owner, refillTarget, dailyLimit, nonce, deadline)),
            nonce, deadline, signature);
        _configure(owner, refillTarget, dailyLimit);
    }

    /// Funds the caller's own pool directly, without the allowance-based refill.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        _pull(msg.sender, amount);
        Account storage a = _accounts[msg.sender];
        a.balance += uint128(amount);
        totalPooled += amount;
        emit Deposited(msg.sender, amount);
    }

    function requestWithdrawal(uint256 amount) external {
        _requestWithdrawal(msg.sender, amount);
    }

    function requestWithdrawalBySig(address owner, uint256 amount, uint256 nonce, uint256 deadline,
        bytes calldata signature) external
    {
        _verify(owner, keccak256(abi.encode(REQUEST_WITHDRAWAL_TYPEHASH, owner, amount, nonce, deadline)),
            nonce, deadline, signature);
        _requestWithdrawal(owner, amount);
    }

    function cancelWithdrawal() external {
        _cancelWithdrawal(msg.sender);
    }

    function cancelWithdrawalBySig(address owner, uint256 nonce, uint256 deadline, bytes calldata signature) external {
        _verify(owner, keccak256(abi.encode(CANCEL_WITHDRAWAL_TYPEHASH, owner, nonce, deadline)), nonce, deadline, signature);
        _cancelWithdrawal(owner);
    }

    /// Executes a matured withdrawal. Anyone may call it; funds only go to the owner.
    /// Pays out the requested amount, or the whole balance if usage settled during
    /// the delay left less than that. Automatic refills stop with it: the user
    /// withdrew on purpose, and only they can turn refills back on (`configure`).
    function withdraw(address owner) external nonReentrant returns (uint256 amount) {
        Account storage a = _accounts[owner];
        if (a.withdrawalAmount == 0) revert NoWithdrawal();
        if (block.timestamp < a.withdrawableAt) revert WithdrawalNotReady();
        amount = a.withdrawalAmount < a.balance ? a.withdrawalAmount : a.balance;
        a.withdrawalAmount = 0;
        a.withdrawableAt = 0;
        if (!a.configured) {
            a.dailyLimit = uint128(defaultDailyLimit);
            a.configured = true;
        }
        a.refillTarget = 0;
        a.balance -= uint128(amount);
        totalPooled -= amount;
        if (amount > 0) usdc.safeTransfer(owner, amount);
        emit Withdrawn(owner, amount);
        emit Configured(owner, 0, _limitNow(a), block.timestamp);
    }

    // ----------------------------------------------------------- settlement

    /// Debits settled usage into the Treasury accrual and/or refills the pool from
    /// the payer's allowance. A refill that cannot happen (withdrawal pending, pool
    /// already at target, or the token pull fails) is skipped, never reverting the debit.
    function settle(bytes32 batchKey, address payer, bytes32 claimKey, uint256 debit, uint256 refill, bytes32 usageRoot)
        external nonReentrant onlyRole(SETTLER_ROLE)
    {
        if (settlementsPaused) revert SettlementPaused();
        if (batchKey == bytes32(0) || payer == address(0) || payer == treasury || payer == address(this)
            || (debit == 0 && refill == 0) || debit > maxDebit || refill > type(uint128).max) revert InvalidSettlement();
        if (processedBatches[batchKey]) revert DuplicateBatch();
        processedBatches[batchKey] = true;
        Account storage a = _accounts[payer];
        if (debit > 0) {
            if (claimKey == bytes32(0)) revert InvalidSettlement();
            if (processedClaims[claimKey]) revert DuplicateClaim();
            processedClaims[claimKey] = true;
            _rollDay(a);
            if (uint256(a.spentToday) + debit > _limitNow(a)) revert DailyLimitExceeded();
            if (debit > a.balance) revert InsufficientPool();
            a.balance -= uint128(debit);
            a.spentToday += uint128(debit);
            totalPooled -= debit;
            treasuryAccrued += debit;
            emit Debited(batchKey, claimKey, payer, debit, usageRoot);
        }
        if (refill > 0) {
            uint256 target = _target(a);
            uint256 room = target > a.balance ? target - a.balance : 0;
            uint256 amount = refill < room ? refill : room;
            if (a.withdrawalAmount != 0 || amount == 0 || !_tryPull(payer, amount)) {
                emit RefillSkipped(batchKey, payer, refill);
            } else {
                a.balance += uint128(amount);
                totalPooled += amount;
                emit Refilled(batchKey, payer, amount);
            }
        }
    }

    /// Sends the accrued usage to the fixed Treasury. Anyone may call it.
    function sweep() external nonReentrant returns (uint256 amount) {
        amount = treasuryAccrued;
        if (amount == 0) return 0;
        treasuryAccrued = 0;
        usdc.safeTransfer(treasury, amount);
        emit Swept(amount);
    }

    /// Stops debits and refills. Withdrawals and sweeps are never paused.
    function setSettlementsPaused(bool paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        settlementsPaused = paused;
        emit SettlementPauseUpdated(paused);
    }

    // --------------------------------------------------------------- internal

    function _configure(address owner, uint256 refillTarget, uint256 dailyLimit) private {
        if (refillTarget > maxRefillTarget || dailyLimit == 0 || dailyLimit > type(uint128).max) revert InvalidAmount();
        Account storage a = _accounts[owner];
        uint256 current = _limitNow(a);
        a.refillTarget = uint128(refillTarget);
        a.configured = true;
        uint256 effectiveAt;
        if (dailyLimit >= current) {
            // Raising (or keeping) the limit cannot strand accepted usage.
            a.dailyLimit = uint128(dailyLimit);
            a.pendingDailyLimit = 0;
            a.dailyLimitEffectiveAt = 0;
            effectiveAt = block.timestamp;
        } else {
            // Lowering waits like a withdrawal, so usage already accepted still settles.
            a.dailyLimit = uint128(current);
            a.pendingDailyLimit = uint128(dailyLimit);
            effectiveAt = block.timestamp + withdrawalDelay;
            a.dailyLimitEffectiveAt = uint64(effectiveAt);
        }
        emit Configured(owner, refillTarget, dailyLimit, effectiveAt);
    }

    function _requestWithdrawal(address owner, uint256 amount) private {
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        Account storage a = _accounts[owner];
        uint256 at = block.timestamp + withdrawalDelay;
        // A new request always restarts the delay, so it cannot shorten the wait.
        a.withdrawalAmount = uint128(amount);
        a.withdrawableAt = uint64(at);
        emit WithdrawalRequested(owner, amount, at);
    }

    function _cancelWithdrawal(address owner) private {
        Account storage a = _accounts[owner];
        if (a.withdrawalAmount == 0) revert NoWithdrawal();
        a.withdrawalAmount = 0;
        a.withdrawableAt = 0;
        emit WithdrawalCancelled(owner);
    }

    function _verify(address owner, bytes32 structHash, uint256 nonce, uint256 deadline, bytes calldata signature) private {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (!SignatureChecker.isValidSignatureNow(owner, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
        _useCheckedNonce(owner, nonce);
    }

    function _limitNow(Account storage a) private view returns (uint256) {
        if (a.dailyLimitEffectiveAt != 0 && block.timestamp >= a.dailyLimitEffectiveAt) return a.pendingDailyLimit;
        return a.configured ? a.dailyLimit : defaultDailyLimit;
    }

    function _target(Account storage a) private view returns (uint256) {
        return a.configured ? a.refillTarget : defaultRefillTarget;
    }

    function _rollDay(Account storage a) private {
        if (a.dailyLimitEffectiveAt != 0 && block.timestamp >= a.dailyLimitEffectiveAt) {
            a.dailyLimit = a.pendingDailyLimit;
            a.pendingDailyLimit = 0;
            a.dailyLimitEffectiveAt = 0;
        }
        uint64 today = _today();
        if (a.day != today) {
            a.day = today;
            a.spentToday = 0;
        }
    }

    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _pull(address from, uint256 amount) private {
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(from, address(this), amount);
        if (usdc.balanceOf(address(this)) - before != amount) revert UnsupportedToken();
    }

    /// Like `_pull`, but reports failure instead of reverting.
    function _tryPull(address from, uint256 amount) private returns (bool) {
        uint256 before = usdc.balanceOf(address(this));
        try usdc.transferFrom(from, address(this), amount) returns (bool ok) {
            if (!ok) return false;
        } catch {
            return false;
        }
        if (usdc.balanceOf(address(this)) - before != amount) revert UnsupportedToken();
        return true;
    }
}
