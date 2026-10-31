import { useEffect, useState } from 'react';
import { getAddress } from 'viem';
import { useApp, useLoad } from '../context.js';
import { useWallet } from '../wallet.jsx';
import { Badge, Button, CodeBlock, Drawer, Empty, InlineCopy, Kv, Modal, Mono, Note, PageHead, Skeleton, Stat, Table } from '../ui.jsx';
import { formatDateTime, formatNanoUsdc, formatRelativeTime, shortAddress } from '../format.js';
import { connectOwnedWallet, displayTokenAmount, tokenAmount } from '../wallet-actions.js';
import { CHAIN_ID } from '../chain.js';
import { callSamples } from '../snippets.js';
import { cancelWithdrawalTyped, concurrentAt, configureTyped, permitTyped, signatureDeadline, withdrawalTyped } from '../pool.js';
import { errorText, t } from '../i18n.js';

const big = (value) => BigInt(value ?? 0);
const usdc = (atomic) => `${displayTokenAmount(atomic)} USDC`;
// A withdrawal asks for everything; the pool pays out what it holds.
const WITHDRAW_ALL_ATOMIC = 10n ** 15n;

async function sign(provider, owner, typed) {
  await connectOwnedWallet(provider, owner, CHAIN_ID);
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(typed)] });
  if (typeof signature !== 'string' || !/^0x[0-9a-f]+$/i.test(signature)) throw new Error(t('The wallet returned no valid signature'));
  return signature;
}

// Shown once after creation: the secret is not stored in readable form.
function CreatedKey({ token, baseUrl, model, poolOn, done }) {
  return (
    <Modal label={t('New API key')} onClose={() => done()} locked>
      <div className="dialog-body">
        <h2>{t('API key created')}</h2>
        <p>{poolOn ? t('Shown only once; copy it now. It works right away.') : t('Shown only once; copy it now. Turn on automatic payment to start calling.')}</p>
        <InlineCopy value={token} label={t('Copy key')} secret />
        <CodeBlock samples={callSamples({ baseUrl, model, apiKey: token })} />
        <div className="dialog-actions"><Button variant="primary" onClick={() => done()}>{t('I saved it')}</Button></div>
      </div>
    </Modal>
  );
}

