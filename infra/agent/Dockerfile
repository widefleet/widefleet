ARG RUNTIME_IMAGE=app-platform-runtime:0.1.0
FROM rust:1.99.0-bookworm@sha256:59037199c44290f2befcdd58dcc540164763fc296950255aaefeef096a1866b0 AS toolchain

FROM toolchain AS build
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN cargo build --locked --release --package platform-agent --package platform-cli

FROM ${RUNTIME_IMAGE}
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
COPY --from=build /source/target/release/platform-agent /usr/local/bin/platform-agent
COPY --from=build /source/target/release/widefleet /usr/local/bin/widefleet
WORKDIR /state
ENTRYPOINT ["/usr/local/bin/platform-agent"]
