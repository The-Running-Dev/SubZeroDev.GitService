# S35 — a consumer builds its own image `FROM` the base and gets one service
# offering both the base's tools and its own (S35.2), one registry
# fingerprint over both sets (S35.3), the compiler absent from this image's
# runtime stage too (S35.4, the same check the base runs — S35's own
# `check:layering` script, pointed at this workspace's own entrypoint), and
# this build runs unattended alongside the base's own container gate
# (S35.7). Same three-stage shape as the base's own `Dockerfile`, `builder`
# now also running this workspace's own `npm run build` (its own registry
# compiled from `PRODUCTION_TOOL_DECLARATIONS` plus its own declaration, and
# its own console build consuming the base's published console package).
#
# Built from the repository root as build context — the same context the
# base's own `Dockerfile` uses — so this workspace's relative imports into
# `../src/...` resolve the same way they do outside a container:
#   docker build -f example-consumer/Dockerfile -t subzerodev-git-example-consumer .

# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY console/package.json ./console/package.json
COPY example-consumer/package.json ./example-consumer/package.json
COPY example-consumer/console/package.json ./example-consumer/console/package.json
# The two extra COPYs above (needed for this workspace's own deps) shift this
# layer's cache key away from the base Dockerfile's own `RUN npm ci`, so a
# BuildKit layer-cache hit against the base's build (built first, same CI job)
# is never available here. The cache mount is keyed by id/target, not by the
# preceding instruction chain, so it still reuses npm's package cache the base
# build just populated even though the layer itself can't be reused.
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY console ./console
COPY example-consumer ./example-consumer
# The package *name*, not the folder name: `--workspace=example-consumer`
# resolves by path prefix and also matches the nested `example-consumer/console`
# workspace, running its own `build` a second time after this chain's own
# `build:console` already wrote `console.manifest.sha256` — the second,
# redundant `vite build` empties `dist/` again (Vite's default
# `emptyOutDir`) and deletes it, which boot then reports as
# `console-unreadable`. The package name matches only this workspace.
RUN npm run build --workspace=@subzerodev-git/example-consumer

FROM builder AS trimmed
RUN rm -f src/contract/compiler.ts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# git and gh, the same as the base's own runtime stage — the example
# consumer's tool still dispatches through the base's git operations.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && apt-get purge -y curl gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=trimmed /app/src ./src
COPY --from=trimmed /app/example-consumer/server.ts ./example-consumer/server.ts
COPY --from=trimmed /app/example-consumer/declarations.ts ./example-consumer/declarations.ts
COPY --from=builder /app/example-consumer/build ./example-consumer/build
COPY --from=builder /app/example-consumer/console/dist ./example-consumer/console/dist

ENV VOLUME_ROOT=/data
ENV CREDENTIAL_MOUNT_ROOT=/credentials
VOLUME ["/data"]

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

EXPOSE 8080

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "example-consumer/server.ts"]
