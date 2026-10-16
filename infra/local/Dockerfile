FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
RUN npm install --global pnpm@12.4.2
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @platform/control-plane build
COPY --from=app-platform-agent:0.1.0 /usr/local/bin/widefleet /tmp/widefleet
COPY --from=app-platform-agent:0.1.0 /usr/local/bin/platform-agent /usr/local/bin/platform-agent
COPY --from=app-platform-runtime:0.1.0 /usr/local/bin/celld /usr/local/bin/celld
COPY --from=app-platform-runtime:0.1.0 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN archive="$(node tools/package-cli.ts --binary /tmp/widefleet --output /opt/widefleet)" \
    && ln -s "${archive%.tar.gz}/widefleet" /usr/local/bin/widefleet \
    && /usr/local/bin/widefleet --version
WORKDIR /workspace/apps/control-plane
