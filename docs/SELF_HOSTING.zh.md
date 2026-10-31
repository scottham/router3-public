# 独立部署

[English](SELF_HOSTING.md)

一套部署 = 一个收款钱包（Treasury）+ 一个自己的预付池合约 + 供应商 Key。Settler 签名钥匙、数据库角色、各类密钥都由脚本生成。x402 自签通道用基金会的 `x402BatchSettlement`，不用部署，facilitator 付 gas；API Key 走预付池，Settler 要有少量 MON 付 `settle` 的 gas。

## 准备

- 一台能跑 Docker 的主机，Node.js 22+，域名和 HTTPS（或 [Cloudflare Tunnel](CLOUDFLARE.zh.md)）。不需要 Foundry。
- 收款钱包地址（建议多签或硬件钱包，私钥不在服务器上）。
- 一把有约 0.5 MON 的钱包私钥，只用来部署合约，部署完从 `.env` 删掉。
- DeepSeek Key；可选 OpenRouter 管理 Key（管理 Key，不是调用 Key）。

## 四步

```bash
npm ci                   # 只装脚本依赖；web 在 Docker 里构建
cp .env.example .env     # 填 TREASURY_ADDRESS、MONAD_RPC_URL、DEEPSEEK_API_KEY、OPENROUTER_MANAGEMENT_KEY、DEPLOYER_PRIVATE_KEY
npm run pool:deploy                                             # 1. 部署预付池，POOL_ADDRESS / POOL_CODE_HASH 写回 .env
npm run mainnet:local:configure -- --public https://你的域名     # 2. 生成 .env.mainnet-local：Settler 钥匙、密码、供应商 Key 文件、正式域名
npm run mainnet:local:build && npm run mainnet:local:init-db    # 3. 镜像、迁移、角色、目录、费率
npm run mainnet:local:start                                     # 4. db redis api signer collector reconciler catalog web
```

第 2 步结束会打印 Settler 地址和 MON 余额：给它转约 1 MON（每天 gas 预算默认 5 MON，实际用量远小于此）。

然后：

```bash
curl -s https://你的域名/v1/x402 | jq .ready      # true：facilitator 条款已加载
npm run mainnet:local:tunnel                      # 可选：Cloudflare Tunnel（.env 里 CLOUDFLARE_TUNNEL_TOKEN）
npm run mainnet:local:check-keys                  # 供应商 Key 可用性
```

- 合约不可升级、没有管理员提款；[contracts/README.md](../contracts/README.md) 写了构造参数、`npm run contracts:verify` 核对线上字节码的方法，以及手动 `forge create` 的等价命令。
- 已有预付池时不用部署：把地址和代码哈希写进 `.env` 的 `POOL_ADDRESS`、`POOL_CODE_HASH` 即可。`pool:deploy` 不会覆盖已有的 `POOL_ADDRESS`（池里是用户的钱，新池是空的），除非 `--force`。
- 重跑 `configure` 会保留已生成的密码、HMAC、加密密钥和 Settler 文件，但 `.env` 中的 Treasury、RPC、预付池、白名单及供应商 Key 等可覆盖现有配置；重跑前核对来源。`--public` 只在要改域名时再传。
- `providers/providers.mainnet.json` 决定接哪些供应商与模型，见 [供应商](PROVIDERS.zh.md)；供应商 Key 在 `.secrets/providers.env`，由 api、collector、catalog 和 bootstrap 读取（collector 用管理 Key 同步钱包额度）。
- `.env` 里的其余可选项见 `.env.example` 和 [配置清单](CONFIGURATION_CHECKLIST.zh.md)。

## 更新

先核对该版本的迁移是否兼容仍在处理请求的旧 API；破坏性迁移须安排维护窗口。以下顺序用于当前预付池批次恢复升级，旧 signer 不能与新恢复逻辑混跑。保留旧镜像和私密配置用于应用回退。

```bash
git pull
npm ci
npm run verify
npm run mainnet:local:backup       # 失败即停止更新，备份保留在主机外
npm run mainnet:local:build        # 构建新镜像后再停止 worker
```

接着逐步执行，任何一步失败都先排查，不继续启动后面的组件：

```bash
compose() { docker compose --env-file .env.mainnet-local -f docker-compose.production.yml "$@"; }
compose stop collector reconciler catalog
npm run mainnet:local:init-db      # 应用全部迁移、角色授权、目录与费率；不可省略
compose up -d --no-deps --force-recreate signer
# 在容器内使用它自己的 token 检查 signer，不把 token 打印到终端
compose exec -T signer node --input-type=module -e '
for (let i = 0; i < 30; i++) {
  const ok = await fetch("http://127.0.0.1:8790/healthz", {
    headers: {authorization: "Bearer " + process.env.SETTLER_SIGNER_BEARER_TOKEN},
    signal: AbortSignal.timeout(2000)
  }).then(r => r.ok, () => false);
  if (ok) process.exit(0);
  await new Promise(r => setTimeout(r, 1000));
}
process.exit(1);'
ops/deploy-api.sh                  # 新 API 就绪后排空旧实例，在途流可完成
compose up -d --no-deps --force-recreate collector reconciler catalog web
npm run mainnet:local:status
curl --fail --silent https://你的域名/readyz
```

迁移或 signer 检查失败时保持 collector/reconciler 停止，修复后从失败步骤继续。应用镜像回退不等于数据库回退，不要直接把升级前的库备份覆盖到仍在接收请求的生产库。备份恢复验证见 `npm run test:mainnet-backup`。

## 验收

```bash
npm run test:x402-live   # 用一个有 USDC 的钱包（.env 里 PRIVATE_KEY）走一遍存款、调用、退款、settle
```

## 运维边界

- 资金：用户的钱在合约里，平台只在 settle / claim 后才拿到；Treasury 收到的就是收入。
- facilitator：默认用 Monad 基金会的免费实例；要自己跑一个时用 `@x402/core` 的 facilitator 代码和一把有 MON 的中继钱包，改 `X402_FACILITATOR_URL`。
- 监控：[监控](MONITORING.zh.md)；备份：`npm run mainnet:local:backup`，恢复验证 `npm run test:mainnet-backup`。
- 条款：转售模型 API 的责任在部署者，见 [供应商](PROVIDERS.zh.md)。
