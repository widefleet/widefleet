FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /source
RUN npm install --global pnpm@12.4.2
# Keep dependency downloads cached when only application source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm --filter @platform/control-plane build
RUN node apps/control-plane/tools/prepare-deploy.ts \
    && pnpm --filter @platform/control-plane deploy --legacy --prod /application

FROM node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=100M PROTOCOL_HEADER=x-forwarded-proto
WORKDIR /application
COPY --from=build --chown=node:node /application .
COPY LICENSE /usr/share/licenses/widefleet/LICENSE
COPY infra/traefik/app-auth.json /infra/traefik/app-auth.json
RUN mkdir -p /var/lib/widefleet/auth /var/lib/widefleet/edge \
    && chown -R node:node /var/lib/widefleet && chmod 700 /var/lib/widefleet
USER node
EXPOSE 3000
CMD ["node", "build"]
