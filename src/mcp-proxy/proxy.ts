/**
 * S14.9: a stdio process that proxies MCP calls to this service's HTTP
 * transport at `/mcp/{declarationId}`. It is a thin transport shim — it
 * opens no volume, takes no lock, and holds no clone. Every git operation
 * happens on the server side; this process only relays JSON-RPC.
 *
 * Configured entirely by environment, since it is what an MCP client's own
 * config (e.g. Claude Desktop's `mcpServers` block) launches directly —
 * there is no interactive setup step.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface ProxyOptions {
  /** This service's origin, e.g. `https://git.example.com`. No trailing slash. */
  readonly origin: string;
  readonly declarationId: string;
  /** An MCP access token, minted by the `/oauth/token` exchange this proxy does not itself perform — dynamic client registration and the browser approval step happen once, outside this process. */
  readonly bearerToken: string;
}

export function resolveProxyOptionsFromEnv(env: NodeJS.ProcessEnv): ProxyOptions {
  const origin = env.SZG_ORIGIN;
  const declarationId = env.SZG_DECLARATION_ID;
  const bearerToken = env.SZG_BEARER_TOKEN;
  if (!origin || !declarationId || !bearerToken) {
    throw new Error('SZG_ORIGIN, SZG_DECLARATION_ID and SZG_BEARER_TOKEN must all be set');
  }
  return { origin, declarationId, bearerToken };
}

/**
 * Builds the proxy without starting it — `connect()` on the returned server
 * is what opens the stdio transport, so a test can construct one against an
 * injected `Client` without a real process's stdin/stdout.
 */
export function createProxyServer(options: ProxyOptions, remoteClient?: Client): { readonly server: Server; readonly remote: Client } {
  const remote =
    remoteClient ??
    new Client({ name: 'subzerodev-git-proxy', version: '1' });

  const server = new Server({ name: 'subzerodev-git-proxy', version: '1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await remote.listTools();
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await remote.callTool(request.params);
    return result;
  });

  return { server, remote };
}

export async function runProxy(options: ProxyOptions): Promise<void> {
  const { server, remote } = createProxyServer(options);

  const remoteTransport = new StreamableHTTPClientTransport(new URL(`${options.origin}/mcp/${options.declarationId}`), {
    requestInit: { headers: { Authorization: `Bearer ${options.bearerToken}` } },
  });
  // The SDK's own `Transport` type declares `sessionId` as always-`string`,
  // but `StreamableHTTPClientTransport` reports `string | undefined` before
  // a session is established — a mismatch in the library's own typings
  // under this repo's `exactOptionalPropertyTypes`, not something this file
  // can correct upstream.
  await remote.connect(remoteTransport as unknown as Parameters<typeof remote.connect>[0]);

  const localTransport = new StdioServerTransport();
  await server.connect(localTransport);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  runProxy(resolveProxyOptionsFromEnv(process.env)).catch((error: unknown) => {
    console.error('mcp-proxy: fatal —', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
