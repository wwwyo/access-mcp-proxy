import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { JWTVerifyGetKey } from 'jose';
import { createVerifier } from './auth.ts';
import type { Config } from './config.ts';
import { redactText, secretFilter } from './redact.ts';

const requestHeaders = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const responseHeaders = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after'];
const sessionTtl = 24 * 60 * 60 * 1000;
const maxSessions = 1000;
const maxBody = 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) { super('Request rejected'); this.status = status; }
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  if ((req.headersDistinct[name]?.length ?? 0) > 1) throw new HttpError(400);
  const value = req.headers[name];
  if (Array.isArray(value)) throw new HttpError(400);
  return value;
}

function reply(res: ServerResponse, status: number) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: status === 401 ? 'Unauthorized' : 'Request failed' }));
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) throw new HttpError(413);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export function createProxy(config: Config, keys?: JWTVerifyGetKey) {
  const verify = createVerifier(config, keys);
  const sessions = new Map<string, { subject: string; touched: number }>();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void handle(req, res).catch(error => {
      reply(res, error instanceof HttpError ? error.status : 502);
      req.resume();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.timeout = 0;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = singleHeader(req, 'host');
    if (host !== config.publicUrl.host && host !== `127.0.0.1:${config.port}`) throw new HttpError(403);
    if (req.url !== '/mcp') throw new HttpError(404);
    const origin = singleHeader(req, 'origin');
    if (origin && origin !== config.publicUrl.origin) throw new HttpError(403);
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      res.setHeader('allow', 'GET, POST, DELETE');
      throw new HttpError(405);
    }
    const assertion = singleHeader(req, 'cf-access-jwt-assertion');
    if (!assertion) {
      res.setHeader('www-authenticate', 'Bearer');
      throw new HttpError(401);
    }
    let identity: Awaited<ReturnType<typeof verify>>;
    try { identity = await verify(assertion); } catch { throw new HttpError(401); }
    for (const [id, session] of sessions) {
      if (Date.now() - session.touched > sessionTtl) sessions.delete(id);
    }
    const sessionId = singleHeader(req, 'mcp-session-id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.subject !== identity.subject) throw new HttpError(404);
      session.touched = Date.now();
    }
    const connectionTokens = (singleHeader(req, 'connection') ?? '').toLowerCase().split(',').map(x => x.trim());
    if (connectionTokens.some(x => [...requestHeaders, 'cf-access-jwt-assertion', 'host'].includes(x))) {
      throw new HttpError(400);
    }
    const data = await body(req);
    if (req.method !== 'POST' && data.length) throw new HttpError(400);
    if (identity.expiresAt <= Date.now()) throw new HttpError(401);
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.token}`, 'accept-encoding': 'identity',
      'content-length': String(data.length),
    };
    for (const name of requestHeaders) {
      const value = singleHeader(req, name);
      if (value !== undefined) headers[name] = value;
    }
    const upstream = request(config.upstream, { method: req.method, headers });
    const headerTimer = setTimeout(() => upstream.destroy(), 15_000);
    const expiryTimer = setTimeout(() => upstream.destroy(), Math.min(identity.expiresAt - Date.now(), 2_147_483_647));
    const disconnect = () => upstream.destroy();
    res.once('close', disconnect);
    upstream.on('error', () => reply(res, 502));
    upstream.once('close', () => {
      clearTimeout(headerTimer);
      clearTimeout(expiryTimer);
      res.off('close', disconnect);
    });
    upstream.once('response', response => {
      clearTimeout(headerTimer);
      void relay(response).catch(() => { upstream.destroy(); reply(res, 502); });
    });
    upstream.end(data);

    async function relay(response: IncomingMessage) {
      const status = response.statusCode ?? 502;
      if ((status >= 300 && status < 400) || status === 401 || status === 403 ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy();
        throw new HttpError(502);
      }
      const newId = singleHeader(response, 'mcp-session-id');
      if (newId) {
        if (!/^[\x21-\x7e]{1,256}$/.test(newId) || redactText(newId, config.token) !== newId ||
            (sessions.has(newId) && sessions.get(newId)?.subject !== identity.subject) ||
            (!sessions.has(newId) && sessions.size >= maxSessions)) throw new HttpError(502);
        sessions.set(newId, { subject: identity.subject, touched: Date.now() });
      }
      if (sessionId && (status === 404 || (req.method === 'DELETE' && status >= 200 && status < 300))) {
        sessions.delete(sessionId);
      }
      const outgoing: Record<string, string> = { 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
      const hopHeaders = (singleHeader(response, 'connection') ?? '').toLowerCase().split(',').map(x => x.trim());
      for (const name of responseHeaders) {
        const value = singleHeader(response, name);
        if (value !== undefined && !hopHeaders.includes(name)) {
          outgoing[name] = redactText(value, config.token);
        }
      }
      res.writeHead(status, outgoing);
      res.flushHeaders();
      await pipeline(response, secretFilter(config.token), res);
    }
  }
  return server;
}
