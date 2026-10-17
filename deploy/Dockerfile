# syntax=docker/dockerfile:1
FROM node:22.17.0-bookworm-slim AS base
WORKDIR /app
COPY deploy/package.json deploy/package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json

FROM base AS public-build
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY packages/contracts/ ./packages/contracts/
COPY packages/ui/ ./packages/ui/
COPY apps/web/ ./apps/web/
RUN npm exec vite -- build --config apps/web/vite.config.ts

FROM base AS market
ENV NODE_ENV=production
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && mkdir -p /app/.state && chown node:node /app/.state
COPY tsconfig.json ./
COPY packages/contracts/ ./packages/contracts/
COPY apps/market/ ./apps/market/
USER node
EXPOSE 4100
CMD ["node", "--import", "tsx", "apps/market/src/main.ts"]

FROM nginx:1.28.0-alpine AS web
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=public-build /app/apps/web/dist/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
