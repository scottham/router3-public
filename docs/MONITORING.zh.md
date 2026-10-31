# 监控（Grafana Cloud）

[English](MONITORING.md)

数据流：`metrics` 导出器 → Grafana Alloy → Grafana Cloud。导出器与 Alloy 在本机 Compose 里，只向外推送，不开放端口，数据库也不对外。

- **`metrics`**（`ops/metrics-exporter.mjs`）：只读，不持有私钥。数据来源：
  - 数据库角色 `gateway_metrics`，只能执行 `private.metrics_snapshot()`、`private.metrics_x402()`、`private.metrics_provider_balance()`，返回汇总数字，不含地址、Key 或单个用户的数据；
  - RPC 上的 Treasury USDC、x402 合约 USDC、Settler MON（预付池交易需要 MON 付 gas）；
  - API 的健康检查、facilitator 的 `/supported`。
- **`alloy`**（`ops/alloy/config.alloy`）：每 30 秒抓一次导出器，每 60 秒抓一次主机 CPU、内存、磁盘，推到 Grafana Cloud。
- **面板**：`npm run grafana:dashboard` 生成并更新 "Router 3 · 运营总览"，放在 Router 3 文件夹。加 `--out file.json` 只生成文件，可手动导入。

## 配置（`.env.mainnet-local`）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL_METRICS` | `gateway_metrics` 角色，密码为 64 位十六进制，由 bootstrap 创建 |
| `GRAFANA_PROM_URL`、`GRAFANA_PROM_USER`、`GRAFANA_PROM_TOKEN` | Grafana Cloud → Prometheus → Details；token 只需 `metrics:write` |
| `GRAFANA_URL`、`GRAFANA_SA_TOKEN` | 只在更新面板时使用：Service account（Editor）的 token |
| `METRICS_INSTANCE` | 可选，`instance` 标签，默认 `router3-mainnet` |
| `METRICS_CHAIN_INTERVAL_SECONDS` | 可选，链上余额和区块高度的读取间隔，默认 300 秒 |

## 启动与更新

```bash
npm run mainnet:local:build && npm run mainnet:local:init-db   # 新迁移和 gateway_metrics 角色
npm run mainnet:local:metrics                                  # metrics + alloy
npm run grafana:dashboard                                      # 创建或更新面板
```

## 口径

- 请求、计费、服务费、供应商成本来自 `x402_requests`，是累计值，面板用 `increase()` 计算所选时段内的量。
- 耗时是近 15 分钟完成请求的 P50/P95，由数据库计算。
- 通道：开放通道数与存款、累计计费、已 claim 与待上链（已签凭证、尚未 claim，是 collector 宕机时的风险敞口）、链上取回中的通道、按上限收费的请求数、24 小时内链上操作、距上次 claim 的时间。
- 模型目录与价格、供应商对账：同步记录与余额差额，正数表示供应商扣费多于记录。
- 面板定义在 `ops/grafana-dashboard.mjs`，生成的 `ops/grafana/router3-dashboard.json` 一并提交到 git。
- 告警暂未配置。
