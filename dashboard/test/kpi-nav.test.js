// UI contract: the live KPI summary cards must be native <button> elements
// with onclick handlers that navigate to the correct dashboard tab.
//
// This is a static source check — no browser, no build step. It verifies the
// wiring is present without exercising it, which is the right fit for a
// zero-dependency test suite that cannot run a DOM.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', 'public', 'app.js'), 'utf8');

describe('KPI card navigation contract', () => {
  test('statTile renders a <button> when onclick is provided', () => {
    assert.match(src, /const tag = onclick \? 'button' : 'div'/);
  });

  test('setView centralises tab-switching logic', () => {
    assert.match(src, /function setView\(name\)/);
    assert.match(src, /aria-selected/);
    assert.match(src, /is-entering/);
  });

  test('kpiNav helper is defined', () => {
    assert.match(src, /function kpiNav\(tabName, scrollTarget\)/);
  });

  test('Runners online → Fleet tab with runner-grid scroll', () => {
    assert.match(src, /label: 'Runners online'[\s\S]*?onclick: kpiNav\('fleet', '#fleet'\)/);
  });

  test('Building now → Runs tab with active-runs scroll', () => {
    assert.match(src, /label: 'Building now'[\s\S]*?onclick: kpiNav\('runs', '#active'\)/);
  });

  test('Queued → Fleet tab with queue section scroll', () => {
    assert.match(src, /label: 'Queued'[\s\S]*?onclick: kpiNav\('fleet', '#fleet-queue'\)/);
  });

  test('Open alerts → Alerts tab', () => {
    assert.match(src, /label: 'Open alerts'[\s\S]*?onclick: kpiNav\('alerts'\)/);
  });

  test('Drift → Fleet tab with drift-section scroll', () => {
    assert.match(src, /label: 'Drift'[\s\S]*?onclick: kpiNav\('fleet', '#drift'\)/);
  });

  test('Memory pressure → Capacity tab', () => {
    assert.match(src, /label: 'Memory pressure'[\s\S]*?onclick: kpiNav\('capacity'\)/);
  });

  test('Load → Capacity tab', () => {
    assert.match(src, /label: 'Load'[\s\S]*?onclick: kpiNav\('capacity'\)/);
  });

  test('Disk free → Capacity tab', () => {
    assert.match(src, /label: 'Disk free'[\s\S]*?onclick: kpiNav\('capacity'\)/);
  });

  test('button.kpi reset styles are present in style.css', () => {
    const css = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /button\.kpi/);
    assert.match(css, /cursor: pointer/);
    assert.match(css, /text-align: left/);
  });

  test('federated fleet KPIs use fleetRunners when federation is enabled', () => {
    assert.match(src, /function isFederated\(s\)/);
    assert.match(src, /const federated = isFederated\(s\)/);
    assert.match(src, /federated \? \(s\.fleetRunners/);
    assert.match(src, /s\.federation\?\.runnersBusy/);
  });

  test('federation summary links to the Hosts tab', () => {
    assert.match(src, /function renderFederationSummary\(s\)/);
    assert.match(src, /onclick: \(\) => setView\('hosts'\)/);
  });
});
