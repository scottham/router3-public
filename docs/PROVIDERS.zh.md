# 模型供应商

[English](PROVIDERS.md)

网关直接调用供应商自己的 API，不经过中间代理。每个部署在 `providers.json` 里声明要接的供应商实例，类型决定价格从哪来、怎么调用、怎么结算：

| 类型 | 价格来源 | 结算依据 | 凭证 |
|---|---|---|---|
| `deepseek` | 官方中文价格页，每天同步，含峰谷时段；按 ECB 汇率换算 | 供应商返回的 token 用量 × 价格版本 | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter 公开模型 API，每天同步；固定模型候选托管商 | OpenRouter 在响应里报告的实际成本（`usage.cost`） | 管理 Key，网关据此给每个付款钱包建一把调用 Key |
| `openai-compatible` | 配置里人工审核的固定价格 | token 用量 × 价格 | 该供应商的 API Key |

三类都支持 `/v1/chat/completions`；`deepseek` 和 `openrouter` 还支持 `/v1/messages`（Anthropic）和 `/v1/responses`，请求按原格式转发到供应商的原生端点。

## 提示缓存

缓存策略根据所选上游端点的 `supports_implicit_caching` 和缓存价格确定，不按模型名判断。隐式缓存不改提示及托管商优先级。显式缓存在有写入价格时，给可复用的历史或指令加入五分钟断点，保留最新输入为未缓存尾部；没有独立上下文的单条输入保持原样。混合或未知能力不盲目注入默认指令。保留客户端缓存设置与会话键；`cache_control: null` 可关闭默认缓存。显式缓存路由保留报价托管商白名单，并允许 OpenRouter 固定会话路由。

冻结覆盖报价写入费率；若写入价只是存储费，也计入输入费用。一小时写入必须有对应报价。OpenRouter 结算采用上游成本回执。

实测：`MCG_API_KEY_FILE=/path/to/key npm run test:prompt-cache-e2e`。默认覆盖八个模型、三个 API，消耗真实额度，测试预算 0.5 USDC。可用 `MCG_CACHE_MODELS`、`MCG_CACHE_PROTOCOLS` 缩小范围。后续请求更换末尾问题，复用上下文；检查前缀有实质缓存命中且费用下降，隐式缓存不要求报告写入数量。

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

- `allowedFamilies` 是厂商前缀（模型 ID 斜杠前的部分），该厂商的模型全部上架，`:batch`、`:free` 变体除外；`allowedModels` 是额外的单个模型 ID，写成对象可以指定托管商。公开模型名为 `openrouter/<id>`。
- 模型列表用管理 Key 读 `/models/user`，即按本账户隐私设置（Zero Data Retention 等）过滤后的结果，没有可用托管商的模型不会上架。
- 每个模型的候选托管商：厂商自己和它的一方云（Claude：Anthropic、Bedrock、Vertex、Azure；GPT：OpenAI/Azure；Gemini：AI Studio/Vertex），再加其他托管商；全部限定在最便宜的厂商托管价的 1.5 倍以内，最多 8 个；没有厂商托管时以最便宜的为基准。加速档（priority、`/fast`）和 flex 档不进候选。请求用 `provider.only` 限定端点并禁止回退，叠加账户的 ZDR 设置；显式缓存路由允许固定会话，其余保留 `provider.order`。
- 列表价格是第一候选的价格；冻结额按候选中最贵的算，实付按 OpenRouter 报告的成本。
- 按次收费的托管不上目录；按张计费图片的模型关闭图片输入；其余 OpenRouter 模型的图片按每张 4000 token 估算冻结额，实付按报告成本。
- 容器用 `PROVIDER_CONFIG_FILE` 挂载这个文件，`PROVIDER_ENV_FILE` 提供其中引用的环境变量；API、collector、catalog 和 bootstrap 读取供应商凭证文件；collector 使用 OpenRouter 管理 Key 同步钱包额度。

## OpenRouter 的钱包 Key

- 管理 Key 不能调模型，只能管理 Key。某个付款钱包第一次调用 OpenRouter 模型时，网关用它建一把名为 `router3:<站点域名>:<钱包地址>` 的调用 Key，额度按钱包预付池每日上限设置并每日重置；无预付池时用 `payerKeyLimitUsd`（美元）。调用 Key 加密后存在 `private.provider_payer_keys`。
- 钱包的 `configure` 确认上链后 collector 立刻同步额度；catalog 每小时核对一次（`PROVIDER_KEY_SYNC_SECONDS`）：把 OpenRouter 侧的用量写回、把被改动的限额改回来，远端被删的 Key 标记为 `deleted`。
- 同名但本地没有秘密的远端 Key（创建响应丢失）会被删除重建，不会复用。
- 部署前 `ops/check-provider-keys.mjs` 用管理 Key 列一次 Key、用 DeepSeek Key 列一次模型，任一失败不部署。

## 结算与对账

- OpenRouter：请求带 `usage: {include: true}`，响应（流式时在最后一个块里）带 `cost`，网关按它结算，加服务费；用量凭证里 `billed_from=provider_cost`。拿不到成本时退回价格版本计算（`billed_from=price_table`）。
- 冻结额按价格版本估算：输入按字节、输出按 `max_tokens`。
- 每天同步目录时记录供应商余额：DeepSeek 为人民币，OpenRouter 为美元。两次检查之间的余额减少额与记录的成本之差显示在 Grafana「供应商对账」一栏。
- 每个钱包的 OpenRouter Key 另有 OpenRouter 侧的用量计数，可以和网关为该钱包记录的 OpenRouter 成本逐项比较。

## 条款

部署者负责确认供应商协议允许预期用途（包括转售），并核对现行条款及所需企业协议。OpenRouter 账户隐私与 ZDR 设置变化会在下一次目录同步时生效，也可以手动重跑 catalog 刷新。
