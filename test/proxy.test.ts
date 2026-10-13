import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import { loadConfig } from '../src/config.ts';
import { createProxy } from '../src/proxy.ts';

const key = await generateKeyPair('RS256');
const otherKey = await generateKeyPair('RS256');
const token = 'fixture-openscreen-token-1234567890+/=';
const issuer = 'https://fixture.cloudflareaccess.com';
const audience = 'fixture-audience';

async function jwt(overrides: JWTPayload = {}, signingKey = key.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: [audience], sub: 'alice', email: 'alice@example.com',
    type: 'app', iat: now - 1, nbf: now - 1, exp: now + 60, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(signingKey);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function rawStatus(url: string, headers: Record<string, string | string[]>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end();
  });
}

async function fixture(t: TestContext, handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const received: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const upstream = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', chunk => parts.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() });
      if (handler) handler(req, res);
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  const upstreamPort = await listen(upstream);
  const jwk = await exportJWK(key.publicKey);
  const jwks = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ keys: [{ ...jwk, kid: 'fixture', alg: 'RS256' }] })));
  const jwksPort = await listen(jwks);
  const config = loadConfig({ PUBLIC_MCP_URL: 'https://mcp.example.com/mcp', CF_ACCESS_ISSUER: issuer,
    CF_ACCESS_AUD: audience, ALLOWED_EMAILS: 'alice@example.com,bob@example.com',
    OPENSCREEN_TOKEN: token, OPENSCREEN_MCP_URL: `http://127.0.0.1:${upstreamPort}/mcp` });
  const proxy = createProxy(config, createRemoteJWKSet(new URL(`http://127.0.0.1:${jwksPort}/keys`), { timeoutDuration: 500 }));
  const port = await listen(proxy);
  config.port = port;
  t.after(async () => { await close(proxy); await close(upstream); await close(jwks); });
  return { received, proxy, jwks, upstream, config, url: `http://127.0.0.1:${port}/mcp`, port,
    async call(options: RequestInit = {}, path = '/mcp') {
      const headers = new Headers(options.headers);
      if (!headers.has('cf-access-jwt-assertion')) headers.set('cf-access-jwt-assertion', await jwt());
      return fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers, redirect: 'manual', signal: options.signal ?? AbortSignal.timeout(5000) });
    },
  };
}

test('POST bytes and MCP headers survive; credentials and arbitrary headers stay private', async t => {
  const f = await fixture(t);
  const data = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
  const r = await f.call({ method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
    authorization: 'Bearer client-opaque-token', cookie: 'CF_Authorization=private-cookie',
    'cf-access-client-secret': 'must-not-forward', 'x-forwarded-host': 'evil.example', origin: 'https://mcp.example.com' }, body: data });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: 1, result: {} });
  const upstream = f.received[0]!;
  assert.equal(upstream.method, 'POST');
  assert.equal(upstream.path, '/mcp');
  assert.equal(upstream.body, data);
  assert.equal(upstream.headers.authorization, `Bearer ${token}`);
  assert.equal(upstream.headers['mcp-protocol-version'], '2025-06-18');
  for (const h of ['cookie', 'cf-access-jwt-assertion', 'cf-access-client-secret', 'origin', 'x-forwarded-host']) {
    assert.equal(upstream.headers[h], undefined);
  }
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

const invalidClaims: [string, JWTPayload][] = [
  ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }],
  ['wrong audience', { aud: ['another-app'] }],
  ['expired', { exp: 1 }],
  ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 60 }],
  ['future issuance', { iat: Math.floor(Date.now() / 1000) + 30 }],
  ['missing expiry', { exp: undefined }],
  ['missing issuance', { iat: undefined }],
  ['missing subject', { sub: undefined }],
  ['service identity', { sub: '', email: undefined }],
  ['global token', { type: 'org' }],
  ['disallowed identity', { email: 'mallory@example.com' }],
];
for (const [name, claims] of invalidClaims) {
  test(`reject ${name} without reaching OpenScreen`, async t => {
    const f = await fixture(t);
    const r = await f.call({ headers: { 'cf-access-jwt-assertion': await jwt(claims) } });
    assert.equal(r.status, 401);
    assert.equal(f.received.length, 0);
  });
}

