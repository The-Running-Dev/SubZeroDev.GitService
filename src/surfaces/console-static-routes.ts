import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CONSOLE_HASH_FILENAME } from '../lifecycle/console-integrity.ts';

export interface ConsoleStaticDependencies {
  readonly consoleDir: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff2': 'font/woff2',
};

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
}

async function sendFile(res: ServerResponse, absolutePath: string, cacheControl: string): Promise<void> {
  const info = await stat(absolutePath);
  res.writeHead(200, {
    'Content-Type': contentType(absolutePath),
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
  });
  createReadStream(absolutePath).pipe(res);
}

/**
 * S18.9 — the console bundle, served with no unauthenticated route carrying
 * repository, credential, audit, volume or operator state: every file this
 * serves is a static asset from the build, and every data route above it in
 * `handleRequest` still answers `401`. Called last, after every API prefix
 * has had a chance to match, and never for a method other than `GET` — a
 * mutating verb against a path this doesn't recognise falls through to the
 * caller's own `404`, the same as any other unmatched route.
 *
 * `index.html` is served both at the root and as the SPA fallback for any
 * unrecognised `GET` path, so a client-side route survives a reload; a
 * request for a real built asset (a JS/CSS chunk, a font) is served as
 * itself. `console.manifest.sha256` — the companion boot reads at step 2b —
 * is deliberately never served: it names nothing sensitive, but it also
 * serves no purpose to a browser and is excluded on principle, the same way
 * `registry.json.sha256` is never reachable over HTTP either.
 */
export async function handleConsoleStaticRoute(deps: ConsoleStaticDependencies, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const requested = decodeURIComponent(url.pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const resolved = path.resolve(deps.consoleDir, relative);

  // Path-traversal guard: the resolved path must stay inside consoleDir.
  const withinConsoleDir = resolved === deps.consoleDir || resolved.startsWith(deps.consoleDir + path.sep);
  const isHashCompanion = path.basename(resolved) === CONSOLE_HASH_FILENAME;

  if (withinConsoleDir && !isHashCompanion) {
    try {
      await sendFile(res, resolved, relative === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
      return true;
    } catch {
      // Falls through to the SPA fallback below — a missing asset on a
      // client-side route is exactly what the fallback exists to answer.
    }
  }

  // SPA fallback: any other unrecognised GET path still gets the shell.
  try {
    await sendFile(res, path.join(deps.consoleDir, 'index.html'), 'no-cache');
    return true;
  } catch {
    return false;
  }
}
