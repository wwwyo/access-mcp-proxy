import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Config } from './config.ts';

export function createVerifier(config: Config, keys?: JWTVerifyGetKey) {
  const jwks = keys ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', config.issuer), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 300_000,
  });
  return async (assertion: string) => {
    const { payload } = await jwtVerify(assertion, jwks, {
      algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
      requiredClaims: ['exp', 'iat', 'sub', 'email'], clockTolerance: 0,
    });
    if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub ||
        typeof payload.email !== 'string' || !config.allowedEmails.has(payload.email.toLowerCase()) ||
        typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 ||
        typeof payload.exp !== 'number' || payload.exp <= payload.iat) {
      throw new Error('Unauthorized');
    }
    return { subject: payload.sub, expiresAt: payload.exp * 1000 };
  };
}
