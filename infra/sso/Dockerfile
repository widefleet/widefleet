FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /source
RUN npm install --global pnpm@12.4.2
# Keep dependency downloads cached when only application source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    && pnpm exec esbuild apps/control-plane/tools/sso-supervisor.ts --bundle --platform=node --format=esm --outfile=/supervisor.mjs

FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916 AS upstream
FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=upstream /bin/oauth2-proxy /bin/oauth2-proxy
COPY --from=build /supervisor.mjs /supervisor.mjs
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
COPY infra/oauth2-proxy/options.cfg /config/options.cfg
RUN mkdir -p /auth /runtime && chown node:node /auth /runtime && chmod 700 /auth /runtime
USER node
EXPOSE 4180
ENTRYPOINT ["node", "/supervisor.mjs"]
