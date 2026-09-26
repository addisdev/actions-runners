import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sizeFleet, roleFromJobLabels, sizingKey } from '../lib/sizing.js';
import { makeRunner } from './fixtures/index.js';

const REPO = 'testowner/app-ios';
const TRIMMED = 'testowner/trimmed-app';

const queuedFor = (repo, n = 1) =>
  Array.from({ length: n }, () => ({ repo, status: 'queued' }));

describe('sizeFleet — repos with no runner', () => {
  // The default stays as it was: sizing is built from the runner list, so a repo
  // with nothing registered is invisible to it.
  test('are invisible unless asked for', () => {
    const out = sizeFleet({
      runners: [makeRunner({ repo: REPO })],
      active: queuedFor(TRIMMED),
    });
    assert.equal(out.some((r) => r.repo === TRIMMED), false);
  });

  test('appear as have=0 want=1 when asked for', () => {
    const out = sizeFleet({
      runners: [makeRunner({ repo: REPO })],
      active: queuedFor(TRIMMED),
      includeUnserved: true,
    });
    const row = out.find((r) => r.repo === TRIMMED);
    assert.ok(row, 'the trimmed repo should be sized');
    assert.equal(row.have, 0);
    // One runner, not p90 demand: the question at have === 0 is whether the repo
    // can build at all. Asking for a second is the next tick's job, with the
    // cooldown and headroom gate that come with it.
    assert.equal(row.want, 1);
    assert.equal(row.delta, 1);
    assert.equal(row.unserved, true);
  });

  // The guard that keeps this from undoing a trim. Every repo ever trimmed still
  // has months of job history, so sizing off history would ask for all of them
  // back in one sweep. Only a live queued run counts as the repo asking.
  test('are not requested on history alone, only on a live queue', () => {
    const out = sizeFleet({
      runners: [makeRunner({ repo: REPO })],
      active: [],
      concurrency: new Map([[TRIMMED, { jobs: 500, peak: 9, p50: 2, p90: 6 }]]),
      includeUnserved: true,
    });
    assert.equal(out.some((r) => r.repo === TRIMMED), false);
  });

  test('a repo that still has a runner is never reported as unserved', () => {
    const out = sizeFleet({
      runners: [makeRunner({ repo: REPO })],
      active: queuedFor(REPO, 2),
      includeUnserved: true,
    });
    const row = out.find((r) => r.repo === REPO);
    assert.equal(row.unserved, undefined);
    assert.equal(row.have, 1);
  });
});

describe('sizeFleet — per-role rows', () => {
  test('sizes ci and ui-web independently for one repo', () => {
    const out = sizeFleet({
      runners: [
        makeRunner({ extraLabels: ['ci'] }),
        makeRunner({ extraLabels: ['ui-web'], name: 'host-ui', dirName: 'app-ios-ui' }),
      ],
      active: [{
        repo: REPO,
        status: 'queued',
        jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ui-web'] }],
      }],
    });
    const ci = out.find((r) => r.role === 'ci');
    const ui = out.find((r) => r.role === 'ui-web');
    assert.equal(ci.have, 1);
    assert.equal(ci.delta, 0);
    assert.equal(ui.have, 1);
    assert.equal(ui.delta, 1);
  });

  test('roleFromJobLabels strips platform labels', () => {
    assert.equal(roleFromJobLabels(['self-hosted', 'macos', 'arm64', 'ci']), 'ci');
    assert.equal(sizingKey(REPO, 'ci'), `${REPO}\0ci`);
  });

  test('role deficits share the repo-wide runner cap', () => {
    const out = sizeFleet({
      runners: [
        makeRunner({ extraLabels: ['ci'] }),
        makeRunner({ extraLabels: ['ui-web'], name: 'host-ui', dirName: 'app-ios-ui' }),
      ],
      active: [
        ...Array.from({ length: 3 }, (_, id) => ({
          id: `ci-${id}`, repo: REPO, status: 'queued',
          jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ci'] }],
        })),
        ...Array.from({ length: 3 }, (_, id) => ({
          id: `ui-${id}`, repo: REPO, status: 'queued',
          jobs: [{ status: 'queued', labels: ['self-hosted', 'macos', 'arm64', 'ui-web'] }],
        })),
      ],
      limits: { maxInstancesPerRepo: 4 },
    });
    assert.equal(out.reduce((sum, row) => sum + row.want, 0), 4);
    assert.equal(out.reduce((sum, row) => sum + row.delta, 0), 2);
    assert.ok(out.some((row) => row.capped));
  });
});
