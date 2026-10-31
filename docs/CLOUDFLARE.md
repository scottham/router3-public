# Public access with Cloudflare Tunnel

[中文](CLOUDFLARE.zh.md)

All services stay on the host. `cloudflared` makes outbound connections to Cloudflare and forwards the public hostname to `web`. No inbound port is required; Cloudflare manages the public certificate. The console and `/v1` share an origin.

## Setup

1. In Cloudflare Zero Trust, create a Cloudflared tunnel and copy its token.
2. Add public hostname `router3.example.com`, service type `HTTP`, destination `web:80`.
3. Set the following in `.env.mainnet-local`:

   ```text
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   PUBLIC_APP_URL=https://router3.example.com
   CORS_ORIGINS=https://router3.example.com
   NODE_ENV=production
   ```

   SIWE accepts the `PUBLIC_APP_URL` domain. Production mode enables Secure session cookies. Rebuild the frontend because its API URL is set at build time.
4. Run `npm run mainnet:local:build && npm run mainnet:local:start && npm run mainnet:local:tunnel`.
5. Close inbound 80/443 in the host firewall or cloud security list. `web` binds only to `127.0.0.1`.

## Cloudflare settings

- **SSL/TLS:** enable Always Use HTTPS. The tunnel's origin hop needs no certificate.
- **Caching:** bypass `/v1/*`; API responses already use `no-store`.
- **Bot Fight Mode / Under Attack:** disable or skip challenges on `/v1/*`, so SDKs and agents receive API responses.
- **Optional rate limits:** apply IP limits to `/v1/auth/*`.
- **Client IP:** `ops/nginx.conf` forwards `CF-Connecting-IP` to the API for rate limiting.

## Timeouts

Account for Cloudflare's Proxy Read Timeout when sizing non-streaming calls; check the timeout and adjustment options for your Cloudflare plan.

- **Gateway:** non-streaming calls have a default `DEFAULT_REQUEST_TIMEOUT_MS` of 120 seconds. If Cloudflare disconnects first, the gateway still waits for the provider within its own timeout and bills actual usage; the client may not receive the result. Streams allow up to `STREAM_REQUEST_TIMEOUT_MS` (570 seconds by default), with `STREAM_IDLE_TIMEOUT_MS` (90 seconds) between upstream output. `STALE_REQUEST_AFTER_SECONDS` (900 seconds) must exceed the stream budget.
- **Streaming:** after 15 seconds without data, the gateway emits an SSE comment, `: keepalive`. SSE clients ignore it; it keeps a long prefill/reasoning phase from appearing idle to intermediaries.
- **Long tasks:** use `stream: true`. A separate API hostname outside Cloudflare's proxy can support longer non-streaming calls, but exposes the origin IP.
