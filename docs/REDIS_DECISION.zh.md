# Redis 与多副本边界

[English](REDIS_DECISION.md)

Redis 是生产 Compose 的依赖，单副本也使用相同的共享频率限制。财务真值在 PostgreSQL。

| 数据/职责 | 组件 | 多副本行为 |
| --- | --- | --- |
| API 频率限制 | Redis Lua 原子计数与 TTL | API Key 按 Token 前缀分桶，x402 按通道，其他请求按来源 IP；副本共用窗口 |
| 钱包可付额、Key 额度、冻结、应收 | PostgreSQL | 池账户行锁、事务与唯一约束；不依赖 Redis 锁 |
| x402 累计凭证与待结算 | PostgreSQL ChannelStorage | 通道行锁，同一通道同时一个请求 |
| 池批次、nonce、签名交易、回执 | PostgreSQL 与链上 batch/claim 去重 | 相同批次重播同一签名交易；HTTP 超时不删除应收 |
| worker 调度 | PostgreSQL advisory / row locks | catalog/reconciler 每轮单实例；池计划与确认在账户锁下重查，signer 与失败恢复共用批次锁 |

不缓存模型响应，也不提供请求幂等重放；签名交易的幂等性不能替代 API 调用的幂等性。

Redis 0 库用于 API，通过 `REDIS_NAMESPACE` 隔离部署。仅在私有 Docker 网络开放，密码认证、AOF、256 MiB 上限、`noeviction`。不要让不同实例的 API 副本使用不同命名空间。

Redis 不可达、超时或写入失败时，新请求在进入业务前返回 503，不退回进程内配额；`/healthz` 保持存活，`/readyz` 返回 503。已派发调用仍须按实际 usage 记账，collector/signer 独立继续处理已有应收。AOF 默认每秒刷盘，骤停可能丢失约一秒的频率计数；Redis 数据丢失不会删除 PostgreSQL 账单、冻结或签名记录。

使用同一镜像和同一私密配置增加 API 副本：

```bash
docker compose --env-file .env.mainnet-local -f docker-compose.production.yml up -d --scale api=2 api
```

`ops/deploy-api.sh` 当前要求至多一个旧 API，不能直接用于已有多个 API 副本的部署；多副本需自行编排逐实例就绪与排空。Nginx 经 Docker DNS 解析 API 副本。不要为副本生成新的数据库、HMAC 或加密密钥，不要暴露 API、signer、Redis 内部端口。加入外部反向代理时需明确可信来源和真实 IP 规则，不能直接信任客户端传来的转发头。

同一钱包的财务事务在账户行锁上排队，增加 API 副本不会消除这个边界。连接数按“副本数 × 每实例连接池”规划，扩容前测事务等待及连接占用。

随附单 PostgreSQL、单 Redis 适用于单机部署，没有高可用保障。跨机器扩容还需负载均衡、数据库 HA/PITR、Redis HA/TLS、私网和监控；应用支持 `redis://` 与 `rediss://`。

## 验证

```bash
npm run test:redis-scaling
npm run test:pool-recovery-e2e
```

第一项使用临时 Redis 与两个 API 实例验证共享额度、断开失败关闭、AOF 恢复及窗口过期。第二项使用临时 PostgreSQL、本地 Anvil 与完整 API 验证池财务一致性和恢复；内部包含 `test:pool-db`。模型均使用 mock，不产生供应商付费推理或主网转账。需 Docker；池测试另需 Foundry 和本地 PostgreSQL 镜像。
