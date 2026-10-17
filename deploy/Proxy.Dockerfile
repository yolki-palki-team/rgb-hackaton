# Build the same pinned proxy source natively on ARM64 and AMD64.
FROM node:22.17.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ADD https://codeload.github.com/RGB-Tools/rgb-proxy-server/tar.gz/f466a580b1108580a922b098dc6952b4bde219cb /tmp/proxy.tar.gz
WORKDIR /app
RUN tar -xzf /tmp/proxy.tar.gz --strip-components=1 -C /app \
    && npm ci --no-audit --no-fund \
    && NODE_OPTIONS=--max-old-space-size=768 npm run build -- --skipLibCheck

FROM node:22.17.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
RUN mkdir /data && chown node:node /data
ENV APP_DATA=/data
USER node
CMD ["node", "dist/server.js"]
