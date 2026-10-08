import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * JSON response writing and bounded request-body reading for every HTTP
 * surface (S64, issue #65). There is no default body limit: each route names
 * its own, so a route can never inherit another's ceiling by omission.
 */

/** Writes `body` as JSON. `headers` are applied after the content headers. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** The request body, or null once it exceeds `maxBytes`; the rest is left unread. */
export async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * The request body as a JSON object. An empty body is `{}`; a body over
 * `maxBytes`, unparseable, or not a plain object is null.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedBody(req, maxBytes);
  if (raw === null) return null;
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
