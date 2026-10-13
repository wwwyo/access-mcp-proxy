export interface Config {
  publicUrl: URL;
  issuer: string;
  audience: string;
  allowedEmails: Set<string>;
  port: number;
  upstream: URL;
  token: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function required(name: string): string {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing configuration: ${name}`);
    return value;
  }
  const publicUrl = new URL(required('PUBLIC_MCP_URL'));
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/mcp' ||
      publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_MCP_URL must be an HTTPS URL ending in /mcp');
  }
  const issuer = required('CF_ACCESS_ISSUER');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)) {
    throw new Error('CF_ACCESS_ISSUER must be a Cloudflare Access team origin without trailing slash');
  }
  const upstream = new URL(env.OPENSCREEN_MCP_URL ?? 'http://127.0.0.1:47821/mcp');
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' ||
      upstream.username || upstream.password || upstream.pathname !== '/mcp' ||
      upstream.search || upstream.hash) {
    throw new Error('OPENSCREEN_MCP_URL must be http://127.0.0.1:<port>/mcp');
  }
  const port = Number(env.PROXY_PORT ?? 47822);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(upstream.port || 80)) {
    throw new Error('PROXY_PORT must be a distinct valid port');
  }
  const token = required('OPENSCREEN_TOKEN');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length < 16 || token.length > 4096) {
    throw new Error('OPENSCREEN_TOKEN must be a Bearer token of 16–4096 ASCII characters');
  }
  const allowedEmails = new Set(required('ALLOWED_EMAILS').split(',').map(x => x.trim().toLowerCase()));
  if ([...allowedEmails].some(x => !/^[^\s@]+@[^\s@]+$/.test(x))) {
    throw new Error('ALLOWED_EMAILS must contain explicit email addresses');
  }
  return { publicUrl, issuer, audience: required('CF_ACCESS_AUD'), allowedEmails, port, upstream, token };
}
