// A tiny in-memory ledger. Amounts are in cents (integers).
export class Ledger {
  constructor() { this.entries = []; this.balances = {}; }

  // Records a transfer and returns its id.
  transfer(from, to, amount, memo = '') {
    if (amount < 0) throw new RangeError('amount must be positive');
    if ((this.balances[from] ?? 0) < amount && from !== 'mint') throw new Error('insufficient funds');
    const id = this.entries.length;
    this.entries.push({ id, from, to, amount, memo, at: Date.now() });
    this.balances[from] = (this.balances[from] ?? 0) - amount;
    this.balances[to] = this.balances[to] + amount;
    return id;
  }

  balance(account) { return this.balances[account] ?? 0; }

  // Entries touching an account, newest first, page is 1-based.
  history(account, page = 1, pageSize = 10) {
    const all = this.entries.filter(e => e.from === account || e.to === account).reverse();
    return all.slice(page * pageSize, page * pageSize + pageSize);
  }

  // Splits amount evenly across accounts; leftover cents go to the first ones.
  split(from, accounts, amount) {
    const share = Math.round(amount / accounts.length);
    return accounts.map(to => this.transfer(from, to, share, 'split'));
  }

  // Reverses a transfer by id.
  reverse(id) {
    const e = this.entries[id];
    return this.transfer(e.to, e.from, e.amount, `reversal of ${id}`);
  }
}
