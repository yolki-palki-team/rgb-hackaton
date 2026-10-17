# syntax=docker/dockerfile:1
FROM node:22.17.0-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libatomic1 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/market/package.json ./apps/market/package.json
COPY apps/local-client/package.json ./apps/local-client/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund && npm cache clean --force
# The packaged Bare binary may lack executable bits. Fix them while building,
# so QVAC never needs to chmod root-owned files as the runtime user.
RUN node -e "require('node:fs').chmodSync(require('bare-runtime')(), 0o755)"

FROM dependencies AS source
COPY tsconfig.json ./
COPY apps/ ./apps/
COPY packages/contracts/ ./packages/contracts/

FROM source AS ui-build
RUN npm run build

FROM source AS runtime
COPY --from=ui-build /app/apps/local-client/ui/dist/ /app/apps/local-client/ui/dist/
ENV NODE_ENV=production
ENV QVAC_DEVICE=cpu
RUN mkdir -p /app/.state /home/node/.qvac && chown node:node /app/.state /home/node/.qvac
USER node
EXPOSE 4101 4102 4103
CMD ["node", "--import", "tsx", "apps/local-client/scripts/docker-demo.ts"]

FROM nginx:1.28.0-alpine AS web
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=ui-build /app/apps/web/dist/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
