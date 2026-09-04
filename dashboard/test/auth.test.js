import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../lib/auth.js';

const TOKEN = 'a'.repeat(64);
const BASE = { port: 7878, host: '127.0.0.1' };

function req(auth, origin) {
  const headers = {};
  if (auth !== undefined) headers.authorization = auth;
  if (origin !== undefined) headers.origin = origin;
  return { headers };
}

describe('authorize', () => {
  test('returns ok for a valid token', () => {
    const r = authorize(req(`Bearer ${TOKEN}`), TOKEN, BASE);
    assert.equal(r.ok, true);
  });

  test('returns 401 when no Authorization header is present', () => {
    const r = authorize(req(), TOKEN, BASE);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  test('returns 401 when Authorization header is not a Bearer token', () => {
    const r = authorize(req('Basic aGVsbG8='), TOKEN, BASE);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  test('returns 403 when token is wrong', () => {
    const r = authorize(req('Bearer wrongtoken'), TOKEN, BASE);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  test('returns 403 when token is the right length but wrong value', () => {
    const wrong = 'b'.repeat(64);
    const r = authorize(req(`Bearer ${wrong}`), TOKEN, BASE);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  test('allows a matching Origin header (same-origin dashboard request)', () => {
    const r = authorize(req(`Bearer ${TOKEN}`, `http://127.0.0.1:${BASE.port}`), TOKEN, BASE);
    assert.equal(r.ok, true);
  });

  test('allows localhost as Origin', () => {
    const r = authorize(req(`Bearer ${TOKEN}`, `http://localhost:${BASE.port}`), TOKEN, BASE);
    assert.equal(r.ok, true);
  });

  test('returns 403 for a cross-origin request', () => {
    const r = authorize(req(`Bearer ${TOKEN}`, 'https://evil.example.com'), TOKEN, BASE);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.error, /cross-origin/);
  });

  test('returns 403 if token null (read-only mode sentinel)', () => {
    // CONTROL_TOKEN is null in read-only mode; any bearer would be wrong.
    const r = authorize(req(`Bearer ${TOKEN}`), null, BASE);
    assert.equal(r.ok, false);
  });
});
