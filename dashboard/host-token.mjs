#!/usr/bin/env node
import { resolve } from 'node:path';
import { createHostToken } from './lib/host-auth.js';

const host = process.argv[2];
const path = resolve(process.env.FLEET_AGENT_TOKENS_FILE ?? '.fleet-agent-tokens.json');

try {
  const token = createHostToken(path, host);
  process.stdout.write(`${token}\n`);
} catch (err) {
  process.stderr.write(`host-token: ${err.message}\n`);
  process.exitCode = 2;
}
