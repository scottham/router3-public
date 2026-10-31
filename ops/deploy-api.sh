#!/bin/bash
# Replaces the API container without dropping in-flight streams: starts a
# container on the new image next to the old one, waits until it is ready,
# then stops the old one, which drains (src/lib/shutdown.js) for up to 630 s.
# nginx resolves `api` every 5 s and skips a container that refuses connections.
# Build the image first (npm run mainnet:local:build).
set -euo pipefail
cd "$(dirname "$0")/.."
compose() { docker compose --env-file .env.mainnet-local -f docker-compose.production.yml "$@"; }
# A key that does not work on its configured endpoint (revoked, or for another
# account) would fail every call once the new containers start.
compose run --rm --no-deps catalog node ops/check-provider-keys.mjs || { echo "provider key check failed; nothing deployed" >&2; exit 1; }
old=$(compose ps -q api)
[ "$(wc -w <<<"$old")" -le 1 ] || { echo "more than one api container running" >&2; exit 1; }
compose up -d --no-deps --no-recreate --scale api=2 api
new=$(compose ps -q api | grep -vx "${old:-none}")
for i in $(seq 60); do
  if docker exec "$new" node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then ready=1; break; fi
  sleep 1
done
if [ -z "${ready:-}" ]; then docker logs --tail 30 "$new" >&2; docker rm -f "$new" >/dev/null; echo "new api container never became ready; old one kept" >&2; exit 1; fi
echo "new api ready: $(docker inspect -f '{{.Name}}' "$new")"
if [ -n "$old" ]; then
  echo "draining $(docker inspect -f '{{.Name}}' "$old") (in-flight requests finish first)"
  docker stop -t 630 "$old" >/dev/null
  docker rm "$old" >/dev/null
fi
echo "done"
