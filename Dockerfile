# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY nitro.config.ts tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY extensions/nova-chrome ./extensions/nova-chrome
RUN npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates chromium chromium-sandbox fonts-liberation \
        fonts-noto-cjk fonts-noto-color-emoji git ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/chromium /data/downloads /workspace \
    && chown -R node:node /data /workspace
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=8080 \
    VEGA_DB=/data/vega.db \
    VEGA_SKILL_CACHE=/data/skill-cache \
    VEGA_CHROMIUM_NO_SANDBOX=0
COPY --from=build /app/.output /app/.output
COPY --from=build /app/extensions/nova-chrome /app/extension
COPY docker /app/docker
COPY docker/chromium-policy.json /etc/chromium/policies/managed/vega.json
USER node
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=75s --retries=3 \
    CMD ["node", "/app/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/docker/start.mjs"]
