# Known limitations

[中文](KNOWN_LIMITATIONS.zh.md)

API keys charge a shared wallet prepaid pool. Advanced clients sign x402 channel vouchers themselves.

1. Metering requires trust in the operator: token usage cannot be proven on chain. x402 bounds claims by the user-signed ceiling; the pool enforces wallet daily limits, refill rules and the fixed Treasury. Key limits are gateway policy. Admins can authorize another settler that bypasses gateway policy but not contract limits. Unknown usage is charged at the ceiling without a later refund.
2. Each x402 channel handles one request at a time. Concurrency needs separate deposits in a channel pool, up to 128 channels per wallet. API keys default to 128 concurrent requests per key against the shared pool.
3. After an x402 streaming call, the next request needs a corrective 402 round trip and a client able to read chain state.
4. x402 refunds require one transaction per channel. The proxy runs `refund --all` sequentially; browser wallets sign once per channel. Pool withdrawal requires a wallet signature and delay; revoking a key does not withdraw the shared pool. Direct on-chain user operations need MON.
5. The Foundation facilitator has no SLA or published rate guarantee. During outages, x402 deposits/claims/refunds queue. Fresh mirrors can verify some calls locally; stale mirrors and remote-verification paths fail. Pool settlement uses signer/RPC separately. Self-hosting a facilitator requires relay gas (historically about 0.02–0.03 MON/transaction).
6. The Settler key is a file in the signer container, not KMS/HSM. New API keys have no voucher authorizer. `RESPONSE_ENCRYPTION_KEYS` still protects provider keys and legacy refund keys and needs secure backup/rotation.
7. Public Monad RPC is the default; production should use a dedicated endpoint. Public endpoints provide no capacity/availability guarantee.
8. The reference site is router3.ai. No separate staging environment is supplied. Single PostgreSQL/Redis instances do not provide HA.
9. Console login/signing has been tested with headless simulated wallets, mock data and mainnet forks, not real wallet extensions. Mobile wallets need `WALLETCONNECT_PROJECT_ID`.
10. Audio input, server-side tools such as web search, and unpriced special service tiers are unsupported.
11. Reported provider usage/cost still needs reconciliation against provider invoices.
12. There are no automatic retries or cross-model fallbacks.
13. Cache behavior follows upstream endpoint capabilities; mixed or unknown capabilities do not trigger default cache directives. Explicit writes require a quoted write rate, including a one-hour rate for that TTL. Cache availability, minimum prefix sizes and retention remain provider-dependent. OpenRouter bills reported cost; rates vary by model/host.
14. Fan-out parameters such as `n` and `best_of` are dropped rather than rejected.
15. With OpenRouter `zeroDataRetention: true`, hosts are selected from its ZDR endpoints. With `probeHosts: true`, each selected host gets a weekly 16-token probe using a temporary $1 key deleted afterwards. 400/403/404 hosts are excluded (for example BYOK-only endpoints); 429/timeouts wait for the next probe. Model/privacy changes take effect after catalog refresh (daily).
16. Smart-wallet payers with zero `payerAuthorizer` require facilitator ERC-1271 verification on every request.
17. Legal obligations, sanctions screening, tax, refunds and provider resale agreements remain the operator's responsibility.
18. Holds and charges serialize on the wallet account row. Heavy concurrency for one wallet queues there; individual lock transactions are short, but latency grows with contention.
19. API key holds are estimates: input bytes ÷ 3, output capped at `API_KEY_HOLD_OUTPUT_TOKENS` (8192), forwarded `max_tokens` unchanged. Actual cost above the hold is collected only within pool availability and key daily/total budgets after reserving other key holds. The operator bears recorded unbilled overruns. Reaching a key limit does not interrupt dispatched responses.
20. A refill requires an on-chain transaction (typically 1–2 seconds). A call may wait when availability runs out; very small refill targets constrain concurrency.
21. The Settler pays pool gas (a measured settle was about 0.025 MON). Low balance or exhausted gas budgets defer refills/debits; calls continue only while availability remains.
22. Zod 3 in wallet SDKs has an unresolved advisory. The frontend's 12 high-severity affected packages propagate one advisory; backend audit is clean as of the recorded check. See [dependency security](DEPENDENCY_SECURITY.md).
