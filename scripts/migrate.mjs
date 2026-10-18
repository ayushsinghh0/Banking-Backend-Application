#!/usr/bin/env node
/**
 * Applies a service's Prisma migrations with its schema-OWNER credentials.
 * Run from a service directory (npm run prisma:deploy). Reads MIGRATION_DATABASE_URL from the
 * environment or the service's .env; the runtime DATABASE_URL (app role) can't run DDL.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')];
      })
  );
}

const fileEnv = readDotEnv(path.join(process.cwd(), '.env'));
const url = process.env.MIGRATION_DATABASE_URL || fileEnv.MIGRATION_DATABASE_URL;
if (!url) {
  console.error(`MIGRATION_DATABASE_URL is not set for ${path.basename(process.cwd())}`);
  process.exit(1);
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
