FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Node's happy-eyeballs gives each address 250 ms. Cross-border providers
# (Ark Beijing is ~310 ms from overseas hosts) then lose their IPv4 attempt
# to an unreachable IPv6 one and every request times out.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8787
CMD ["node", "src/server.js"]
