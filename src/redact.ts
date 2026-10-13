import { Transform } from 'node:stream';

function secretForms(secret: string): string[] {
  return [...new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])];
}

export function redactText(value: string, secret: string): string {
  for (const form of secretForms(secret)) value = value.split(form).join('[REDACTED]');
  return value;
}

// Only retain a suffix that could become a secret; complete SSE events flush immediately.
export function secretFilter(secret: string): Transform {
  const patterns = secretForms(secret)
    .map(s => Buffer.from(s)).sort((a, b) => b.length - a.length);
  let pending = Buffer.alloc(0);
  function consume(final: boolean): Buffer {
    const parts: Buffer[] = [];
    let start = 0;
    let i = 0;
    while (i < pending.length) {
      const match = patterns.find(p => pending.subarray(i, i + p.length).equals(p));
      if (match) {
        parts.push(pending.subarray(start, i), Buffer.from('[REDACTED]'));
        i += match.length;
        start = i;
      } else {
        if (!final && patterns.some(p => pending.length - i < p.length &&
            p.subarray(0, pending.length - i).equals(pending.subarray(i)))) break;
        i++;
      }
    }
    parts.push(pending.subarray(start, i));
    pending = Buffer.from(pending.subarray(i));
    return Buffer.concat(parts);
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      callback(null, consume(false));
    },
    flush(callback) { callback(null, consume(true)); },
  });
}
