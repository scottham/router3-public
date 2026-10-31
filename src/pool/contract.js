import {Interface,getAddress,keccak256,solidityPacked,toUtf8Bytes} from 'ethers';

// WalletPrepaidPool (contracts/src/WalletPrepaidPool.sol, deployed on Monad
// at POOL_ADDRESS) and the USDC calls the gateway makes for it.
export const poolInterface=new Interface([
  'error InvalidConfiguration()','error InvalidSettlement()','error DuplicateBatch()','error DuplicateClaim()','error SettlementPaused()',
  'error InsufficientPool()','error DailyLimitExceeded()','error InvalidAmount()','error InvalidSignature()','error SignatureExpired()',
  'error NoWithdrawal()','error WithdrawalNotReady()','error UnsupportedToken()',
  'function settle(bytes32 batchKey,address payer,bytes32 claimKey,uint256 debit,uint256 refill,bytes32 usageRoot)',
  'function accountOf(address owner) view returns(uint256 balance,uint256 withdrawalAmount,uint256 withdrawableAt,uint256 refillTarget,uint256 dailyLimit,uint256 dailyRemaining)',
  'function configureBySig(address owner,uint256 refillTarget,uint256 dailyLimit,uint256 nonce,uint256 deadline,bytes signature)',
  'function requestWithdrawalBySig(address owner,uint256 amount,uint256 nonce,uint256 deadline,bytes signature)',
  'function cancelWithdrawalBySig(address owner,uint256 nonce,uint256 deadline,bytes signature)',
  'function withdraw(address owner) returns(uint256)',
  'function sweep() returns(uint256)',
  'function treasuryAccrued() view returns(uint256)',
  'function treasury() view returns(address)',
  'function usdc() view returns(address)',
  'function nonces(address owner) view returns(uint256)',
  'function withdrawalDelay() view returns(uint256)',
  'function maxDebit() view returns(uint256)',
  'function maxRefillTarget() view returns(uint256)',
  'function defaultRefillTarget() view returns(uint256)',
  'function defaultDailyLimit() view returns(uint256)',
  'function settlementsPaused() view returns(bool)',
  'function SETTLER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)',
  'event Debited(bytes32 indexed batchKey,bytes32 indexed claimKey,address indexed payer,uint256 amount,bytes32 usageRoot)',
  'event Refilled(bytes32 indexed batchKey,address indexed payer,uint256 amount)',
  'event RefillSkipped(bytes32 indexed batchKey,address indexed payer,uint256 requested)',
  'event Configured(address indexed owner,uint256 refillTarget,uint256 dailyLimit,uint256 dailyLimitEffectiveAt)',
  'event WithdrawalRequested(address indexed owner,uint256 amount,uint256 withdrawableAt)',
  'event WithdrawalCancelled(address indexed owner)',
  'event Withdrawn(address indexed owner,uint256 amount)',
  'event Swept(uint256 amount)'
]);

