# SubZeroDev.Git

A containerised service that gives agents and people controlled access to many Git repositories through one place. You declare the repositories you want it to manage. It clones each one when it is first used, and serves the same operations over three surfaces:

- **MCP**, so an agent such as Claude Code can read, commit, push and open pull requests in a repository through tools rather than a shell.
- **An HTTP API** for scripts.
- **An operator console** (a web UI) for declaring repositories, granting and revoking access, and reviewing the audit trail.

Repositories are **declared, not hardcoded**: any Git remote can be managed, on GitHub or elsewhere. Local git operations work against any host. Pull requests, checks and merges go through the `gh` CLI and are GitHub-only.

**The tool surface is the boundary.** An MCP client never gets a shell or a filesystem. It gets a fixed set of operations, each needing a named capability (`repo.read`, `git.local.write`, `git.remote.write`, `host.pr.write`, …). It can only call the operations whose capabilities appear in all three of these:

- the contract compiled into the image,
- the deployment's ceiling,
- the grant on that repository's declaration.

Writes are further confined to the repository's writable path prefixes, and every call is audited.

## Quick start

You need Docker (with Compose v2.24 or later), Node.js 22.18 or later, and git.

```bash
npm install
```

```bash
npm run deploy
```

The first run takes a few minutes, because it builds the image. It also creates `deploy.config.json` with defaults and no repositories, then:

1. Builds and starts the container, and waits for `/healthz` to report the commit it was built from.
2. Generates the TOTP sealing key in `credentials/`.
3. Enrols the first operator, and prints the console URL, a username, a generated password and a TOTP secret. Add the secret to an authenticator app, then sign in at <http://localhost:8080>.

Next, add a repository to `deploy.config.json`, put its access token in an environment variable, and run the script again. For example:

```json
{
  "repositories": [
    {
      "id": "my-app",
      "cloneUrl": "https://github.com/acme/my-app.git",
      "tokenEnv": "MY_APP_TOKEN",
      "capabilities": ["repo.read", "git.local.write", "host.pr.read"],
      "writablePaths": ["docs/", "src/"]
    }
  ]
}
```

On macOS or Linux:

```bash
MY_APP_TOKEN=ghp_your_token npm run deploy
```

In PowerShell, set the variable first and then run `npm run deploy`:

```powershell
$env:MY_APP_TOKEN = 'ghp_your_token'
```

Re-running is safe. Each run does the following:

- Rebuilds and restarts the container.
- Signs in as the saved operator.
- Declares any new repositories and amends any whose settings changed.
- Prints how to connect an MCP client to each repository.

A repository that is declared on the service but missing from the config is reported and left alone. Remove it in the console if you mean to.

## Configuration

`deploy.config.json` is per-machine and gitignored. [`deploy.config.example.json`](deploy.config.example.json) shows every setting. The script rejects unknown settings, and lists every problem in one go.

**Top-level settings**

