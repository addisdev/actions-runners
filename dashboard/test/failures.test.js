// Annotation classification (lib/failures.js) for causes a workflow, not
// GitHub, names. Held-timeout classification lives in verdict.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAnnotations, FAILURE_CLASSES } from '../lib/failures.js';
import { NOT_YOUR_CODE } from '../lib/verdict.js';

describe('host-diagnosed classification', () => {
  test("a workflow's host diagnosis wins over the step's exit code", () => {
    assert.equal(classifyAnnotations([
      'Process completed with exit code 70.',
      "CoreSimulator on build-host is older than this Xcode needs — run 'sudo xcodebuild -runFirstLaunch' there, then re-run. The runner host needs attention, this is not a code failure",
    ]), 'host-broken');
    assert.equal(classifyAnnotations(['Simulator would not boot after 3 attempts — the runner host needs attention, this is not a code failure']), 'host-broken');
  });

  test('a failure the workflow pinned on the code stays job-failed', () => {
    assert.equal(classifyAnnotations(['UnitTests failed again when retried alone after the runner died — a failure of the code, not the host']), 'job-failed');
    assert.equal(classifyAnnotations(['Unit tests failed on their own merits — not retrying']), 'job-failed');
  });

  test('the class blames the host and is not your code', () => {
    assert.equal(FAILURE_CLASSES['host-broken'].blame, 'host');
    assert.ok(NOT_YOUR_CODE.includes('host-broken'));
  });
});
