import { useState } from 'react';
import { getAddress } from 'viem';
import { useApp, useLoad } from '../context.js';
import { useWallet } from '../wallet.jsx';
import { Badge, Button, Drawer, Empty, Kv, Mono, Note, PageHead, Skeleton, Stat, Table } from '../ui.jsx';
import { formatDateTime, formatNanoUsdc, formatRelativeTime, shortAddress } from '../format.js';
import { connectOwnedWallet, displayTokenAmount, tokenAmount } from '../wallet-actions.js';
import { channelId, depositDraft, newChannelConfig, paymentHeader, refundDraft } from '../x402.js';
import { CHAIN_ID } from '../chain.js';
import { proxySamples, x402Samples } from '../snippets.js';
import { CodeBlock } from '../ui.jsx';
import { t } from '../i18n.js';

const big = (value) => BigInt(value ?? 0);
const unspent = (channel) => big(channel.balance_atomic) - big(channel.charged_atomic);

// Signs typed data with the logged-in wallet (EIP-712 v4), checking the
// account first so a deposit can only come from the payer being shown.
async function sign(provider, owner, typed) {
  await connectOwnedWallet(provider, owner, CHAIN_ID);
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(typed)] });
  if (typeof signature !== 'string' || !/^0x[0-9a-f]+$/i.test(signature)) throw new Error(t('The wallet returned no valid signature'));
  return signature;
}

