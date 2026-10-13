import { loadConfig } from './config.ts';
import { createProxy } from './proxy.ts';

try {
  const config = loadConfig();
  const server = createProxy(config);
  server.on('error', () => { console.error('Proxy could not start'); process.exitCode = 1; });
  server.listen(config.port, '127.0.0.1', () => console.log('MCP proxy ready on loopback'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
} catch {
  console.error('Invalid proxy configuration; see env.example');
  process.exitCode = 1;
}
