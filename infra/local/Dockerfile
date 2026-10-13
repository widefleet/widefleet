ARG CONTROL_PLANE_IMAGE=widefleet-local-control-plane:source
ARG AGENT_IMAGE=widefleet-local-agent:source
ARG RUNTIME_IMAGE=widefleet-local-runtime:source
FROM ${CONTROL_PLANE_IMAGE} AS management
FROM ${AGENT_IMAGE} AS agent
FROM ${RUNTIME_IMAGE} AS runtime

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
RUN npm install --global pnpm@12.4.2 && pnpm config set store-dir /pnpm/store
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile \
    --filter @platform/local-demo --filter @platform/starter
COPY --from=agent /usr/local/bin/widefleet /tmp/widefleet
COPY --from=agent /usr/local/bin/platform-agent /usr/local/bin/platform-agent
COPY --from=runtime /usr/local/bin/celld /usr/local/bin/celld
COPY --from=runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ARG RELEASE_VERSION=""
RUN --mount=type=cache,target=/pnpm/store set -eu; \
    if [ -n "$RELEASE_VERSION" ]; then \
      executable="$(node tools/install-local-cli.ts "$RELEASE_VERSION")"; \
    else \
      pnpm install --frozen-lockfile --filter internal-app-platform; \
      archive="$(node tools/package-cli.ts --binary /tmp/widefleet --output /opt/widefleet)"; \
      executable="${archive%.tar.gz}/widefleet"; \
    fi; \
    ln -s "$executable" /usr/local/bin/widefleet; \
    /usr/local/bin/widefleet --version
# Use the image's matching server, migrations and dependencies for local setup too.
COPY --from=management /application /application
COPY apps/control-plane/local /application/local
RUN ln -s /workspace/infra/local/node_modules /application/local/node_modules
ARG CONTROL_PLANE_IMAGE
ARG AGENT_IMAGE
ARG RUNTIME_IMAGE
LABEL widefleet.local.runtime=$RUNTIME_IMAGE widefleet.local.agent=$AGENT_IMAGE \
    widefleet.local.control-plane=$CONTROL_PLANE_IMAGE widefleet.local.release=$RELEASE_VERSION
ENV PLATFORM_RUNTIME_IMAGE=$RUNTIME_IMAGE
WORKDIR /application
