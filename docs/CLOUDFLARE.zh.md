# 通过 Cloudflare Tunnel 公网发布

[English](CLOUDFLARE.md)

服务仍全部运行在本机。`cloudflared` 主动连出到 Cloudflare，把公网域名转发到 `web` 容器。不开放入站端口，证书由 Cloudflare 管理。控制台和 `/v1` 使用同一个域名。

## 步骤

1. Cloudflare 控制台 → Zero Trust → Networks → Tunnels，创建 Tunnel（Cloudflared 类型），复制 token。
2. Public Hostname 填写 `router3.example.com`，Service 填写 `HTTP` 和 `web:80`。
3. 在 `.env.mainnet-local` 中修改：

   ```text
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   PUBLIC_APP_URL=https://router3.example.com
   CORS_ORIGINS=https://router3.example.com
   NODE_ENV=production
   ```

   SIWE 只接受 `PUBLIC_APP_URL` 的域名。`NODE_ENV=production` 给登录 Cookie 加上 Secure。前端在构建时写入 API 地址，所以要重新构建。
4. 运行 `npm run mainnet:local:build && npm run mainnet:local:start && npm run mainnet:local:tunnel`。
5. 关闭 Oracle 安全列表或防火墙中的 80/443 入站规则。`web` 只监听 `127.0.0.1`。

## Cloudflare 设置

- **SSL/TLS**：开启 Always Use HTTPS。Tunnel 到源站这一段不需要证书。
- **缓存**：添加 Cache Rule，`/v1/*` 设为 Bypass。接口本身已返回 `no-store`。
- **Bot Fight Mode、Under Attack**：对 `/v1/*` 关闭或跳过，否则 SDK 和 Agent 会收到挑战页。
- **限速（可选）**：WAF Rate Limiting 按 IP 限制 `/v1/auth/*`。
- **真实 IP**：`ops/nginx.conf` 把 `CF-Connecting-IP` 作为客户端 IP 传给 API，限速按真实 IP 计算。

## 超时

非流式调用的预算需要考虑 Cloudflare 的 Proxy Read Timeout；具体超时和可调整范围以所用套餐为准。

- **网关自身**：非流式调用最多 `DEFAULT_REQUEST_TIMEOUT_MS`（默认 120 秒），与 Cloudflare 的上限相当。Cloudflare 先断开时网关不会中止上游：模型在超时内跑完，这次调用按实际用量计费而不是按冻结额，只是客户端收不到结果。流式调用总时长最多 `STREAM_REQUEST_TIMEOUT_MS`（默认 570 秒），上游连续 `STREAM_IDLE_TIMEOUT_MS`（默认 90 秒）没有输出就断开。`STALE_REQUEST_AFTER_SECONDS`（默认 900）必须大于流式上限，否则对账会把仍在进行的流当作丢失。
- **流式**：连续 15 秒没有数据时，网关发送 SSE 注释 `: keepalive`。OpenAI SDK 和遵守 SSE 规范的客户端都会忽略它，长时间预填充或推理也不会被当作空闲连接断开。
- **长任务**：使用 `stream: true`。需要更长的非流式调用时，可以把 API 放到不经过 Cloudflare 代理的子域名，但会暴露源站 IP。
