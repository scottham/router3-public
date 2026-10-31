# Dependency security

[中文](DEPENDENCY_SECURITY.zh.md)

Checked on 2026-10-31 against both committed lockfiles. Advisory counts can change. License review is separate; this update did not change licensing.

## Dependency updates

- Backend: x402 core/evm/fetch 2.29.0, Zod 4.6.7, Fastify 5.12.7, plus compatible fast-uri and ip-address updates. Root `npm audit`: 0 vulnerabilities.
- Frontend: Vite 6.4.5; WalletConnect ethereum/universal provider 2.26.0; abitype 1.3.0; uuid 11.1.1; vanilla-extract/css 1.21.3; follow-redirects 1.16.2. The WalletConnect update removed query-string/decode-uri-component. RainbowKit 2.2.11 and wagmi 2.19.5 remain peer-compatible.
- The CSS upstream replaced deepmerge with deepmerge-ts ([release notes](https://github.com/vanilla-extract-css/vanilla-extract/releases/tag/@vanilla-extract%2Fcss@1.21.3)).

`web/package.json` overrides upgrade transitive dependencies pinned by wallet connectors. The uuid override crosses a major version; review it when changing connectors. Audit counts alone do not establish compatibility. Remove overrides only after upstream uses safe versions, then rerun builds and wallet flows.

## Zod in wallet SDKs

Both lockfiles now pass `npm audit` with zero vulnerabilities. The frontend previously reported 12 affected packages from the same [Zod memory-exhaustion advisory, GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

The frontend overrides Zod to 4.6.7. CDP SDK is pinned to 1.59.0; `web/scripts/prepare-wallet-sdk.mjs` migrates its single-argument `z.record(value)` to `z.record(z.string(), value)` in both ESM and CommonJS builds. Preparation runs after `web:install` and before dev/build, and fails if the SDK version or expected code changes. Review the pin, compatibility patch and tests together when upgrading CDP.

Seven SDK tests check actual Zod resolution, valid/invalid CDP typed-data maps, Reown wallet and RPC payloads, ABI validation, and early rejection of oversized CDP policy collections. Every frontend build runs them. No advisory suppression, package alias or legacy `zod/v3` import is used.

## Rechecking

```bash
npm ci
npm run web:install
npm audit
npm --prefix web audit
npm run test:wallet-sdk
npm run verify
npm run web:build
npm run test:openai-sdk-compat
npm run test:pool-recovery-e2e
npm run test:redis-scaling
```

The last two tests need Docker; pool tests also need Foundry. Real CLI agent tests require a callable gateway and payment credentials: `npm run test:agent-e2e -- --agents` incurs real model charges. Headless EIP-1193 simulations do not replace testing real browser extensions or mobile wallets.

## Validation record

- `npm run verify`: 203 tests, syntax, package layout and local-secret scan passed. Wallet SDK compatibility: 7/7.
- OpenAI SDK compatibility: 13/13; contracts: 16/16, including fuzz tests.
- Real PostgreSQL/local Anvil pool-recovery E2E and Redis replica tests passed.
- Upgraded x402 SDK and pool passed read-only Monad mainnet-fork tests; transactions ran only on the local fork.
- Clean `npm ci` reproduced the frontend dependency graph; frontend and API/Web Docker builds passed.
- Headless Chromium with a simulated EIP-6963/EIP-1193 wallet completed discovery, connection, SIWE login, pool Configure and USDC permit. viem verified the signatures; four console routes had no page errors. Real extensions/mobile wallets were not tested.
- Real Claude Code/Codex coding and protocol E2E: 22/22, including eight parallel coding tasks using DeepSeek v4-pro, Kimi K3 and GLM 5.3. Isolated gateway, live upstreams: 73 calls, zero failed/running/unbilled calls, 0.494556 USDC charged. Temporary OpenRouter key deleted.
