FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gzip && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' https://github.com/denoland/celld/releases/download/v0.6.2/celld-x86_64-unknown-linux-gnu.gz \
    | gzip -dc > /usr/local/bin/celld \
    && echo '0c9ef440f566156176c3d538e4a3c4034f43775a5851f3ff862938533b5aceac  /usr/local/bin/celld' | sha256sum --check
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
COPY infra/runtime/entrypoint.sh /usr/local/bin/platform-runtime
RUN chmod 755 /usr/local/bin/celld /usr/local/bin/platform-runtime
WORKDIR /state
ENTRYPOINT ["/usr/local/bin/platform-runtime"]
