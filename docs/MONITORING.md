# Monitoring with Grafana Cloud

[中文](MONITORING.zh.md)

Data flows from the `metrics` exporter to Grafana Alloy, then to Grafana Cloud. Exporter and Alloy run in local Compose and push outbound. No monitoring or database ports are published.

- **Exporter** (`ops/metrics-exporter.mjs`): read-only, no private key or transactions. Sources:
  - `gateway_metrics` may execute only `private.metrics_snapshot()`, `private.metrics_x402()` and `private.metrics_provider_balance()`. Results are aggregates without wallet addresses, keys or individual user data.
  - Treasury USDC, x402 contract USDC and Settler MON balances. The Settler needs MON for pool transactions.
  - API readiness and facilitator `/supported` probes.
- **Alloy** (`ops/alloy/config.alloy`): scrapes the exporter every 30 seconds and host CPU/memory/disk every 60 seconds, then pushes to Grafana Cloud.
- **Dashboard:** `npm run grafana:dashboard` creates/updates the Router 3 operations dashboard in the Router 3 folder. `--out file.json` generates a file for manual import without updating Grafana.

## Configuration: .env.mainnet-local

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL_METRICS` | `gateway_metrics` connection; 64-character hexadecimal password; bootstrap creates the role |
| `GRAFANA_PROM_URL`, `GRAFANA_PROM_USER`, `GRAFANA_PROM_TOKEN` | Grafana Cloud Prometheus details; token needs only `metrics:write` |
| `GRAFANA_URL`, `GRAFANA_SA_TOKEN` | Dashboard updates only; Editor service-account token |
| `METRICS_INSTANCE` | Optional `instance` label (default `router3-mainnet`) |
| `METRICS_CHAIN_INTERVAL_SECONDS` | Optional chain balance/block polling interval (300 seconds) |

## Start and update

```bash
npm run mainnet:local:build && npm run mainnet:local:init-db   # migrations and metrics role
npm run mainnet:local:metrics                               # metrics + alloy
npm run grafana:dashboard                                   # create/update dashboard
```

## Metric definitions

- Request, charge and provider-cost series in the x402 panels come from `x402_requests`. Counters are cumulative; dashboard `increase()` calculates selected-period totals.
- Latency is the database-calculated P50/P95 of requests completed in the last 15 minutes.
- Channel panels show open channel count/deposits, cumulative charges, claimed/unclaimed amounts, pending withdrawals, ceiling-charged calls, chain operations over 24 hours and time since the last claim. Unclaimed usage remains at risk until collector confirmation.
- Catalog and provider reconciliation show sync runs and balance differences; positive gaps mean the provider charged more than the recorded cost.
- Dashboard definitions are in `ops/grafana-dashboard.mjs`; generated `ops/grafana/router3-dashboard.json` is committed.
- Alert rules are not configured yet.
