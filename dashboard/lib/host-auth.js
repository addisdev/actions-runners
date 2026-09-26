import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

function readMap(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createHostToken(path, host) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(host ?? '')) {
    throw new Error('host must contain only letters, numbers, dot, underscore, or dash');
  }
  const token = randomBytes(32).toString('hex');
  const map = readMap(path);
  map[host] = digest(token);
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function hostTokenMatches(path, host, token) {
  const expected = readMap(path)[host];
  if (!expected || !token) return false;
  const actual = digest(token);
  return actual.length === expected.length
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function hasHostToken(path, host) {
  return Boolean(readMap(path)[host]);
}

export function hasHostTokens(path) {
  return Object.keys(readMap(path)).length > 0;
}
