import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsableBytes } from '../lib/local.js';

// osascript prints the byte count macOS will provide on request (purgeable
// included). Anything else must read as unknown, so the caller falls back to df
// instead of reporting a full or an empty disk.
test('usable disk: bytes become GB', () => {
  assert.equal(parseUsableBytes('174906585088\n'), 174906585088 / 1073741824);
});

test('usable disk: an error, an empty answer or zero is unknown', () => {
  for (const raw of ['', null, undefined, 'NaN', '0', '-5', 'execution error: -2700', '12.5']) {
    assert.equal(parseUsableBytes(raw), null, `for ${JSON.stringify(raw)}`);
  }
});
