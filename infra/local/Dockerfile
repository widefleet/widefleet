ARG CONTROL_PLANE_IMAGE=widefleet-local-control-plane:source
ARG AGENT_IMAGE=widefleet-local-agent:source
ARG RUNTIME_IMAGE=widefleet-local-runtime:source
FROM ${CONTROL_PLANE_IMAGE} AS management
FROM ${AGENT_IMAGE} AS agent
FROM ${RUNTIME_IMAGE} AS runtime

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
RUN npm install --global pnpm@12.4.2
WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    --filter internal-app-platform --filter @platform/control-plane... --filter @platform/starter...
COPY --from=agent /usr/local/bin/widefleet /tmp/widefleet
COPY --from=agent /usr/local/bin/platform-agent /usr/local/bin/platform-agent
COPY --from=runtime /usr/local/bin/celld /usr/local/bin/celld
COPY --from=runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN archive="$(node tools/package-cli.ts --binary /tmp/widefleet --output /opt/widefleet)" \
    && ln -s "${archive%.tar.gz}/widefleet" /usr/local/bin/widefleet \
    && /usr/local/bin/widefleet --version
# Use the image's matching server, migrations and dependencies for local setup too.
COPY --from=management /application /application
COPY apps/control-plane/local /application/local
RUN ln -s /workspace/apps/control-plane/node_modules/emulate /application/node_modules/emulate
WORKDIR /application
