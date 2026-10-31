# 依赖安全状态

[English](DEPENDENCY_SECURITY.md)

2026-10-31 检查；计数基于提交的两个 lockfile，后续公告可能变化。许可证评估另行处理，本轮未调整许可证。

## 本轮更新

- 后端：x402 core/evm/fetch 2.29.0、Zod 4.6.7、Fastify 5.12.7，并更新兼容范围内的 fast-uri 和 ip-address。根目录 `npm audit` 为 0。
- 前端：Vite 6.4.5；WalletConnect ethereum/universal provider 2.26.0；abitype 1.3.0；uuid 11.1.1；vanilla-extract/css 1.21.3；follow-redirects 1.16.2。旧 query-string/decode-uri-component 随 WalletConnect 更新移出依赖树。保留 RainbowKit 2.2.11 与 wagmi 2.19.5 的 peer 兼容关系。
- CSS 上游通过替换 deepmerge 依赖修复相关告警，见 [官方发布说明](https://github.com/vanilla-extract-css/vanilla-extract/releases/tag/@vanilla-extract%2Fcss@1.21.3)。

`web/package.json` 的 overrides 用于升级钱包连接器锁定的间接依赖。它们包含跨大版本的 uuid，需要在后续调整连接器时复查；不能只看 audit 计数就认定兼容。移除 overrides 前需确认上游已经使用安全版本，并重跑构建与钱包流程。

## 钱包 SDK 的 Zod

两个 lockfile 的 `npm audit` 现均为 0。前端此前的 12 个受影响包均来自同一条 [Zod 内存耗尽公告 GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。

前端通过 override 使用 Zod 4.6.7。CDP SDK 固定为 1.59.0；`web/scripts/prepare-wallet-sdk.mjs` 将其 ESM 和 CommonJS 中的单参数 `z.record(value)` 改为 `z.record(z.string(), value)`。准备步骤在 `web:install` 后及 dev/build 前执行；SDK 版本或预期代码变化时会报错。后续升级 CDP 时需同时复查版本固定、兼容修正和测试。

新增 7 项 SDK 测试，检查实际 Zod 解析路径、CDP 类型映射的合法与非法输入、Reown 钱包和 RPC 数据、ABI 校验，以及 CDP 对超长策略集合的提前拒绝。每次前端构建都会执行这些测试。未忽略审计、使用包别名或导入旧 `zod/v3` 实现。

## 复查命令

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

后两项需要 Docker，池测试还需要 Foundry。真实 CLI agent 测试另外需要可调用的网关及付款凭据，使用 `npm run test:agent-e2e -- --agents`；它会产生真实模型费用。钱包无头浏览器与模拟 EIP-1193 流程不能替代真实手机钱包/插件验收。

## 本轮验证记录

- `npm run verify`：203 项测试通过，语法、包结构和本地密钥扫描通过。钱包 SDK 兼容测试 7/7。
- OpenAI SDK 兼容测试：13/13；合约：16/16（含 fuzz）。
- 真实 PostgreSQL + 本地 Anvil 的池恢复 E2E、Redis 多副本测试通过。
- 升级后的 x402 SDK 与预付池均通过 Monad 主网只读分叉测试；交易仅在本地分叉执行。
- 干净 `npm ci` 复现前端依赖树；前端生产构建及 API/Web Docker 镜像构建通过。
- 无头 Chromium 使用模拟 EIP-6963/EIP-1193 钱包完成发现、连接、SIWE 登录、池 Configure 与 USDC permit；签名经 viem 验证，四个控制台路由无页面错误。未验证真实插件或手机钱包连接。
- 真实 Claude Code/Codex 编程与协议 E2E：22/22，含 8 个并行编程任务；DeepSeek v4-pro、Kimi K3、GLM 5.3。隔离网关使用真实上游，共 73 次调用、0 失败/运行中/未收费用，收费 0.494556 USDC；临时 OpenRouter 子 Key 已删除。