test('forged signature, unsigned JWT, opaque OAuth token, cookie and upstream Bearer cannot bypass auth', async t => {
  const f = await fixture(t);
  const forged = await jwt({}, otherKey.privateKey);
  for (const assertion of [forged, 'eyJhbGciOiJub25lIn0.e30.', 'oauth:opaque', 'invalid']) {
    const r = await f.call({ headers: { 'cf-access-jwt-assertion': assertion } });
    assert.equal(r.status, 401);
  }
  const r = await fetch(f.url, { headers: { authorization: `Bearer ${token}`, cookie: `CF_Authorization=${await jwt()}` } });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  assert.equal(f.received.length, 0);
});

test('JWKS outage fails closed', async t => {
  const f = await fixture(t);
  await close(f.jwks);
  assert.equal((await f.call()).status, 401);
  assert.equal(f.received.length, 0);
});

test('reject foreign origin, Host, extra paths, query strings, and unsupported methods', async t => {
  const f = await fixture(t);
  for (const path of ['/mcp?target=http://evil.test', '/sse', '/mcp/', '/.well-known/oauth-protected-resource']) {
    assert.equal((await f.call({}, path)).status, 404);
  }
  assert.equal((await f.call({ headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal(await rawStatus(f.url, { host: 'evil.test', 'cf-access-jwt-assertion': await jwt() }), 403);
  assert.equal((await f.call({ method: 'PUT' })).status, 405);
  assert.equal((await f.call({ method: 'OPTIONS' })).status, 405);
  assert.equal(f.received.length, 0);
});

test('reject duplicate assertions and hop-by-hop nomination of MCP headers', async t => {
  const f = await fixture(t);
  const assertion = await jwt();
  const status = await rawStatus(f.url, { 'cf-access-jwt-assertion': [assertion, assertion] });
  assert.equal(status, 400);
  assert.equal(await rawStatus(f.url, { connection: 'mcp-protocol-version',
    'mcp-protocol-version': '2025-06-18', 'cf-access-jwt-assertion': assertion }), 400);
  assert.equal(f.received.length, 0);
});

test('reject oversized body before upstream side effects', async t => {
  const f = await fixture(t);
  const r = await f.call({ method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(r.status, 413);
  assert.equal(f.received.length, 0);
});

test('stateful initialize, GET resumption, DELETE and identity isolation', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.method === 'DELETE') res.writeHead(204).end();
    else res.writeHead(200, { 'mcp-session-id': 'session-123', 'content-type': 'application/json' }).end('{}');
  });
  const initialize = await f.call({ method: 'POST', body: '{"method":"initialize"}' });
  assert.equal(initialize.headers.get('mcp-session-id'), 'session-123');
  await initialize.text();
  const h = { 'mcp-session-id': 'session-123' };
  const unauthorized = await f.call({ headers: { ...h, 'cf-access-jwt-assertion': await jwt({ sub: 'bob', email: 'bob@example.com' }) } });
  assert.equal(unauthorized.status, 404);
  assert.equal((await f.call({ headers: { 'mcp-session-id': 'unknown' } })).status, 404);
  const resumed = await f.call({ headers: { ...h, 'last-event-id': 'event-7' } });
  assert.equal(resumed.status, 200);
  await resumed.text();
  assert.equal(f.received[1]!.headers['last-event-id'], 'event-7');
  assert.equal(f.received[1]!.headers['mcp-session-id'], 'session-123');
  assert.equal((await f.call({ method: 'DELETE', headers: h })).status, 204);
  assert.equal((await f.call({ headers: h })).status, 404);
  assert.equal(f.received.length, 3);
});

test('upstream redirects and authentication failures never expose credentials', async t => {
  for (const status of [302, 401, 403]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status, { location: 'http://evil.test', 'www-authenticate': `Bearer ${token}`, 'set-cookie': `secret=${token}` }).end(token);
    });
    const r = await f.call();
    assert.equal(r.status, 502);
    assert.equal((await r.text()).includes(token), false);
    for (const header of ['location', 'www-authenticate', 'set-cookie']) assert.equal(r.headers.get(header), null);
  }
});

