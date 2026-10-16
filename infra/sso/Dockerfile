FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /source
RUN npm install --global pnpm@12.4.2
# Keep dependency downloads cached when only application source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm --filter @platform/auth-proxy build

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gzip \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' https://github.com/denoland/celld/releases/download/v0.6.2/celld-x86_64-unknown-linux-gnu.gz \
    | gzip -dc > /usr/local/bin/celld \
    && echo '0c9ef440f566156176c3d538e4a3c4034f43775a5851f3ff862938533b5aceac  /usr/local/bin/celld' | sha256sum --check \
    && chmod 755 /usr/local/bin/celld
COPY --from=build /source/packages/auth-proxy/dist/worker.js /opt/widefleet-auth/worker.js
COPY infra/sso/wrangler.json /opt/widefleet-auth/wrangler.json
COPY infra/sso/entrypoint.sh /usr/local/bin/widefleet-auth
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
RUN groupadd --gid 1000 widefleet && useradd --uid 1000 --gid widefleet --no-create-home widefleet \
    && mkdir -p /auth /runtime && chown widefleet:widefleet /auth /runtime \
    && chmod 700 /auth /runtime && chmod 755 /usr/local/bin/widefleet-auth
USER widefleet
EXPOSE 4180
ENTRYPOINT ["/usr/local/bin/widefleet-auth"]