// USDC v2.2 accepts EOA (65-byte) and ERC-1271 signatures through this overload.
export const usdcInterface=new Interface([
  'function permit(address owner,address spender,uint256 value,uint256 deadline,bytes signature)',
  'function nonces(address owner) view returns(uint256)',
  'function balanceOf(address owner) view returns(uint256)',
  'function allowance(address owner,address spender) view returns(uint256)',
  'function name() view returns(string)',
  'function version() view returns(string)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);

// What the wallet signs. The pool's EIP-712 domain is fixed by the contract.
export const POOL_DOMAIN={name:'Router3 Prepaid Pool',version:'1'};
export const POOL_TYPES={
  Configure:[{name:'owner',type:'address'},{name:'refillTarget',type:'uint256'},{name:'dailyLimit',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}],
  RequestWithdrawal:[{name:'owner',type:'address'},{name:'amount',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}],
  CancelWithdrawal:[{name:'owner',type:'address'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]
};
export const PERMIT_TYPES={Permit:[{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]};
export const OP_PRIMARY_TYPE={configure:'Configure',request_withdrawal:'RequestWithdrawal',cancel_withdrawal:'CancelWithdrawal'};

// Keys a settlement is known by on-chain; each is used once.
export const batchKeyOf=id=>keccak256(toUtf8Bytes(`router3:pool-batch:${id}`)).toLowerCase();
export const claimKeyOf=id=>keccak256(toUtf8Bytes(`router3:pool-claim:${id}`)).toLowerCase();
// The usage a debit pays for: the sorted ids of the charges it covers.
export function usageRootOf(requestIds) {
  const ids=[...requestIds].map(String).sort();
  return keccak256(ids.length?solidityPacked(ids.map(()=>'string'),ids):'0x').toLowerCase();
}

export const settleCalldata=b=>poolInterface.encodeFunctionData('settle',[b.batch_key,getAddress(b.payer),
  b.claim_key??`0x${'0'.repeat(64)}`,BigInt(b.debit_atomic),BigInt(b.refill_atomic),b.usage_root]);

// The calldata of a queued op, and the contract it goes to.
export function opCall(op,{poolAddress,usdcAddress}) {
  const p=op.payload??{};
  const big=v=>BigInt(v);
  switch(op.kind) {
    case 'permit': return {to:usdcAddress,data:usdcInterface.encodeFunctionData('permit',[getAddress(op.payer),getAddress(poolAddress),big(p.value),big(p.deadline),p.signature])};
    case 'configure': return {to:poolAddress,data:poolInterface.encodeFunctionData('configureBySig',[getAddress(op.payer),big(p.refillTarget),big(p.dailyLimit),big(p.nonce),big(p.deadline),p.signature])};
    case 'request_withdrawal': return {to:poolAddress,data:poolInterface.encodeFunctionData('requestWithdrawalBySig',[getAddress(op.payer),big(p.amount),big(p.nonce),big(p.deadline),p.signature])};
    case 'cancel_withdrawal': return {to:poolAddress,data:poolInterface.encodeFunctionData('cancelWithdrawalBySig',[getAddress(op.payer),big(p.nonce),big(p.deadline),p.signature])};
    case 'withdraw': return {to:poolAddress,data:poolInterface.encodeFunctionData('withdraw',[getAddress(op.payer)])};
    case 'sweep': return {to:poolAddress,data:poolInterface.encodeFunctionData('sweep',[])};
    default: throw new Error('POOL_OP_UNKNOWN');
  }
}

const logsOf=(receipt,address,iface)=>receipt.logs.filter(log=>log.address.toLowerCase()===address.toLowerCase()).flatMap(log=>{
  try {const parsed=iface.parseLog(log);return parsed?[parsed]:[];} catch {return [];}
});

// A settlement counts only with the pool's own events for exactly this batch:
// one Debited for a planned debit, one Refilled (backed by the matching USDC
// transfer into the pool) or RefillSkipped for a planned refill.
export function verifySettleReceipt(receipt,batch,{poolAddress,usdcAddress}) {
  const pool=poolAddress.toLowerCase();
  if(receipt.to?.toLowerCase()!==pool)throw new Error('POOL_RECEIPT_TARGET_MISMATCH');
  if(receipt.status===0)return {success:false,refill:null,refilledAtomic:0n};
  if(receipt.status!==1)throw new Error('POOL_RECEIPT_STATUS_INVALID');
  const events=logsOf(receipt,pool,poolInterface).filter(e=>e.args.batchKey?.toLowerCase()===batch.batch_key);
  const debits=events.filter(e=>e.name==='Debited'),refills=events.filter(e=>e.name==='Refilled'),skips=events.filter(e=>e.name==='RefillSkipped');
  const debit=BigInt(batch.debit_atomic),refill=BigInt(batch.refill_atomic),payer=batch.payer.toLowerCase();
  if(debit>0n) {
    const [d]=debits;
    if(debits.length!==1||d.args.claimKey.toLowerCase()!==batch.claim_key||d.args.payer.toLowerCase()!==payer
      ||d.args.amount!==debit||d.args.usageRoot.toLowerCase()!==batch.usage_root)throw new Error('POOL_RECEIPT_DEBIT_MISMATCH');
  } else if(debits.length)throw new Error('POOL_RECEIPT_DEBIT_MISMATCH');
  if(refill===0n) {
    if(refills.length||skips.length)throw new Error('POOL_RECEIPT_REFILL_MISMATCH');
    return {success:true,refill:null,refilledAtomic:0n};
  }
  if(refills.length+skips.length!==1)throw new Error('POOL_RECEIPT_REFILL_MISMATCH');
  if(skips.length) {
    if(skips[0].args.payer.toLowerCase()!==payer||skips[0].args.requested!==refill)throw new Error('POOL_RECEIPT_REFILL_MISMATCH');
    return {success:true,refill:'skipped',refilledAtomic:0n};
  }
  const amount=refills[0].args.amount;
  const transfers=logsOf(receipt,usdcAddress,usdcInterface).filter(t=>t.name==='Transfer'
    &&t.args.from.toLowerCase()===payer&&t.args.to.toLowerCase()===pool);
  if(refills[0].args.payer.toLowerCase()!==payer||amount<=0n||amount>refill
    ||transfers.length!==1||transfers[0].args.value!==amount)throw new Error('POOL_RECEIPT_REFILL_MISMATCH');
  return {success:true,refill:'refilled',refilledAtomic:amount};
}

// A relayed op counts only with the event its call must emit.
export function verifyOpReceipt(receipt,op,{poolAddress,usdcAddress}) {
  const {to}=opCall(op,{poolAddress,usdcAddress});
  if(receipt.to?.toLowerCase()!==to.toLowerCase())throw new Error('POOL_OP_RECEIPT_TARGET_MISMATCH');
  if(receipt.status===0)return false;
  if(receipt.status!==1)throw new Error('POOL_OP_RECEIPT_STATUS_INVALID');
  const owner=e=>e.args.owner?.toLowerCase()===op.payer;
  const p=op.payload??{};
  if(op.kind==='permit') {
    const approvals=logsOf(receipt,usdcAddress,usdcInterface).filter(e=>e.name==='Approval');
    if(approvals.length===1&&owner(approvals[0])&&approvals[0].args.spender.toLowerCase()===poolAddress.toLowerCase()
      &&approvals[0].args.value===BigInt(p.value))return true;
    throw new Error('POOL_OP_RECEIPT_MISMATCH');
  }
  const events=logsOf(receipt,poolAddress,poolInterface);
  const expected={
    configure:e=>e.name==='Configured'&&owner(e)&&e.args.refillTarget===BigInt(p.refillTarget)&&e.args.dailyLimit===BigInt(p.dailyLimit),
    request_withdrawal:e=>e.name==='WithdrawalRequested'&&owner(e)&&e.args.amount===BigInt(p.amount),
    cancel_withdrawal:e=>e.name==='WithdrawalCancelled'&&owner(e),
    withdraw:e=>e.name==='Withdrawn'&&owner(e),
    sweep:e=>e.name==='Swept'
  }[op.kind];
  // A sweep with nothing accrued succeeds without an event.
  if(events.filter(expected).length===1||(op.kind==='sweep'&&events.length===0))return true;
  throw new Error('POOL_OP_RECEIPT_MISMATCH');
}
