# Model providers

[中文](PROVIDERS.zh.md)

The gateway calls upstream APIs directly. Each deployment declares provider instances in `providers.json`; the type determines pricing, protocol forwarding and billing.

| Type | Price source | Billing basis | Credential |
| --- | --- | --- | --- |
| `deepseek` | Official Chinese price page, synced daily with time-of-use rates and ECB FX | Reported token usage × price version | `DEEPSEEK_API_KEY` |
| `openrouter` | Model API, synced daily with pinned serving hosts | Actual reported cost (`usage.cost`) | Management key creates a call key per payer wallet |
| `openai-compatible` | Reviewed static prices in configuration | Token usage × price | Provider API key |

All support `/v1/chat/completions`. DeepSeek/OpenRouter also forward `/v1/messages` (Anthropic) and `/v1/responses` in their native formats to the provider's compatible endpoints.

## providers.json

```json
{
  "providers": [
    { "id": "deepseek", "type": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    { "id": "openrouter", "type": "openrouter", "managementKeyEnv": "OPENROUTER_MANAGEMENT_KEY",
      "payerKeyLimitUsd": 50,
      "allowedFamilies": ["anthropic", "openai", "google"],
      "allowedModels": [{ "id": "deepseek/deepseek-v4.1-flash", "provider": "Relace" }] }
  ],
  "entries": []
}
```

- `allowedFamilies` selects model vendor prefixes, excluding `:batch`/`:free` variants. `allowedModels` adds individual IDs; an object can pin a host. Public names use `openrouter/<id>`.
- The management key reads `/models/user`, so models follow account privacy/ZDR settings. Models without an available host are excluded.
- Candidate hosts include the vendor and its first-party clouds (Claude: Anthropic/Bedrock/Vertex/Azure; GPT: OpenAI/Azure; Gemini: AI Studio/Vertex), then other hosts. Candidates must be within 1.5× the cheapest vendor-hosted price, with at most eight. Without a vendor host, use the cheapest host as baseline. Priority, `/fast` and flex tiers are excluded. Requests restrict endpoint labels with `provider.only`, disable fallbacks and obey account ZDR policy. Explicit-cache routes allow sticky routing; others retain `provider.order`.
- Displayed price uses the first candidate; holds use the most expensive candidate; charges use reported cost.
- Hosts with per-request fees are excluded. Per-image-priced models have image input disabled; other OpenRouter image holds use 4000 tokens/image and bill reported cost.
- `PROVIDER_CONFIG_FILE` mounts the configuration. `PROVIDER_ENV_FILE` supplies referenced variables to API, collector, catalog and bootstrap; collector uses the management key for wallet limit sync.

## OpenRouter wallet keys

- The management key manages keys, never completions. On a wallet's first OpenRouter call, the gateway creates `router3:<site-host>:<wallet-address>`. Its limit follows the pool daily limit and resets daily; without a pool, use `payerKeyLimitUsd` (USD). The encrypted call key is stored in `private.provider_payer_keys`.
- Collector synchronizes limits after confirmed wallet configuration. Catalog checks every `PROVIDER_KEY_SYNC_SECONDS` (3600), records remote usage, restores configured limits and marks remotely deleted keys `deleted`.
- A same-name remote key with no locally saved secret (lost creation response) is deleted and recreated, not reused.
- Before deployment, `ops/check-provider-keys.mjs` lists keys with the management key and models with the DeepSeek key. Failure prevents deployment.

## Billing and reconciliation

- OpenRouter requests include `usage: {include: true}`. Reported `cost` (in the final SSE chunk for streams) is billed plus service fee, recorded as `billed_from=provider_cost`. Missing cost falls back to the price version (`billed_from=price_table`).
- Holds use price-version estimates for input bytes and output limits; API keys cap held output at `API_KEY_HOLD_OUTPUT_TOKENS`.
- Daily catalog sync records provider balances: DeepSeek in CNY, OpenRouter in USD. Grafana shows the difference between balance reduction and recorded cost between checks.
- Remote usage counters on each wallet's OpenRouter key can be compared with the gateway's recorded provider costs for that wallet.

## Prompt caching

Cache policy comes from the selected endpoints' `supports_implicit_caching` flag and cache prices, not model-name rules. Implicit caches keep the prompt and preferred host order unchanged. For explicit caches with write pricing, a five-minute breakpoint marks reusable history or instructions, leaving the newest input uncached. A single input without separate context is unchanged. Mixed or unknown capabilities do not trigger a default directive. Client cache directives and session keys are preserved; `cache_control: null` disables the default. Explicit-cache routes retain the quoted host allowlist and allow OpenRouter's sticky routing.

Holds cover the quoted write rate, including any input charge when a write quote covers only storage. One-hour writes require a published one-hour rate. OpenRouter billing uses the upstream cost receipt.

Live check: `MCG_API_KEY_FILE=/path/to/key npm run test:prompt-cache-e2e`. By default it covers eight models across all three APIs, using real credits with a 0.5 USDC test budget. `MCG_CACHE_MODELS` and `MCG_CACHE_PROTOCOLS` select a subset. The warm request changes its final question while reusing context. Assertions require substantial prefix cache hits and lower charges; implicit caches need not report write counts.

## Provider terms

Operators are responsible for ensuring provider agreements allow their intended use, including resale. Check current provider terms and any required enterprise agreement. OpenRouter account privacy/ZDR changes take effect in host selection after the next catalog sync; rerun catalog to refresh immediately.
