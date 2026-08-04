import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
   * The `MutableEnv` `CredentialResolver.resolveInto` (S9) writes a resolved
   * secret into, keyed by the `EnvVarName` a `CredentialBinding` names. S9
   * populates it at point of use; nothing in this slice writes to it, so a
   * `request.credential` naming a variable this map does not hold simply runs
   * without one — the credential system does not exist yet, and a missing
   * secret must not be fabricated as an empty string in the child's
   * environment. Not part of `Exec`'s own contract signature: an injectable
   * seam the composition root shares with `CredentialResolver` once it exists,
   * the same way `StructuredStoreOptions.migrations` is a seam and not a
   * contract member.
   */
  readonly credentialEnv?: MutableEnv;
}

// Redacts the credential form a `CloneUrl` can carry (`https://user:pass@host/...`),
// since that is the one secret shape Exec can recognise without knowing any
// actual secret value. Full secret-aware scrubbing — redacting a resolved
// credential's real bytes wherever they appear in output — arrives with
// `CredentialResolver` in S9, which is what can tell this module which value
// to look for.
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/\s@]+@/gi;

function scrubText(text: string): string {
  return text.replace(URL_CREDENTIAL_PATTERN, '$1***@');
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

  async function run(executable: string, request: ExecRequest, extraEnv: NodeJS.ProcessEnv): Promise<Outcome<ExecResult, ExecError>> {
    if (request.signal.aborted) {
      return err(execError({ code: 'cancelled' }, 'the operation was cancelled before the child started'));
    }

    const env: NodeJS.ProcessEnv = { ...extraEnv };
    if (request.credential) {
      const value = credentialEnv.get(request.credential.variableName);
      if (value !== undefined) env[request.credential.variableName] = value;
    }

    const started = Date.now();

    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, [...request.argv], {
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
      return run(gitExecutable, request, neutralGitEnv());
    },
    runGh(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
      // `gh` reads its own config directory from `HOME`/`USERPROFILE` too, so
      // the same neutral redirection keeps it off any real user's `gh` config.
      return run(ghExecutable, request, { PATH: process.env.PATH, HOME: neutralHome, USERPROFILE: neutralHome, GH_PROMPT_DISABLED: '1' });
    },
    scrub(text: string): string {
      return scrubText(text);
    },
    scrubJson(value: JsonValue): JsonValue {
      return scrubJsonValue(value);
    },
  };
}
