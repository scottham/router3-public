import { useApp, useLoad } from '../context.js';
import { Button, CodeBlock, InlineCopy, Kv, PageHead, Skeleton } from '../ui.jsx';
import { callSamples, proxySamples, x402Samples } from '../snippets.js';
import { displayTokenAmount } from '../wallet-actions.js';
import { t } from '../i18n.js';

function Step({ index, title, body, children }) {
  return (
    <section className="card">
      <div className="card-head"><div><h2>{index}. {title}</h2>{body ? <p>{body}</p> : null}</div></div>
      {children}
    </section>
  );
}

export function Quickstart() {
  const app = useApp();
  const { data: models, loading } = useLoad(() => app.ensureModels().catch(() => []), []);
  if (loading) return <Skeleton rows={6} />;
  const model = models.find((item) => item.public_name.includes('flash'))?.public_name ?? models[0]?.public_name ?? 'deepseek/deepseek-flash';
  const baseUrl = app.gatewayUrl;
  const keyTerms = app.api.config.apiKeys ?? {};
  return (
    <div className="stack">
      <PageHead title={t('Quickstart')} description={t('Connect a wallet, turn on automatic payment once, create API keys, then call them like OpenAI.')} />
      <Step index={1} title={t('Get a wallet')} body={t('A wallet holding Monad Mainnet USDC (at least 1 for the gasless setup); no MON needed: the gateway pays the gas.')}>
        <Kv className="kv left" rows={[[t('Gateway'), <InlineCopy value={baseUrl} />], [t('Example model'), <InlineCopy value={model} />],
          [t('Per-request limit'), `${displayTokenAmount(keyTerms.requestLimitAtomic ?? '50000000')} USDC`]]} />
      </Step>
      <Step index={2} title={t('Turn on automatic payment and create a key')} body={t('On the API keys page: two signatures set a USDC allowance and the pool\'s refill target and daily limit; the pool fills within seconds. Keys are shown once and all spend from the pool.')}>
        <Button variant="primary" onClick={() => { window.location.hash = '#/keys'; }}>{t('Create an API key')}</Button>
      </Step>
      <Step index={3} title={t('Call')} body={t('OpenAI, Anthropic and Responses APIs. Claude Code, Codex or any SDK only changes the base URL and key.')}>
        <CodeBlock samples={callSamples({ baseUrl, model })} />
      </Step>
      <Step index={4} title={t('Billing and limits')}>
        <Kv className="kv left" rows={[
          [t('Billing'), t('Actual tokens × the model price, plus a separate service fee. A request holds an estimate first and is charged its actual cost when it ends; the hold is released at once.')],
          [t('Concurrency'), t('{0} requests at once per key by default, bounded by the pool: the holds of all running requests together cannot exceed what it can pay; a request that does not fit waits a few seconds for a refill.', keyTerms.maxConcurrency ?? 128)],
          [t('On-chain'), t('No transaction per call. Owed usage is debited with the next refill, at 1 USDC, or after a week, never above the daily limit.')],
          [t('Withdrawal'), t('Withdraw on the API keys page with one signature: owed usage is charged, and after the delay the rest goes back to your wallet.')],
          ['max_tokens', t('Forwarded as given. The hold counts at most {0} output tokens, so a large max_tokens does not tie up the balance; longer answers are still charged in full.', keyTerms.holdOutputTokens ?? 8192)],
          [t('Streaming'), t('stream: true is supported. The cost is in the gateway field of the last chunk.')],
          [t('Not supported yet'), t('Audio input and server-side tools such as web search.')]
        ]} />
      </Step>
      <Step index={5} title={t('Advanced: without an API key')} body={t('The private key stays on your machine: use the Foundation x402 SDK to sign a voucher for each call, or run the local proxy from the repository.')}>
        <CodeBlock samples={[...proxySamples({ baseUrl, model }), ...x402Samples({ baseUrl, model })]} />
      </Step>
    </div>
  );
}
