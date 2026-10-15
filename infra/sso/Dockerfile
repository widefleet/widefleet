FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /source
RUN npm install --global pnpm@12.4.2
# Keep dependency downloads cached when only application source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    && pnpm --filter @platform/auth-proxy build \
    && pnpm exec esbuild apps/control-plane/tools/sso-supervisor.ts --bundle --platform=node --format=esm --outfile=/supervisor.mjs

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gzip \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' https://github.com/denoland/celld/releases/download/v0.6.2/celld-x86_64-unknown-linux-gnu.gz \
    | gzip -dc > /usr/local/bin/celld \
    && echo '0c9ef440f566156176c3d538e4a3c4034f43775a5851f3ff862938533b5aceac  /usr/local/bin/celld' | sha256sum --check \
    && chmod 755 /usr/local/bin/celld
COPY --from=build /supervisor.mjs /supervisor.mjs
COPY --from=build /source/packages/auth-proxy/dist/worker.js /worker.js
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
RUN mkdir -p /auth /runtime && chown node:node /auth /runtime && chmod 700 /auth /runtime
USER node
EXPOSE 4180
ENTRYPOINT ["node", "/supervisor.mjs"]
