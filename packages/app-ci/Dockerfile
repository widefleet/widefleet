# The build environment of the app CI: Node.js, pnpm and Git, plus the Widefleet
# CLI release of this installation in dist/cli, which runs `widefleet deploy`.
FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@12.4.2 \
  && npm cache clean --force
COPY dist/cli /opt/widefleet
# Build artifacts can lose their execute bits between jobs.
RUN chmod 755 /opt/widefleet/widefleet /opt/widefleet/esbuild
ENV PATH=/opt/widefleet:$PATH
WORKDIR /build
CMD ["sleep", "infinity"]
