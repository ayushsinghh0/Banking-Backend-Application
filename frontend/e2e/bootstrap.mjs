#!/usr/bin/env node
/**
 * Creates the two bootstrap administrators the browser journeys need (four-eyes administration needs two)
 * on a FRESH stack, and stores their one-time enrolment tokens in e2e/.state/state.json (git-ignored).
 *
 *   node e2e/bootstrap.mjs
 *   COMPOSE="wsl -d Ubuntu -- docker compose" node e2e/bootstrap.mjs   # Docker inside WSL
 *
 * The journeys then enrol both administrators' authenticators through the UI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, '.state', 'state.json');
const repoRoot = path.resolve(here, '..', '..');
const compose = (process.env.COMPOSE || 'docker compose').split(' ');
const domain = process.env.STAFF_EMAIL_DOMAIN || 'banksphere.local';
const password = process.env.E2E_ADMIN_PASSWORD || 'Journey-Pass-2026';

const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (state.admins?.length === 2) {
  console.log(`Administrators already bootstrapped: ${state.admins.map((a) => a.email).join(', ')}`);
  process.exit(0);
}

const admins = [];
for (const name of ['ops.lead', 'ops.second']) {
  const email = `${name}@${domain}`;
  const [cmd, ...base] = compose;
  const cwd = process.env.COMPOSE_CWD || repoRoot;
  const output = execFileSync(
    cmd,
    [...base, 'run', '--rm', '-T', '--no-deps', '-e', `ADMIN_EMAIL=${email}`, '-e', `ADMIN_PASSWORD=${password}`, 'auth-service', 'node', 'dist/scripts/create-admin.js'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const token = /ENROLMENT_TOKEN=([A-Za-z0-9_-]+)/.exec(output)?.[1];
  if (!token) throw new Error(`create-admin printed no enrolment token for ${email}:\n${output}`);
  admins.push({ email, password, enrolmentToken: token });
  console.log(`Created ${email}`);
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ secrets: {}, usedSteps: {}, ...state, admins }, null, 2), { mode: 0o600 });
console.log(`Saved enrolment tokens to ${path.relative(process.cwd(), stateFile)}`);
