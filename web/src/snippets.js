import { t } from './i18n.js';

// Call samples. With an API key any OpenAI, Anthropic or Responses client
// calls the gateway directly; the key's channel pays. Without one, the local
// proxy holds the wallet key and pays per call.
export function gatewayBaseUrl(apiBaseUrl) {
  return `${String(apiBaseUrl ?? '').replace(/\/+$/, '')}/v1`;
}

export const KEY_PLACEHOLDER = 'r3_live_…';
const HELLO = t('Hello');

export function callSamples({ baseUrl, model = 'deepseek/deepseek-flash', apiKey = KEY_PLACEHOLDER }) {
  const origin = baseUrl.replace(/\/v1$/, '');
  return [
    {
      label: 'Python',
      code: `from openai import OpenAI

client = OpenAI(base_url="${baseUrl}", api_key="${apiKey}")

stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${HELLO}"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`
    },
    {
      label: 'Node.js',
      code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "${apiKey}" });

const completion = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "${HELLO}" }],
});
console.log(completion.choices[0].message.content, completion.gateway);`
    },
    {
      label: 'Claude Code',
      code: `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="${apiKey}"
export ANTHROPIC_MODEL="${model}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"
claude`
    },
    {
      label: 'Codex',
      code: `# ~/.codex/config.toml
model = "${model}"
model_provider = "router3"
web_search = "disabled"

[model_providers.router3]
name = "Router 3"
base_url = "${baseUrl}"
env_key = "ROUTER3_API_KEY"   # export ROUTER3_API_KEY="${apiKey}"
wire_api = "responses"`
    },
    {
      label: 'cURL',
      code: `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${HELLO}"}]
  }'`
    }
  ];
}

const PROXY = 'http://127.0.0.1:8402';

// Without an API key: the local proxy signs every call with the wallet key.
export function proxySamples({ baseUrl, model = 'deepseek/deepseek-flash' }) {
  const origin = baseUrl.replace(/\/v1$/, '');
  return [
    {
      label: t('Proxy'),
      code: `# ${t('The local proxy is in the repository (clients/x402-proxy); clone it, then:')}
git clone https://github.com/scottham/router3-public && cd router3-public && npm ci
export ROUTER3_PAYER_KEY_FILE=~/.router3/payer.key   # ${t('wallet private key holding Monad USDC')}
node clients/x402-proxy/cli.mjs serve --gateway ${origin} --port 8402

# ${t('Then point any OpenAI-compatible client at the local proxy; concurrent calls open a channel each')}
# ${t('Refund every channel:')}
node clients/x402-proxy/cli.mjs refund --all --gateway ${origin}`
    },
    {
      label: 'Python',
      code: `from openai import OpenAI

client = OpenAI(base_url="${PROXY}/v1", api_key="x402")

stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${HELLO}"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`
    },
    {
      label: 'Node.js',
      code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${PROXY}/v1", apiKey: "x402" });

const completion = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "${HELLO}" }],
});
console.log(completion.choices[0].message.content, completion.gateway.x402);`
    },
    {
      label: 'Claude Code',
      code: `export ANTHROPIC_BASE_URL="${PROXY}"
export ANTHROPIC_AUTH_TOKEN="x402"
export ANTHROPIC_MODEL="${model}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"
claude`
    },
    {
      label: 'Codex',
      code: `# ~/.codex/config.toml
model = "${model}"
model_provider = "router3"
web_search = "disabled"

[model_providers.router3]
name = "Router 3"
base_url = "${PROXY}/v1"
env_key = "ROUTER3_PROXY_TOKEN"   # ${t('any value; the proxy does not check it')}
wire_api = "responses"`
    },
    {
      label: 'cURL',
      code: `curl ${PROXY}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${HELLO}"}]
  }'`
    }
  ];
}

// Paying directly with the Foundation SDK instead of the proxy: it answers
// the 402, opens the channel on first use and signs one voucher per request.
// One scheme instance is one channel; concurrent requests need one each.
export function x402Samples({ baseUrl, model = 'deepseek/deepseek-flash' }) {
  const origin = baseUrl.replace(/\/v1$/, '');
  return [
    {
      label: 'Node.js (SDK)',
      code: `import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";

// A wallet holding USDC on Monad (or a session key: set payerAuthorizer below).
const account = privateKeyToAccount(process.env.PAYER_KEY);
const signer = toClientEvmSigner(account, createPublicClient({ chain: monad, transport: http() }));
const client = new x402Client().register("eip155:143",
  new BatchSettlementEvmScheme(signer, { storage: new FileClientChannelStorage({ directory: ".x402" }) }));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const response = await fetchWithPay("${origin}/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "${model}", messages: [{ role: "user", content: "${HELLO}" }] })
});
const body = await response.json();
console.log(body.choices[0].message.content, body.gateway.x402);`
    },
    {
      label: t('cURL (402 quote)'),
      code: `# ${t('A request without a payment header gets the quote: PAYMENT-REQUIRED carries the ceiling, payee and channel terms')}
curl -i ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "${HELLO}"}]}'

# ${t('Channel terms')}
curl ${origin}/v1/x402`
    }
  ];
}
