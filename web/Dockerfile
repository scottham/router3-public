FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
COPY web/index.html web/vite.config.js ./
COPY web/src ./src
COPY web/public ./public
COPY web/scripts ./scripts
COPY web/test ./test
ARG VITE_API_BASE_URL
ARG VITE_WALLETCONNECT_PROJECT_ID=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
