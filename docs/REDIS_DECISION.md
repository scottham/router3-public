# Redis and replica boundaries

[中文](REDIS_DECISION.zh.md)

Production Compose uses Redis even for one API replica. PostgreSQL remains the financial source of truth.

| Data / responsibility | Store | Replica behavior |
| --- | --- | --- |
| API rate limits | Redis Lua counters and TTL | Shared window by token prefix, x402 channel or source IP |
| Wallet availability, key budgets, holds, receivables | PostgreSQL | Account row locks, transactions and unique constraints; no Redis financial locks |
| x402 cumulative vouchers and pending settlement | PostgreSQL ChannelStorage | Channel row lock; one request per channel |
| Pool batches, nonce, signed bytes, receipts | PostgreSQL and on-chain batch/claim deduplication | Replay the same signed transaction; HTTP timeout does not erase receivables |
| Worker scheduling | PostgreSQL advisory/row locks | One catalog/reconciler round at a time; pool planning/confirmation recheck under account lock; signer/recovery share batch lock |

Model responses are not cached and requests cannot be replayed idempotently. Transaction idempotency does not provide API-call idempotency.

Redis database 0 serves the API, isolated by `REDIS_NAMESPACE`. It is private to Docker, password-protected, with AOF, a 256 MiB cap and `noeviction`. All API replicas of a deployment must use the same namespace.

Unavailable/slow/failed Redis writes reject new requests with 503 before business handling; there is no per-process fallback. `/healthz` remains live, `/readyz` returns 503. Already dispatched calls still bill actual usage, and collector/signer continue existing receivables. AOF fsyncs every second; a crash may lose about one second of rate counts. Redis loss cannot erase PostgreSQL bills, holds or signing records.

Scale APIs with the same image and private configuration:

```bash
docker compose --env-file .env.mainnet-local -f docker-compose.production.yml up -d --scale api=2 api
```

`ops/deploy-api.sh` currently accepts at most one old API instance. Existing multi-replica deployments need their own per-instance readiness/draining orchestration. Nginx resolves API replicas through Docker DNS. Do not generate separate databases, HMACs or encryption keys for replicas, or expose internal API/signer/Redis ports. External proxies need explicit trusted-source and real-IP rules; client-supplied forwarding headers cannot be trusted directly.

Financial transactions for one wallet queue on its account row lock. More API replicas do not remove this boundary. Plan connections as replicas × per-instance pool size; measure lock waits and connection usage before scaling.

The supplied single PostgreSQL/Redis stack has no HA guarantee. Multi-host deployment also needs load balancing, database HA/PITR, Redis HA/TLS, private networking and monitoring. Both `redis://` and `rediss://` URLs are supported.

## Validation

```bash
npm run test:redis-scaling
npm run test:pool-recovery-e2e
```

The Redis test uses a disposable server and two API instances to check shared limits, fail-closed outages, AOF recovery and window expiration. The pool test uses disposable PostgreSQL, local Anvil and the full API, including `test:pool-db`, for financial consistency/recovery. Mock inference, no paid provider calls or mainnet transfers. Docker is required; pool tests also need Foundry and a local PostgreSQL image.
