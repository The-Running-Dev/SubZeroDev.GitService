# S28 — the service ships as a container.
#
# Three stages. `builder` has the full toolchain (typescript, the compiler)
# and runs the same `npm run build` the repository's own gates run, emitting
# `build/registry.json` + `.sha256` (boot's step 2 tamper check) alongside
# the compiler-import and migration checks. `trimmed` copies the source out
# and deletes `src/contract/compiler.ts` — invariant B8, "the compiler is
# absent from the runtime image" — before the final `runtime` stage ever
# copies from it, so the file is never present in any layer that stage
# contributes to the final image, not merely deleted after the fact.
# `runtime` is what ships: git and gh (`Exec.runGit`/`runGh`), production
# dependencies only, the trimmed source, and the build artifact.

# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# `check:migration` reads `design/20-contract.md` against the SQL migration
# (`scripts/check-migration-matches-contract.ts`) — a build-time-only
# dependency. `design/` never reaches the `runtime` stage below.
COPY design ./design
RUN npm run build

FROM builder AS trimmed
RUN rm -f src/contract/compiler.ts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# git and gh — the two executables `Exec.runGit`/`Exec.runGh` invoke
# (`20-contract.md` § L1 — exec). gh has no Debian-archive package, so its
# own apt repository is added first, the same way its install docs do.
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
COPY --from=builder /app/build ./build

# The three mounts S28.3 requires as separate mount points: the data volume,
# the read-only credential mount, and (per declaration, at deploy time) a
# watcher inbox bind-mounted under the data volume's own
# `watcher-inboxes/<declarationId>` path (`watcher.ts`'s `inboxRootFor`;
# `10-design.md` § FileWatcher — "a bind-mounted inbox per declaration").
ENV VOLUME_ROOT=/data
ENV CREDENTIAL_MOUNT_ROOT=/credentials
VOLUME ["/data"]

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

EXPOSE 8080

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "src/server.ts"]