function RequestsDrawer({ apiKey, onClose }) {
  const app = useApp();
  const { data, loading } = useLoad(() => app.api.listKeyRequests(apiKey.id), [apiKey.id]);
  return (
    <Drawer label={t('Requests')} title={<h2>{apiKey.name} · {t('Requests')}</h2>} onClose={onClose}>
      <div className="drawer-section">
        <Kv rows={[['Key', <Mono value={`${apiKey.prefix}_…`} />], [t('Spent today'), usdc(apiKey.spentTodayAtomic)], [t('Spent'), usdc(apiKey.spentAtomic)],
          [t('Daily limit'), apiKey.dailyLimitAtomic ? usdc(apiKey.dailyLimitAtomic) : t('No limit')], [t('Total limit'), apiKey.totalLimitAtomic ? usdc(apiKey.totalLimitAtomic) : t('No limit')]]} />
      </div>
      {loading ? <Skeleton rows={4} /> : (
        <Table headers={[t('Time'), t('Model'), { text: t('Cost'), className: 'num' }, { text: t('Hold'), className: 'num' }, t('Status')]}>
          {(data?.items ?? []).map((item) => (
            <tr key={item.id}>
              <td title={formatDateTime(item.created_at)}>{formatRelativeTime(item.created_at)}</td>
              <td>{item.model ?? item.protocol}</td>
              <td className="num">{item.charge_nano == null ? '—' : formatNanoUsdc(item.charge_nano, { maximumFractionDigits: 6 })}</td>
              <td className="num">{displayTokenAmount(item.ceiling_atomic)}</td>
              <td>{item.status === 'running' ? <Badge>{t('Running')}</Badge>
                : item.status === 'completed' ? <Badge tone={item.charged_from === 'ceiling' ? 'warning' : 'success'}>{item.charged_from === 'ceiling' ? t('At hold') : item.settled ? t('Settled') : t('Charged')}</Badge>
                : <Badge tone="danger">{item.failure_code ?? item.status}</Badge>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Drawer>
  );
}

// The wallet's prepaid pool: what it holds, what calls may still use, and
// the settings the wallet signed.
function PoolCard({ pool, busy, onSetup, onLimits, onAllowance, onWithdraw, onCancel }) {
  const state = pool?.state ?? 'none';
  if (state === 'none') {
    return (
      <section className="card">
        <div className="card-head"><div><h2>{t('Automatic payment')}</h2>
          <p>{t('Sign once: the gateway refills a pool of USDC from your wallet as you use it and charges the tokens each call used. The pool stays yours; withdraw it any time.')}</p></div>
          <Button variant="primary" onClick={onSetup} disabled={busy}>{t('Turn on automatic payment')}</Button></div>
      </section>
    );
  }
  const pending = (pool.ops ?? []).filter((o) => ['permit', 'configure', 'request_withdrawal', 'cancel_withdrawal', 'withdraw'].includes(o.kind));
  return (
    <section className="card">
      <div className="card-head"><div><h2>{t('Automatic payment')}</h2>
        <p>{state === 'withdrawing' ? t('Withdrawing: calls are paused; the pool goes back to your wallet after the delay, owed usage first.')
          : state === 'pending' ? t('Your signatures are being submitted; this takes a few seconds.')
          : state === 'paused' ? t('Refills are off. Turn automatic payment on again to keep calling.')
          : t('On. The pool refills from your wallet up to the target, within your daily limit.')}</p></div>
        <div className="view-actions">
          {state === 'withdrawing' ? <Button onClick={onCancel} disabled={busy}>{t('Cancel withdrawal')}</Button> : (
            <>
              {state === 'paused' ? <Button variant="primary" onClick={onSetup} disabled={busy}>{t('Turn on automatic payment')}</Button>
                : <Button onClick={onLimits} disabled={busy}>{t('Change limits')}</Button>}
              <Button variant="ghost" onClick={onAllowance} disabled={busy}>{t('Allowance')}</Button>
              <Button variant="ghost" onClick={onWithdraw} disabled={busy || big(pool.poolBalanceAtomic) === 0n}>{t('Withdraw')}</Button>
            </>
          )}
        </div>
      </div>
      <section className="stat-grid" aria-label={t('Pool summary')}>
        <Stat label={t('Pool')} value={displayTokenAmount(pool.poolBalanceAtomic)} unit="USDC" foot={t('Refills to {0}', usdc(pool.refillTargetAtomic))} />
        <Stat label={t('Available')} value={displayTokenAmount(pool.availableAtomic)} unit="USDC"
          foot={t('After {0} running and {1} owed', pool.running, usdc(pool.unsettledAtomic))} />
        <Stat label={t('Today')} value={displayTokenAmount(pool.dailyRemainingAtomic)} unit="USDC" foot={t('Left of the {0} daily limit', usdc(pool.dailyLimitAtomic))} />
        <Stat label={t('Allowance')} value={displayTokenAmount(pool.allowanceAtomic)} unit="USDC" foot={t('Wallet holds {0}', usdc(pool.walletBalanceAtomic))} />
      </section>
      {pending.length ? <Note>{t('Submitting: {0}', pending.map((o) => o.kind).join(', '))}</Note> : null}
      {state === 'withdrawing' && pool.withdrawableAt ? <Note>{t('Withdrawable from {0}', formatDateTime(pool.withdrawableAt))}</Note> : null}
    </section>
  );
}

export function Keys() {
  const app = useApp();
  const { api, toast, dialogs } = app;
  const walletConnection = useWallet();
  const { data, loading, error, reload } = useLoad(() => api.listKeys(), [app.revision]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const pool = data?.pool;
  // While signed calls are on their way, refresh until they land.
  const settling = pool && (pool.state === 'pending' || pool.ops?.length > 0);
  useEffect(() => {
    if (!settling) return undefined;
    const timer = setInterval(() => reload(), 3000);
    return () => clearInterval(timer);
  }, [settling]);
  if (loading) return <Skeleton rows={6} />;
  if (error) return <Empty title={t('Cannot load API keys')}>{error}</Empty>;
  const { terms, keys } = data;
  const model = 'deepseek/deepseek-flash';
  const poolOn = pool && ['active', 'pending'].includes(pool.state);

  // Signs with the signed-in wallet; returns what `fn` sends.
  async function withWallet(fn) {
    setBusy(true);
    try {
      const provider = await walletConnection.requestProvider();
      const owner = getAddress(app.wallet().address);
      const { terms: poolTerms, nonces } = await api.getPool();
      await fn({ provider, owner, terms: poolTerms, nonces, deadline: signatureDeadline() });
      await reload();
    } catch (err) {
      if (err.code !== 4001) toast(err.message, 'danger');
    } finally { setBusy(false); }
  }

  const limitsFields = (current = {}) => [
    { name: 'refillTarget', label: t('Refill target (USDC)'), type: 'select', options: [
      { value: '5', label: t('5 USDC · about {0} requests at once', concurrentAt(5_000_000n)), selected: !current.refill || current.refill === '5' },
      { value: '20', label: t('20 USDC · about {0} requests at once', concurrentAt(20_000_000n)), selected: current.refill === '20' },
      { value: '50', label: t('50 USDC · for many agents at once'), selected: current.refill === '50' }] },
    { name: 'dailyLimit', label: t('Daily limit (USDC)'), required: true, inputmode: 'decimal', value: current.daily ?? '20', maxLength: 12 }
  ];

  async function setup() {
    const values = await dialogs.form({ title: t('Turn on automatic payment'), submitLabel: t('Sign'),
      description: t('Two signatures, no gas: a USDC allowance for the pool, and its refill target and daily limit. The pool only ever pays the Treasury for usage or goes back to your wallet.'),
      fields: [...limitsFields(), { name: 'allowance', label: t('Allowance (USDC)'), required: true, inputmode: 'decimal', value: '100', maxLength: 12 }],
      onSubmit: async (input) => ({ refillTarget: tokenAmount(input.refillTarget, 6), dailyLimit: tokenAmount(input.dailyLimit, 6), allowance: tokenAmount(input.allowance, 6) }) });
    if (!values) return;
    await withWallet(async ({ provider, owner, terms: p, nonces, deadline }) => {
      toast(t('Sign the USDC allowance in your wallet (1/2)'), 'neutral');
      const permit = await sign(provider, owner, permitTyped({ terms: p, owner, value: values.allowance, nonce: BigInt(nonces.usdc), deadline }));
      toast(t('Sign the pool settings in your wallet (2/2)'), 'neutral');
      const configure = await sign(provider, owner, configureTyped({ terms: p, owner, refillTarget: values.refillTarget, dailyLimit: values.dailyLimit, nonce: BigInt(nonces.pool), deadline }));
      await api.poolSetup({ permit: { value: String(values.allowance), deadline: String(deadline), signature: permit },
        configure: { refillTarget: String(values.refillTarget), dailyLimit: String(values.dailyLimit), nonce: nonces.pool, deadline: String(deadline), signature: configure } });
      toast(t('Submitted; automatic payment starts in a few seconds'), 'success');
    });
  }

  async function changeLimits() {
    const values = await dialogs.form({ title: t('Change limits'), submitLabel: t('Sign'),
      description: t('One signature. A lower daily limit takes effect after the withdrawal delay; a higher one at once.'),
      fields: limitsFields({ refill: displayTokenAmount(pool.refillTargetAtomic), daily: displayTokenAmount(pool.dailyLimitAtomic) }),
      onSubmit: async (input) => ({ refillTarget: tokenAmount(input.refillTarget, 6), dailyLimit: tokenAmount(input.dailyLimit, 6) }) });
    if (!values) return;
    await withWallet(async ({ provider, owner, terms: p, nonces, deadline }) => {
      const signature = await sign(provider, owner, configureTyped({ terms: p, owner, ...values, nonce: BigInt(nonces.pool), deadline }));
      await api.poolConfigure({ refillTarget: String(values.refillTarget), dailyLimit: String(values.dailyLimit), nonce: nonces.pool, deadline: String(deadline), signature });
      toast(t('Submitted'), 'success');
    });
  }

  async function allowance() {
    const values = await dialogs.form({ title: t('Allowance'), submitLabel: t('Sign'),
      description: t('How much USDC the pool may pull from your wallet in total for refills. 0 stops refills.'),
      fields: [{ name: 'allowance', label: t('Allowance (USDC)'), required: true, inputmode: 'decimal', value: '100', maxLength: 12 }],
      onSubmit: async (input) => ({ value: input.allowance.trim() === '0' ? 0n : tokenAmount(input.allowance, 6) }) });
    if (!values) return;
    await withWallet(async ({ provider, owner, terms: p, nonces, deadline }) => {
      const signature = await sign(provider, owner, permitTyped({ terms: p, owner, value: values.value, nonce: BigInt(nonces.usdc), deadline }));
      await api.poolPermit({ value: String(values.value), deadline: String(deadline), signature });
      toast(t('Submitted'), 'success');
    });
  }

  async function withdraw() {
    const { terms: p } = await api.getPool();
    const confirmed = await dialogs.confirm({ title: t('Withdraw the pool'), confirmLabel: t('Sign'), tone: 'neutral',
      description: t('Calls stop now. Usage already owed is charged first; after the {0}-minute delay the rest of the pool goes back to your wallet and refills turn off.', Math.round(p.withdrawalDelaySeconds / 60)) });
    if (!confirmed) return;
    await withWallet(async ({ provider, owner, terms: p, nonces, deadline }) => {
      const signature = await sign(provider, owner, withdrawalTyped({ terms: p, owner, amount: WITHDRAW_ALL_ATOMIC, nonce: BigInt(nonces.pool), deadline }));
      await api.poolWithdraw({ amount: String(WITHDRAW_ALL_ATOMIC), nonce: nonces.pool, deadline: String(deadline), signature });
      toast(t('Withdrawal requested'), 'success');
    });
  }

  async function cancelWithdrawal() {
    await withWallet(async ({ provider, owner, terms: p, nonces, deadline }) => {
      const signature = await sign(provider, owner, cancelWithdrawalTyped({ terms: p, owner, nonce: BigInt(nonces.pool), deadline }));
      await api.poolCancelWithdrawal({ nonce: nonces.pool, deadline: String(deadline), signature });
      toast(t('Submitted'), 'success');
    });
  }

  async function create() {
    const values = await dialogs.form({ title: t('Create API key'), submitLabel: t('Create'),
      description: t('Every key spends from your pool. A daily limit caps what this key alone can spend; leave it empty for none.'),
      fields: [{ name: 'name', label: t('Name'), required: true, placeholder: t('e.g. laptop'), maxLength: 80 },
        { name: 'daily', label: t('Daily limit (USDC, optional)'), inputmode: 'decimal', maxLength: 12 }],
      onSubmit: async (input) => api.createKey(input.name.trim(), input.daily.trim() ? { dailyLimitUsdc: input.daily.trim() } : {}) });
    if (!values) return;
    await dialogs.custom((done) => <CreatedKey token={values.token} baseUrl={app.gatewayUrl} model={model} poolOn={poolOn} done={done} />);
    await reload();
    if (!pool || pool.state === 'none') await setup();
  }

  async function limits(apiKey) {
    const values = await dialogs.form({ title: t('Limits for “{0}”', apiKey.name), submitLabel: t('Save'),
      description: t('Caps on what this key can spend from the pool. Empty means no limit.'),
      fields: [{ name: 'daily', label: t('Daily limit (USDC)'), inputmode: 'decimal', value: apiKey.dailyLimitAtomic ? displayTokenAmount(apiKey.dailyLimitAtomic) : '', maxLength: 12 },
        { name: 'total', label: t('Total limit (USDC)'), inputmode: 'decimal', value: apiKey.totalLimitAtomic ? displayTokenAmount(apiKey.totalLimitAtomic) : '', maxLength: 12 }],
      onSubmit: async (input) => api.updateKey(apiKey.id, { dailyLimitUsdc: input.daily.trim() || null, totalLimitUsdc: input.total.trim() || null }) });
    if (values) await reload();
  }

  // Keys made before the pool returned had their own x402 channel.
  async function refundLegacy(apiKey) {
    const confirmed = await dialogs.confirm({ title: t('Refund “{0}”', apiKey.name), confirmLabel: t('Refund'), tone: 'neutral',
      description: t('This older key still holds {0} USDC on its own x402 channel. It goes back to your wallet in one transaction, no signature.', displayTokenAmount(apiKey.legacyChannel.unspentAtomic)) });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await api.keyRefund(apiKey.id);
      toast(result.refunded ? t('Refunded {0} USDC', displayTokenAmount(result.amountAtomic)) : t('Nothing to refund'), 'success');
      await reload();
    } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); }
  }

  async function revoke(apiKey) {
    const confirmed = await dialogs.confirm({ title: t('Revoke “{0}”', apiKey.name), confirmLabel: t('Revoke'),
      description: t('The key stops working at once. This cannot be undone; your pool and other keys are not affected.') });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await api.revokeKey(apiKey.id);
      toast(result.refund?.refunded ? t('Revoked; refunded {0} USDC', displayTokenAmount(result.refund.amountAtomic))
        : result.refund?.error ? t('Revoked; the refund failed: {0}', errorText(result.refund.error.code, result.refund.error.message)) : t('Revoked'), result.refund?.error ? 'warning' : 'success');
      await reload();
    } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <PageHead title={t('API keys')} description={t('Copy a key and call it like OpenAI. All your keys spend from one pool your wallet refills automatically, charged by actual tokens.')}
        actions={<Button variant="primary" onClick={create} disabled={busy}>{t('Create key')}</Button>} />
      {pool === null ? <Note tone="danger">{t('Automatic payment is not configured on this gateway.')}</Note> : null}
      <PoolCard pool={pool} busy={busy} onSetup={setup} onLimits={changeLimits} onAllowance={allowance} onWithdraw={withdraw} onCancel={cancelWithdrawal} />
      {keys.length === 0 ? (
        <Empty title={t('No API keys yet')} action={<Button variant="primary" onClick={create} disabled={busy}>{t('Create key')}</Button>}>
          {t('Create a key and turn on automatic payment once; every key works right away after that.')}
        </Empty>
      ) : (
        <section className="card flush">
          <Table headers={[t('Name'), { text: t('Today'), className: 'num' }, { text: t('Spent'), className: 'num' }, t('Limits'), t('Last used'), t('Status'), '']}>
            {keys.map((apiKey) => {
              const live = apiKey.state === 'active';
              const legacy = big(apiKey.legacyChannel?.unspentAtomic) > 0n;
              return (
                <tr key={apiKey.id} data-clickable onClick={() => setOpen(apiKey)}>
                  <td><strong>{apiKey.name}</strong><br /><small><Mono value={`${apiKey.prefix}_…`} /></small></td>
                  <td className="num">{displayTokenAmount(apiKey.spentTodayAtomic)}{apiKey.running ? <><br /><small>{t('{0} running', apiKey.running)}</small></> : null}</td>
                  <td className="num">{displayTokenAmount(apiKey.spentAtomic)}</td>
                  <td>{apiKey.dailyLimitAtomic || apiKey.totalLimitAtomic
                    ? [apiKey.dailyLimitAtomic ? t('{0}/day', displayTokenAmount(apiKey.dailyLimitAtomic)) : null, apiKey.totalLimitAtomic ? t('{0} total', displayTokenAmount(apiKey.totalLimitAtomic)) : null].filter(Boolean).join(' · ')
                    : '—'}</td>
                  <td title={formatDateTime(apiKey.lastUsedAt)}>{apiKey.lastUsedAt ? formatRelativeTime(apiKey.lastUsedAt) : '—'}</td>
                  <td>{!live ? <Badge tone="danger">{t('Revoked')}</Badge> : <Badge tone="success">{t('Active')}</Badge>}</td>
                  <td className="num" onClick={(event) => event.stopPropagation()}>
                    <div className="view-actions">
                      {live ? <Button size="sm" variant="ghost" onClick={() => limits(apiKey)} disabled={busy}>{t('Limits')}</Button> : null}
                      {legacy ? <Button size="sm" variant="ghost" onClick={() => refundLegacy(apiKey)} disabled={busy}>{t('Refund old balance')}</Button> : null}
                      {live ? <Button size="sm" variant="ghost" onClick={() => revoke(apiKey)} disabled={busy}>{t('Revoke')}</Button> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        </section>
      )}
      <section className="card">
        <div className="card-head"><div><h2>{t('Calling')}</h2><p>{t('OpenAI, Anthropic and Responses APIs; any compatible client only changes the base URL and key.')}</p></div></div>
        <CodeBlock samples={callSamples({ baseUrl: app.gatewayUrl, model })} />
        <Kv className="kv left" rows={[
          [t('Billing'), t('Each request holds an estimate of its cost; when it finishes the actual tokens are charged and the hold is released.')],
          [t('Concurrency'), t('Up to {0} requests at once per key, as far as the pool allows; a request that does not fit waits a few seconds for a refill.', terms.maxConcurrency)],
          [t('Where money goes'), t('Charges are debited from your pool to the Treasury in batches; the rest of the pool can only go back to your wallet.')],
          [t('Leaked key'), t('It can spend from the pool within your daily limit and the key\'s own limit, never move money elsewhere. Revoke it to stop it.')]
        ]} />
      </section>
      {open ? <RequestsDrawer apiKey={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