| Setting | Default | Meaning |
|---|---|---|
| `port` | `8080` | Host port the service is published on |
| `publicOrigin` | `http://localhost:<port>` | The origin clients reach the service at. Set it to your HTTPS address when it sits behind a reverse proxy |
| `remoteOperations` | `false` | Allow push and pull-request operations. With `false`, `git.remote.write` and `host.pr.write` are refused even where granted |
| `operator` | `admin` | Username of the first operator |
| `gitIdentity` | your `git config user.name` / `user.email` | Author identity for commits the service makes |
| `environment` | none | Extra container variables, passed through as-is; see the [operator guide](docs/operator-guide.md#configuration). Variables the script derives are refused here |
| `repositories` | `[]` | The repositories to declare |

**Repository settings**

| Setting | Default | Meaning |
|---|---|---|
| `id` | required | Lower-case name, which becomes the MCP path `/mcp/<id>` |
| `cloneUrl` | required | `https://host/owner/repo.git` or `git@host:owner/repo.git` |
| `host` | `github` for github.com, otherwise `generic` | A `generic` repository gets no `host.*` (pull request / checks) tools |
| `credential` | the `id` | The token's file name under `credentials/` |
| `tokenEnv` | none | An environment variable to copy the token from. Without it, the file `credentials/<credential>` must already exist |
| `username` | `x-access-token` | The username git sends with the token. The default suits GitHub; other hosts may want another, such as `oauth2` for GitLab |
| `capabilities` | `["repo.read"]` | The capability grant |
| `writablePaths` | `[]` | The path prefixes writes may touch |
| `gitIdentity` | the top-level one | A per-repository author identity |

The script derives two settings so you don't keep them by hand:

- The **remote host allowlist** is the set of hosts in your clone URLs.
- The **deployment ceiling** is the union of your capability grants, so it is never wider than what some repository was actually given.

Both are written to `.deploy/service.env`, which `docker-compose.yml` reads. The script also writes `credentials/_allowed-hosts.json`, which lists the hosts each credential may reach. The service refuses to send a credential to any host not listed there, as a second guard independent of the allowlist.

Tokens are read by the service at the moment of use, never baked into the image. Git receives the token as a password through a credential helper, and `gh` receives it as `GH_TOKEN`.

A managed repository whose default branch is not `main` names its base branch in its own `.config/subzerodev-git.json`, as `{ "baseBranch": "master" }`. That file belongs to the repository, not to this deployment, so that the repository's policy travels with it.

## Connecting an MCP client

Each repository has its own MCP endpoint at `<publicOrigin>/mcp/<id>`. To connect Claude Code:

```bash
claude mcp add --transport http my-app http://localhost:8080/mcp/my-app
```

Authorization uses OAuth with dynamic client registration:

1. On first connect, the client opens an approval page in your browser.
2. Sign in to the console in that browser, then approve the client.
3. The client receives a token scoped to that one repository and the capabilities its declaration grants.

You can revoke the client at any time from the console. The tools a client sees are listed in the registry tables of [`design/20-contract.md`](design/20-contract.md#public-signatures). Examples include `repo_status`, `git_diff`, `git_commit`, `git_push`, `pr_open` and `checks_await`.

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run deploy` | Build, start, enrol and declare (the same as `npm run deploy -- up`) |
| `npm run deploy -- status` | Show the container and its `/healthz` answer |
| `npm run deploy -- logs` | Follow the service's logs |
| `npm run deploy -- down` | Stop the service. The data volume, which holds clones, declarations, grants and the audit log, is kept |
| `npm run deploy -- --config other.json` | Use another config file |

Backup, rollback, revocation, break-glass recovery and supported storage are covered in the [operator guide](docs/operator-guide.md). The data must live on a Docker-managed named volume, never a bind mount or a network share, because the mutation lock depends on local advisory locking.

### What the script keeps on disk

All of these are gitignored:

| Path | Contents |
|---|---|
| `credentials/` | One token file per credential, `_allowed-hosts.json`, and `_totp-sealing-key`. Never delete or replace the key: every enrolled TOTP secret is sealed with it |
| `.deploy/service.env` | The container environment, rewritten on every run |
| `.deploy/operator.json` | The operator's password, TOTP secret and ten recovery codes, in plain text |

`.deploy/operator.json` is what lets a re-run sign in without you. If that is the wrong trade-off for the machine, move its contents to a password manager and delete the file. The service keeps running. The script then stops before declaring, and you declare repositories in the console instead.

## Your own tools

The image is meant to be extended. [`example-consumer/`](example-consumer/) builds `FROM` the base image and adds its own tools and console views. The layering check keeps those additions on the consumer side of the boundary.

## Development

```bash
npm test
```

```bash
npm run build
```

- **`npm test`** runs every `*.test.ts` file with `node --test`.
- **`npm run build`** runs the type checks, compiles the tool registry and runs the structural gates. CI runs both.

Browser tests (`npm run test:e2e`) use Playwright.

The design is the specification. Read the documents in this order:

1. [`design/00-brief.md`](design/00-brief.md): the problem and the non-goals
2. [`design/20-contract.md`](design/20-contract.md): invariants, error semantics and the public surface
3. [`design/10-design.md`](design/10-design.md): architecture and failure modes
4. [`design/30-slices.md`](design/30-slices.md): how it was built
5. [`design/90-decisions.md`](design/90-decisions.md): why it is the way it is

[`AGENTS.md`](AGENTS.md) is the contract for agents working in this repository.
