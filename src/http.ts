#!/usr/bin/env node
// HTTP entry point — serves the MCP Streamable HTTP transport for remote
// clients (Ozwell in a phone browser). nginx terminates TLS at
// https://scinote-mcp.os.mieweb.org/ and proxies here.
//
// The server deliberately holds no ambient authority: each request must carry
// the caller's own SciNote credential, so SciNote itself stays the
// authorization boundary and every write is attributed to a real user.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { createServer } from './server.js';
import { withCredential, type Credential } from './scinote.js';

const MAX_BODY_BYTES = 1_000_000;

function credentialFrom(req: IncomingMessage): Credential | null {
  const apiKey = header(req, 'x-scinote-api-key');
  if (apiKey) return { apiKey };

  const bearer = header(req, 'authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return { jwt: bearer };

  if (config.http.allowSharedCredential && (config.apiKey || config.jwt)) {
    return { apiKey: config.apiKey, jwt: config.jwt };
  }
  return null;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = header(req, 'origin');
  if (!origin) return;
  if (config.http.allowedOrigins.length && !config.http.allowedOrigins.includes(origin)) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SciNote-Api-Key, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  // Browser clients can't read the session id without this.
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

const httpServer = createHttpServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const path = (req.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    sendJson(res, 200, { status: 'ok', scinote: config.baseUrl });
    return;
  }

  if (path !== '/' && path !== '/mcp') {
    rpcError(res, 404, 'Not found');
    return;
  }

  const credential = credentialFrom(req);
  if (!credential) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="scinote"');
    rpcError(res, 401, 'Send your SciNote credential as "X-SciNote-Api-Key" or "Authorization: Bearer <jwt>".');
    return;
  }

  // Stateless: a fresh server and transport per request, so concurrent techs
  // never share a session or a credential. Tools answer in one shot with
  // nothing to stream, and a plain JSON reply survives proxies and flaky phone
  // networks better than a held-open SSE stream.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: config.http.allowedHosts.length > 0 || config.http.allowedOrigins.length > 0,
    allowedHosts: config.http.allowedHosts,
    allowedOrigins: config.http.allowedOrigins
  });
  const server = createServer();
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
    await server.connect(transport);
    await withCredential(credential, () => transport.handleRequest(req, res, body));
  } catch (error) {
    console.error('[scinote-mcp]', error);
    if (!res.headersSent) rpcError(res, 400, error instanceof Error ? error.message : 'Bad request');
  }
});

httpServer.listen(config.http.port, config.http.bind, () => {
  console.error(`scinote-mcp listening on http://${config.http.bind}:${config.http.port}/mcp -> ${config.baseUrl}`);
  if (config.http.allowSharedCredential) {
    console.error('WARNING: SCINOTE_MCP_ALLOW_SHARED_CREDENTIAL=true — unauthenticated callers act as the .env user.');
  }
});
