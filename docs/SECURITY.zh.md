# 安全设计

[English](SECURITY.md)

## 核心威胁

1. 平台多扣：claim 超过用户签过的金额，或退款时少退；
2. 平台少收：API 被攻破后签出不该签的 claim/退款，或请求不记账；
3. SIWE challenge 重放、错误 domain/chain 或伪造智能账户签名；
4. 凭证重放、同一通道并发争抢、过期凭证；
5. 供应商超时造成错误免费或重复收费；
6. Settler 私钥、signer 或数据库角色越权；
7. Prompt、响应、供应商 Key、Cookie 或连接串泄漏；
8. 客户注入 `api_base`、凭证、mock、重试或 fallback，绕过模型目录和计费；
9. 客户用 `n`/`best_of` 等扇出参数让一次上限支付多份补全；
10. 数据库异常原文经错误响应泄漏内部 Schema；
11. 上游错误消息把平台供应商账户状态泄漏给客户；
12. API Key 泄露，或数据库与加密钥匙一起泄露。

## 已实现控制

- 合约层面：x402 只能 claim 到用户签过的累计金额；预付池限制每日扣款、单笔扣款、补充目标及固定 Treasury；退款只回本人。用户可直接在链上发起和执行到期取回。池管理员可授予/撤销 Settler 和管理员角色，新增 Settler 能绕过网关签名策略，仍受合约约束；计量需要信任运营者和管理员。
- signer 是唯一持有 Settler 私钥的进程。x402：只签 `ClaimBatch` 和 `Refund` 两种 EIP-712 类型，域固定为合约与 chain 143；claim 不超过镜像里的累计实付、凭证必须是镜像保存的那张，退款不超过存款减实付。预付池：只发 `settle`、用户签过名的 `permit` / `configureBySig` / `requestWithdrawalBySig` / `cancelWithdrawalBySig`、到期的 `withdraw(owner)` 和 `sweep()`；调用数据由 signer 自己从数据库那一行重建，签名前核对预付池代码哈希、Treasury、USDC 与 Settler 角色；nonce 和签好的交易先入日志再广播；每日 gas 与 USDC 有上限。合约本身限制每日扣款额，钱只能进 Treasury 或回到用户钱包。
- 凭证核验：镜像新鲜时本地验签，否则 facilitator 读链；累计额不匹配即拒绝（重放、过期、并发）；同一通道同时一个请求。
- 用量未知（流被中断、超时、客户端断开）按用户签过的上限收费，不当作免费；供应商在收费前拒绝的才取消。
- 付款人白名单 `AUTH_ALLOWED_ADDRESSES` 在任何状态被改动前拒绝；每钱包通道数上限；单次上限；API Key 速率限制按 Key 分桶，x402 按通道分桶。
- 平台不接触用户钱包的私钥或助记词；本地代理在用户自己的机器上持钥。
- API Key：数据库只存 Token 的 HMAC，新 Key 不生成代签授权钥匙，直接从钱包共享预付池扣费。请求开始与结束均在账户锁内校验当前 Key 的每日/总硬额度，给同 Key 的其他在途请求保留冻结额；超出可收金额的费用由部署者承担并记为未收。撤销立即阻止新调用，池余额独立申请取回，旧通道余额另行退款。并发有上限，速率限制按 Key 分桶。
- 结算恢复：signer 先持批次锁并把签名交易写入独占日志再广播；collector 放弃批次前通过窄权限函数取得同一锁，有交易则恢复原哈希。确认状态与余额/应收在账户锁内一同更新，缺少有效快照就重试，避免重复收款或凭空释放额度。丢失请求恢复同样遵守 Key 硬额度。
- challenge 一次性、短过期，并校验 SIWE address/domain/URI/chain/time；viem 在 Monad 链上校验 EOA、ERC-1271 和反事实 ERC-6492 签名；会话只保存 HMAC 摘要，浏览器使用 HttpOnly、SameSite=Strict Cookie；登录用于管理本人的 API Key 和通道。
- API / collector / reconciler / signer / catalog / metrics 使用独立最小权限数据库角色；公开表 RLS 开启。
- 供应商 env 文件由 API、collector、catalog 和 bootstrap 读取（collector 同步钱包调用 Key 额度）；OpenRouter 管理 Key 不能调模型，每个付款钱包的调用 Key 加密存库并有 OpenRouter 侧限额；客户代理控制参数由 allowlist 过滤；`n`/`best_of` 被丢弃。
- 数据库错误只在网关自己抛出的错误码上外发，其余折叠成 `DATABASE_ERROR`；`sslmode=require` 默认校验证书。
- 上游 401/403/404/5xx 不原样透传，上游错误消息只在客户可自行处理的 400/413/422 转发。
- 日志脱敏 Authorization 与 Cookie，禁止记录私钥、Prompt 和供应商 Secret。

## 仍需上线前完成

- Cookie 会话的 CSRF/浏览器渗透测试；
- Settler 钥匙进 KMS/HSM、轮换和灾难恢复演练；
- 自建 facilitator 后备；
- 供应商账单对账、拒付、退款和合规审查。

## 依赖审计

当前修复、残余钱包 SDK 告警及复查命令见 [依赖安全状态](DEPENDENCY_SECURITY.zh.md)。审计计数不等于可利用漏洞数量，未验证不可达的告警仍保留为未解决项。