function RequestsDrawer({ channel, onClose }) {
  const app = useApp();
  const { data, loading } = useLoad(() => app.api.listChannelRequests(channel.channel_id), [channel.channel_id]);
  return (
    <Drawer label={t('Channel requests')} title={<h2>{t('Channel requests')}</h2>} onClose={onClose}>
      <div className="drawer-section">
        <Kv rows={[[t('Channel'), <Mono value={channel.channel_id} />], [t('Charged'), `${displayTokenAmount(channel.charged_atomic)} USDC`],
          [t('Claimed on-chain'), `${displayTokenAmount(channel.claimed_atomic)} USDC`], [t('Deposited'), `${displayTokenAmount(channel.balance_atomic)} USDC`]]} />
      </div>
      {loading ? <Skeleton rows={4} /> : (
        <Table headers={[t('Time'), t('Model'), { text: t('Cost'), className: 'num' }, { text: t('Ceiling'), className: 'num' }, t('Status')]}>
          {(data?.items ?? []).map((item) => (
            <tr key={item.id}>
              <td title={formatDateTime(item.created_at)}>{formatRelativeTime(item.created_at)}</td>
              <td>{item.model ?? item.protocol}</td>
              <td className="num">{item.charge_nano == null ? '—' : formatNanoUsdc(item.charge_nano, { maximumFractionDigits: 6 })}</td>
              <td className="num">{formatNanoUsdc(item.max_charge_nano, { maximumFractionDigits: 6 })}</td>
              <td>{item.status === 'completed' ? <Badge tone={item.charged_from === 'ceiling' ? 'warning' : 'success'}>{item.charged_from === 'ceiling' ? t('At ceiling') : t('Settled')}</Badge>
                : <Badge tone="danger">{item.failure_code ?? item.status}</Badge>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Drawer>
  );
}

export function Channels() {
  const app = useApp();
  const { api, toast, dialogs } = app;
  const walletConnection = useWallet();
  const { data, loading, error, reload } = useLoad(() => api.listChannels(), [app.revision]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [open, setOpen] = useState(null);
  if (loading) return <Skeleton rows={6} />;
  if (error) return <Empty title={t('Cannot load channels')}>{error}</Empty>;
  const { terms, payer, walletKind, channels } = data;
  const owner = getAddress(payer);
  const chainId = Number(terms.chainId);
  const existing = channels.find((c) => c.payer_authorizer !== '0x0000000000000000000000000000000000000000' || walletKind === 'contract') ?? channels[0] ?? null;

  async function deposit(channel) {
    const values = await dialogs.form({
      title: channel ? t('Deposit to channel') : t('Open a payment channel'), submitLabel: t('Sign and deposit'),
      description: channel ? t('USDC moves from your wallet into your own channel in the contract ({0}). Signatures only; the platform pays gas.', shortAddress(channel.channel_id, 10, 6))
        : t('The first deposit opens the channel. USDC in the x402 contract stays yours: request a refund here any time, or withdraw on-chain (arrives after {0} hours). Minimum {1} USDC; opening costs 0.000001 USDC.', Math.round(terms.withdrawDelaySeconds / 3600), displayTokenAmount(terms.minDepositAtomic)),
      fields: [{ name: 'amount', label: t('Amount (USDC)'), required: true, inputmode: 'decimal', placeholder: displayTokenAmount(terms.minDepositAtomic), maxLength: 40 }],
      onSubmit: async (input) => {
        const amount = tokenAmount(input.amount, 6);
        if (!channel && amount < big(terms.minDepositAtomic)) throw new Error(t('The first deposit is at least {0} USDC', displayTokenAmount(terms.minDepositAtomic)));
        return { amount };
      }
    });
    if (!values) return;
    setBusy(true);
    try {
      const provider = await walletConnection.requestProvider();
      const config = channel ? channel.config : newChannelConfig({ payer: owner, walletKind, terms, salt: `0x${crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}` });
      const id = channel ? channel.channel_id : channelId(config, chainId);
      const draft = depositDraft({ config, id, amountAtomic: values.amount, chargedAtomic: channel?.charged_atomic ?? 0, terms, chainId });
      toast(t('Sign the deposit authorization in your wallet (1/2)'), 'neutral');
      const authorization = await sign(provider, owner, draft.authorization);
      toast(t('Sign the channel voucher in your wallet (2/2)'), 'neutral');
      const voucher = await sign(provider, owner, draft.voucher);
      const result = await api.x402Deposit(paymentHeader({ accepted: await api.x402Terms('deposit'), payload: draft.payload({ authorization, voucher }) }));
      toast(t('Deposited, transaction {0}', shortAddress(result.transaction ?? '', 10, 6)), 'success');
      await reload();
    } catch (err) {
      if (err.code !== 4001) toast(err.message, 'danger');
    } finally { setBusy(false); }
  }

  // One cooperative refund per channel: the wallet signs a zero-charge
  // voucher, the gateway claims what it is owed and returns the rest.
  async function refundOne(provider, channel, accepted) {
    const draft = refundDraft({ config: channel.config, id: channel.channel_id, chargedAtomic: channel.charged_atomic, chainId });
    const signature = await sign(provider, owner, draft.voucher);
    return api.x402Refund(paymentHeader({ accepted, payload: draft.payload(signature) }));
  }

  async function refund(channel) {
    const amount = unspent(channel);
    const confirmed = await dialogs.confirm({ title: t('Refund the unused deposit'), confirmLabel: t('Sign and refund'), tone: 'neutral',
      description: t('The {0} USDC of charges not yet on-chain are settled first, then the remaining {1} USDC goes back to your wallet. Signature only; the platform pays gas. The channel closes and the next call opens a new one.', displayTokenAmount(big(channel.charged_atomic) - big(channel.claimed_atomic)), displayTokenAmount(amount)) });
    if (!confirmed) return;
    setBusy(true);
    try {
      const provider = await walletConnection.requestProvider();
      const result = await refundOne(provider, channel, await api.x402Terms('refund'));
      toast(t('Refunded, transaction {0}', shortAddress(result.transaction ?? '', 10, 6)), 'success');
      await reload();
    } catch (err) {
      if (err.code !== 4001) toast(err.message, 'danger');
    } finally { setBusy(false); }
  }

  // Every channel with something to take back, one signature each, in a row.
  // The protocol refunds per channel, so a wallet with many channels (an agent
  // proxy's pool) signs once per channel; the CLI does the same without
  // prompts. Cancelling in the wallet stops the run and keeps what was done.
  async function refundAll() {
    const refundable = channels.filter((c) => Number(c.withdraw_requested_at) === 0 && unspent(c) > 0n);
    if (!refundable.length) return;
    const total = refundable.reduce((sum, c) => sum + unspent(c), 0n);
    const confirmed = await dialogs.confirm({ title: t('Refund all {0} channels', refundable.length), confirmLabel: t('Start signing'), tone: 'neutral',
      description: t('{0} USDC goes back to your wallet. The wallet asks for {1} signatures, one per channel; cancelling stops there and finished refunds stay done. The platform pays gas.', displayTokenAmount(total), refundable.length) });
    if (!confirmed) return;
    setBusy(true);
    let done = 0;
    try {
      const provider = await walletConnection.requestProvider();
      const accepted = await api.x402Terms('refund');
      for (const [index, channel] of refundable.entries()) {
        setProgress({ index: index + 1, total: refundable.length });
        try {
          await refundOne(provider, channel, accepted);
          done += 1;
        } catch (err) {
          if (err.code === 4001) break;
          toast(t('Refund of channel {0} failed: {1}', shortAddress(channel.channel_id, 10, 6), err.message), 'danger');
        }
      }
      toast(done === refundable.length ? t('Refunded all {0} channels', done) : t('Refunded {0} / {1} channels', done, refundable.length), done ? 'success' : 'warning');
      await reload();
    } catch (err) {
      if (err.code !== 4001) toast(err.message, 'danger');
    } finally { setBusy(false); setProgress(null); }
  }

  const totals = channels.reduce((acc, c) => ({ balance: acc.balance + big(c.balance_atomic), charged: acc.charged + big(c.charged_atomic), unclaimed: acc.unclaimed + big(c.charged_atomic) - big(c.claimed_atomic) }), { balance: 0n, charged: 0n, unclaimed: 0n });
  return (
    <div className="stack">
      <PageHead title="Self-signed channels" description={t('Advanced, without an API key: the client (local proxy or x402 SDK) signs a voucher for every call with the wallet key. API key channels are not listed here; see API keys.')}
        actions={<div className="view-actions">
          {channels.some((c) => Number(c.withdraw_requested_at) === 0 && unspent(c) > 0n)
            ? <Button onClick={refundAll} disabled={busy || !terms.ready}>{progress ? t('Refunding {0}/{1}', progress.index, progress.total) : t('Refund all')}</Button> : null}
          <Button variant="primary" onClick={() => deposit(existing)} disabled={busy || !terms.ready}>{existing ? t('Deposit') : t('Open channel')}</Button>
        </div>} />
      {!terms.ready ? <Note tone="danger">{t('x402 settlement is unavailable; try again shortly.')}</Note> : null}
      <section className="stat-grid" aria-label={t('Channel summary')}>
        <Stat label={t('Deposited')} value={displayTokenAmount(totals.balance)} unit="USDC" foot={t('Your USDC in the contract')} />
        <Stat label={t('Charged')} value={displayTokenAmount(totals.charged)} unit="USDC" foot={t('Actual tokens, service fee included')} />
        <Stat label={t('Refundable')} value={displayTokenAmount(totals.balance - totals.charged)} unit="USDC" foot={t('Unused deposits in {0} channels', channels.length)} />
        <Stat label={t('Per-request limit')} value={displayTokenAmount(terms.requestLimitAtomic)} unit="USDC" foot={t('The most one voucher covers · up to {0} channels per wallet', terms.maxChannelsPerPayer ?? 128)} />
      </section>
      {channels.length === 0 ? (
        <Empty title={t('No channels yet')} action={<Button variant="primary" onClick={() => deposit(null)} disabled={busy || !terms.ready}>{t('Open channel')}</Button>}>
          {t('An x402 client opens and funds one on its first call; you can also deposit here first.')}
        </Empty>
      ) : (
        <section className="card flush">
          <Table headers={[t('Channel'), { text: t('Deposited'), className: 'num' }, { text: t('Charged'), className: 'num' }, { text: t('Refundable'), className: 'num' }, t('Last used'), t('Status'), '']}>
            {channels.map((channel) => {
              const withdrawing = Number(channel.withdraw_requested_at) > 0;
              return (
                <tr key={channel.channel_id} data-clickable onClick={() => setOpen(channel)}>
                  <td><Mono value={shortAddress(channel.channel_id, 10, 6)} title={channel.channel_id} /><br /><small>{t('{0} calls', channel.requests)}</small></td>
                  <td className="num">{displayTokenAmount(channel.balance_atomic)}</td>
                  <td className="num">{displayTokenAmount(channel.charged_atomic)}</td>
                  <td className="num">{displayTokenAmount(unspent(channel))}</td>
                  <td title={formatDateTime(channel.last_request_at)}>{channel.last_request_at ? formatRelativeTime(channel.last_request_at) : '—'}</td>
                  <td>{withdrawing ? <Badge tone="warning">{t('Withdrawing on-chain')}</Badge> : <Badge tone="success">{t('Active')}</Badge>}</td>
                  <td className="num" onClick={(event) => event.stopPropagation()}>
                    <div className="view-actions">
                      <Button size="sm" onClick={() => deposit(channel)} disabled={busy || withdrawing}>{t('Deposit')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => refund(channel)} disabled={busy || withdrawing || unspent(channel) <= 0n}>{t('Refund')}</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        </section>
      )}
      <section className="card">
        <div className="card-head"><div><h2>{t('Call through an x402 client')}</h2><p>{t('The proxy holds the wallet key and opens channels as concurrency needs (up to {0}); any OpenAI-compatible client works as usual. ', terms.maxChannelsPerPayer ?? 128)}<code>refund --all</code>{t(' refunds every channel the proxy opened. The Foundation SDK works too, one channel per instance.')}</p></div></div>
        <CodeBlock samples={[...proxySamples({ baseUrl: app.gatewayUrl, model: 'deepseek/deepseek-flash' }).slice(0, 1), ...x402Samples({ baseUrl: app.gatewayUrl, model: 'deepseek/deepseek-flash' })]} />
        <Kv className="kv left" rows={[
          [t('Network / asset'), `Monad (${terms.network}) · USDC ${shortAddress(terms.asset, 8, 6)}`],
          [t('Contract'), <Mono value={terms.contract} />],
          [t('Payee and authorizer'), `${shortAddress(terms.payTo, 8, 6)} · ${shortAddress(terms.receiverAuthorizer, 8, 6)}`],
          [t('On-chain withdrawal delay'), t('{0} hours (contract initiateWithdraw / finalizeWithdraw, needs MON for gas)', Math.round(terms.withdrawDelaySeconds / 3600))],
          [t('Streaming'), t('The receipt is in gateway.x402 of the last chunk; with the standard SDK the next call first gets one corrective 402 and then succeeds, so the client needs an RPC.')],
          [t('Concurrency'), t('One request at a time per channel; the proxy opens more as needed, SDK clients open more with different salts.')],
          [t('Withdrawal'), t("“Refund all” signs once per channel; the proxy's refund --all needs no clicks; or call initiateWithdraw on the contract yourself.")]
        ]} />
      </section>
      {open ? <RequestsDrawer channel={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
