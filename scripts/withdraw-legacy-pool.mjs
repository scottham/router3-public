#!/usr/bin/env node
// Takes a wallet's USDC out of the retired WalletPrepaidPool contract
// (0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3 on Monad), which the gateway and
// console no longer touch. Two transactions by the wallet itself (it pays gas):
//
//   node --env-file=.env scripts/withdraw-legacy-pool.mjs            # shows the balance; requests withdrawal of all of it
//   node --env-file=.env scripts/withdraw-legacy-pool.mjs --withdraw # after the 30 minute cooldown: moves it to the wallet
//
// PRIVATE_KEY is the pool owner's wallet; MONAD_RPC_URL defaults to the public RPC.
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';

const POOL = '0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3';
const abi = ['function accountOf(address) view returns (uint256 balance,uint256 withdrawalAmount,uint256 withdrawableAt,uint256 refillTarget,uint256 dailyLimit,uint256 dailyRemaining)',
  'function requestWithdrawal(uint256 amount)', 'function cancelWithdrawal()', 'function withdraw(address owner) returns (uint256)'];
const key = String(process.env.PRIVATE_KEY ?? '').trim().replace(/^['"]|['"]$/g, '');
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) { console.error('PRIVATE_KEY is required'); process.exit(2); }
const provider = new JsonRpcProvider(process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz', 143, { staticNetwork: true });
const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
const pool = new Contract(POOL, abi, wallet);
const account = await pool.accountOf(wallet.address);
const state = { owner: wallet.address, balanceUsdc: formatUnits(account.balance, 6), withdrawalUsdc: formatUnits(account.withdrawalAmount, 6),
  withdrawableAt: account.withdrawableAt > 0n ? new Date(Number(account.withdrawableAt) * 1000).toISOString() : null };
console.log(JSON.stringify(state));
try {
  if (process.argv.includes('--withdraw')) {
    if (account.withdrawalAmount === 0n) throw new Error('nothing requested: run without --withdraw first');
    if (BigInt(Math.floor(Date.now() / 1000)) < account.withdrawableAt) throw new Error(`cooldown ends at ${state.withdrawableAt}`);
    const tx = await pool.withdraw(wallet.address);
    console.log(JSON.stringify({ transaction: tx.hash, status: (await tx.wait()).status === 1 ? 'withdrawn' : 'reverted' }));
  } else {
    if (account.withdrawalAmount > 0n) { console.log(JSON.stringify({ note: 'withdrawal already requested; rerun with --withdraw after the cooldown' })); }
    else if (account.balance === 0n) { console.log(JSON.stringify({ note: 'nothing in the pool' })); }
    else {
      const tx = await pool.requestWithdrawal(account.balance);
      console.log(JSON.stringify({ transaction: tx.hash, status: (await tx.wait()).status === 1 ? 'requested' : 'reverted', note: 'rerun with --withdraw after 30 minutes' }));
    }
  }
} finally { provider.destroy(); }
