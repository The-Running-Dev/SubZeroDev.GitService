import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { ClonePath, CredentialRef, DeclarationId, EnvVarName } from '../shared/brands.ts';
import type { JsonArray, JsonObject, JsonValue } from '../contract/json.ts';
import { execError, type ExecError } from './errors.ts';

export interface CredentialBinding {
  readonly ref: CredentialRef;
  readonly declarationId: DeclarationId;
  readonly variableName: EnvVarName;
}

export interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd: ClonePath;
  readonly timeoutSeconds: number;
  readonly credential: CredentialBinding | null;
  readonly signal: AbortSignal;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export type MutableEnv = Map<EnvVarName, string>;

export interface Exec {
  runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>>;
  runGh(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>>;
  scrub(text: string): string;
  scrubJson(value: JsonValue): JsonValue;
}

export interface ExecOptions {
  readonly volumeRoot: string;
  readonly gitExecutable?: string;
  readonly ghExecutable?: string;
  /**
   * The `MutableEnv` `CredentialResolver.resolveInto` writes a resolved secret
   * into, keyed by the `EnvVarName` a `CredentialBinding` names. The resolver
   * populates it at point of use; a `request.credential` naming a variable
   * this map does not hold simply runs without one, because a missing secret
   * must not be fabricated as an empty string in the child's environment. Not
   * part of `Exec`'s own contract signature: an injectable seam the
   * composition root shares with `CredentialResolver`, the same way
   * `StructuredStoreOptions.migrations` is a seam and not a contract member.
   */
  readonly credentialEnv?: MutableEnv;
  /**
   * Called with the exact executable and argument vector each child is spawned
   * with, immediately before it becomes a process.
   *
   * This exists because invariant S5's process-argument-vector half is
   * otherwise **unobservable from a test**: everything a child writes back
   * comes through `scrubText`, which redacts every resolved secret — so a
   * secret leaked into `argv` would be scrubbed out of the very output a test
   * would read it from, and the test would pass while `ps` on the host showed
   * the token. Reading the vector at the point it becomes a command line is
   * the only place the property is decidable.
   *
   * Observation only: nothing here can change what is spawned. Not part of
   * `Exec`'s contract signature, the same as `credentialEnv` above.
   */
  readonly onSpawn?: (executable: string, argv: readonly string[]) => void;
}

// Redacts the credential form a `CloneUrl` can carry (`https://user:pass@host/...`),
// which is the one secret shape recognisable without knowing any actual
// secret value. Every *resolved* secret is redacted too — see `scrubText`
// below, which is closed over the same `MutableEnv` the resolver writes into.
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/\s@]+@/gi;

const REDACTION = '***';

function scrubUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTION}@`);
}

/**
 * Every subprocess this service spawns (`20-contract.md` § L1 exec): a fixed
 * executable per runner, `argv` always a vector and never a shell string, a
 * pinned `cwd`, a neutral home directory, system and global git configuration
 * disabled, and no interactive credential prompt. `runGit`/`runGh` differ only
 * in which executable and which neutral-config flags apply.
 */
export function createExec(options: ExecOptions): Exec {
  const gitExecutable = options.gitExecutable ?? 'git';
  const ghExecutable = options.ghExecutable ?? 'gh';
  const credentialEnv = options.credentialEnv ?? new Map<EnvVarName, string>();

  // A directory outside every declaration's clone and outside any real user
  // profile, so no per-user `.gitconfig`, credential cache or alias can reach
  // a child this module spawns — "neutral home directory" (design § Exec).
  const neutralHome = path.join(options.volumeRoot, '_exec-home');
  mkdirSync(neutralHome, { recursive: true });

  /**
   * The credential channel (`10-design.md` § credential resolution): "git does
   * not read one from a bare variable", so Exec supplies the helper itself.
   *
   * The helper is a file rather than an inline `!`-command because the value
   * would otherwise have to carry shell quoting through `-c`, and the one
   * thing that must never end up quoted into a command line is anything
   * touching the secret. This script names no secret and no variable: it reads
   * the *variable name* from `SZG_CREDENTIAL_VAR` and dereferences it inside
   * the child, so the value exists only in the child's environment and in the
   * pipe git reads the answer from. Nothing about it reaches `argv`, which is
   * invariant S5's process-argument-vector half.
   *
   * Written once at construction, into the neutral home that is already
   * outside every clone.
   */
  const credentialHelperPath = path.join(neutralHome, 'credential-helper.sh');
  writeFileSync(
    credentialHelperPath,
    [
      '#!/bin/sh',
      '# Written by SubZeroDev.Git Exec. Reads the secret from the variable named',
      '# by SZG_CREDENTIAL_VAR; never holds one itself.',
      '[ "$1" = "get" ] || exit 0',
      '[ -n "$SZG_CREDENTIAL_VAR" ] || exit 0',
      'eval "value=\\${$SZG_CREDENTIAL_VAR}"',
      "printf 'username=%s\\n' \"${SZG_CREDENTIAL_USERNAME:-x-access-token}\"",
      "printf 'password=%s\\n' \"$value\"",
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o700 },
  );

  /**
   * Cleared, then set to this service's own helper — "the only configuration
   * git sees is the service's own". Prepended ahead of every element of
   * `request.argv`, so a caller cannot get in front of it.
   */
  function credentialConfigArgs(): readonly string[] {
    return ['-c', 'credential.helper=', '-c', `credential.helper=!'${credentialHelperPath.replace(/\\/g, '/')}'`];
  }

  /**
   * Redacts every resolved secret currently in the shared `MutableEnv`, then
   * the URL-embedded credential form. Reads the map at call time rather than
   * closing over a snapshot, because resolution happens at point of use and a
   * value written moments before this call must still be redacted.
   *
   * Short values are skipped: a one- or two-character "secret" would turn
   * ordinary output into a wall of asterisks, and the mount holding one is a
   * deployment fault this module cannot fix by mangling git's output.
   */
  function scrubText(text: string): string {
    let out = text;
    for (const secret of credentialEnv.values()) {
      if (secret.length < 4) continue;
      out = out.split(secret).join(REDACTION);
    }
    return scrubUrlCredentials(out);
  }

  function scrubJsonValue(value: JsonValue): JsonValue {
    if (typeof value === 'string') return scrubText(value);
    if (Array.isArray(value)) return (value as JsonArray).map(scrubJsonValue);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [key, v] of Object.entries(value as JsonObject)) out[key] = scrubJsonValue(v);
      return out;
    }
    return value;
  }

  function neutralGitEnv(): NodeJS.ProcessEnv {
    return {
      // PATH (and on Windows, SystemRoot) are required for the OS loader and
      // DNS resolution to work at all; nothing else from this process's own
      // environment is inherited, which is what keeps the child's environment
      // a fixed, known set rather than whatever the host process happened to carry.
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: neutralHome,
      USERPROFILE: neutralHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  async function run(
    executable: string,
    request: ExecRequest,
    extraEnv: NodeJS.ProcessEnv,
    /** `gh` takes no `-c credential.helper`; it reads its own token variable, which is S10's business. */
    configuresGitCredentialHelper: boolean,
  ): Promise<Outcome<ExecResult, ExecError>> {
    if (request.signal.aborted) {
      return err(execError({ code: 'cancelled' }, 'the operation was cancelled before the child started'));
    }

    const env: NodeJS.ProcessEnv = { ...extraEnv };
    let argv: readonly string[] = request.argv;
    if (request.credential) {
      const value = credentialEnv.get(request.credential.variableName);
      if (value !== undefined) {
        env[request.credential.variableName] = value;
        // The helper is configured only when there is actually a secret for it
        // to hand over. Configuring it against an unset variable would answer
        // git with an empty password, turning a resolution failure into an
        // authentication rejection and marking a reference that never resolved.
        env.SZG_CREDENTIAL_VAR = request.credential.variableName;
        if (configuresGitCredentialHelper) argv = [...credentialConfigArgs(), ...request.argv];
        // `gh` has no credential-helper protocol; it reads a token from
        // `GH_TOKEN` in its own environment. Same channel as git's helper and
        // the same guarantee: the value exists only in the child's
        // environment, and nothing about it reaches `argv` (invariant S5).
        // Set only in the `gh` child, so a git child never gains a second
        // variable holding the same secret.
        if (!configuresGitCredentialHelper) env.GH_TOKEN = value;
      }
    }

    const started = Date.now();

    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        options.onSpawn?.(executable, argv);
        child = spawn(executable, [...argv], {
          cwd: request.cwd,
          env,
          shell: false,
          windowsHide: true,
        });
      } catch {
        resolve(err(execError({ code: 'spawn-failed' }, `could not start '${executable}'`)));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;

      const finish = (outcome: Outcome<ExecResult, ExecError>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill('SIGKILL');
        },
        Math.max(0, request.timeoutSeconds) * 1000,
      );

      const onAbort = (): void => {
        child.kill('SIGKILL');
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('error', () => {
        finish(err(execError({ code: 'spawn-failed' }, `could not start '${executable}'`)));
      });

      child.on('close', (code, signal) => {
        const durationMs = Date.now() - started;
        const stdout = scrubText(Buffer.concat(stdoutChunks).toString('utf8'));
        const stderr = scrubText(Buffer.concat(stderrChunks).toString('utf8'));

        if (timedOut) {
          finish(err(execError({ code: 'timed-out', limitSeconds: request.timeoutSeconds }, `'${executable}' exceeded its ${request.timeoutSeconds}s cap`)));
          return;
        }
        if (request.signal.aborted) {
          finish(err(execError({ code: 'cancelled' }, 'the operation was cancelled')));
          return;
        }
        if (signal !== null || code === null) {
          finish(err(execError({ code: 'spawn-failed' }, `'${executable}' terminated abnormally`)));
          return;
        }

        if (code !== 0) {
          finish(err(execError({ code: 'nonzero-exit', exitCode: code, stderr }, `'${executable}' exited ${code}`)));
          return;
        }

        finish(ok({ exitCode: code, stdout, stderr, durationMs, timedOut: false }));
      });
    });
  }

  return {
    runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
      return run(gitExecutable, request, neutralGitEnv(), true);
    },
    runGh(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
      // `gh` reads its own config directory from `HOME`/`USERPROFILE` too, so
      // the same neutral redirection keeps it off any real user's `gh` config.
      return run(ghExecutable, request, { PATH: process.env.PATH, HOME: neutralHome, USERPROFILE: neutralHome, GH_PROMPT_DISABLED: '1' }, false);
    },
    scrub(text: string): string {
      return scrubText(text);
    },
    scrubJson(value: JsonValue): JsonValue {
      return scrubJsonValue(value);
    },
  };
}