test('chunked JSON secret echo is redacted, including URL encoding; sensitive headers stripped', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `secret=${token}`, 'x-debug': token });
    res.write('{"echo":"');
    res.write(token.slice(0, 10));
    res.write(token.slice(10));
    res.end(`","encoded":"${encodeURIComponent(token)}"}`);
  });
  const r = await f.call();
  assert.deepEqual(await r.json(), { echo: '[REDACTED]', encoded: '[REDACTED]' });
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-debug'), null);
  assert.equal(r.headers.get('content-length'), null);
});

test('SSE first event arrives while upstream remains open; disconnect cancels upstream', async t => {
  let disconnected!: () => void;
  const disconnect = new Promise<void>(resolve => { disconnected = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('id: 7\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    res.once('close', disconnected);
  });
  const controller = new AbortController();
  const r = await f.call({ headers: { accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body!.getReader();
  const first = await Promise.race([reader.read(), delay(2000).then(() => { throw new Error('SSE buffered'); })]);
  assert.equal(new TextDecoder().decode(first.value), 'id: 7\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
  controller.abort();
  await Promise.race([disconnect, delay(2000).then(() => { throw new Error('Upstream still open'); })]);
});

test('SSE token split over timed chunks is redacted without buffering later events', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + token.slice(0, 10));
    setTimeout(() => res.end(token.slice(10) + '\n\ndata: done\n\n'), 25);
  });
  const r = await f.call();
  assert.equal(await r.text(), 'data: [REDACTED]\n\ndata: done\n\n');
});

test('upstream network failure returns a generic error', async t => {
  const f = await fixture(t);
  await close(f.upstream);
  const r = await f.call();
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'Request failed' });
});

test('secret in a session header fails closed; encoded secret in allowed response headers is redacted', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(200, {
    'mcp-session-id': encodeURIComponent(token), 'content-type': 'application/json',
  }).end('{}'));
  const r = await f.call();
  assert.equal(r.status, 502);
  assert.equal(r.headers.get('mcp-session-id'), null);
  const g = await fixture(t, (_req, res) => res.writeHead(429, {
    'retry-after': encodeURIComponent(token), 'content-type': 'application/json',
  }).end('{}'));
  const rateLimit = await g.call();
  assert.equal(rateLimit.status, 429);
  assert.equal(rateLimit.headers.get('retry-after'), '[REDACTED]');
});

test('open stream closes when assertion expires', async t => {
  let closed!: () => void;
  const closedPromise = new Promise<void>(resolve => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: connected\n\n');
    res.once('close', closed);
  });
  const r = await f.call({ headers: { 'cf-access-jwt-assertion': await jwt({ exp: Math.floor(Date.now() / 1000) + 2 }) } });
  const reader = r.body!.getReader();
  await reader.read();
  await Promise.race([closedPromise, delay(3500).then(() => { throw new Error('Expired stream still open'); })]);
  await assert.rejects(async () => { while (!(await reader.read()).done) { /* Drain until expiry aborts. */ } });
});

test('configuration rejects remote upstreams, embedded credentials and header injection', () => {
  const env = { PUBLIC_MCP_URL: 'https://mcp.example.com/mcp', CF_ACCESS_ISSUER: issuer,
    CF_ACCESS_AUD: audience, ALLOWED_EMAILS: 'alice@example.com', OPENSCREEN_TOKEN: token };
  for (const upstream of ['https://evil.test/mcp', 'http://localhost:47821/mcp', 'http://127.0.0.1:47821/mcp?secret=x', 'http://user:pass@127.0.0.1:47821/mcp']) {
    assert.throws(() => loadConfig({ ...env, OPENSCREEN_MCP_URL: upstream }));
  }
  assert.throws(() => loadConfig({ ...env, OPENSCREEN_TOKEN: 'injection\r\nx: 1' }));
  assert.throws(() => loadConfig({ ...env, CF_ACCESS_ISSUER: 'https://evil.test' }));
  assert.throws(() => loadConfig({ ...env, CF_ACCESS_AUD: '' }));
  assert.throws(() => loadConfig({ ...env, ALLOWED_EMAILS: '*' }));
});
