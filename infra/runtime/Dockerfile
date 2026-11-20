FROM rust:1.99.0-bookworm@sha256:59037199c44290f2befcdd58dcc540164763fc296950255aaefeef096a1866b0 AS native
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN cargo build --locked --release --package platform-agent --bin platform-runtime
# The app builder's service documentation module.
RUN rustup target add wasm32-wasip1 \
    && cargo build --locked --profile wasm --package platform-service-docs-wasm --target wasm32-wasip1

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /source
RUN npm install --global pnpm@12.4.2
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
COPY --from=native /source/target/wasm32-wasip1/wasm/platform_service_docs_wasm.wasm target/wasm32-wasip1/wasm/
RUN pnpm install --offline --frozen-lockfile \
    && pnpm --filter @platform/app-runtime build \
    && pnpm --filter @platform/app-builder build

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gzip && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' https://github.com/widefleet/celld/releases/download/v0.6.3-widefleet.1/celld-x86_64-unknown-linux-gnu.gz \
    | gzip -dc > /usr/local/bin/celld \
    && echo '3078dfead83d2f13bd79ca23c43968a8753fe4e222698b6a50dc6e416eb85073  /usr/local/bin/celld' | sha256sum --check
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
COPY infra/runtime/licenses/celld /usr/share/licenses/celld
COPY crates/platform-cli/licenses/tsrs-LICENSE.txt /usr/share/licenses/tsrs/LICENSE
COPY crates/platform-cli/licenses/tsrs-NOTICE.txt /usr/share/licenses/tsrs/NOTICE
COPY --from=native /source/target/release/platform-runtime /usr/local/bin/platform-runtime
COPY --from=build /source/packages/app-runtime/dist/release.json /opt/widefleet-runtime/release.json
# The app builder runs from this image as its own Compose service with `celld dev`.
COPY --from=build /source/packages/app-builder/dist /opt/widefleet-builder
RUN chmod 755 /usr/local/bin/celld /usr/local/bin/platform-runtime
RUN groupadd --gid 1000 widefleet && useradd --uid 1000 --gid widefleet --no-create-home widefleet \
    && mkdir -p /state /runtime-config && chown widefleet:widefleet /state /runtime-config
ENV CELLD_WATCH=/state/node CELLD_ASSET_CACHE_DIR=/state/assets CELLD_SHUTDOWN_TOTAL_MS=10000 CELLD_OTEL=0
WORKDIR /state
USER widefleet
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/platform-runtime"]
