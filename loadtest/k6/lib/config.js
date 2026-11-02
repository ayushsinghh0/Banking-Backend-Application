// Run-time configuration shared by every scenario. Everything comes from environment variables (`-e NAME=value`
// or `--env`), so the same scripts run against the local stack, a staging cluster or a CI job.
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

/** smoke (default) | load | stress | soak; SMOKE=1 is a shorthand for PROFILE=smoke */
export const PROFILE = (__ENV.SMOKE ? 'smoke' : __ENV.PROFILE || 'smoke').toLowerCase();
if (!['smoke', 'load', 'stress', 'soak'].includes(PROFILE)) {
  throw new Error(`PROFILE must be smoke, load, stress or soak (got ${PROFILE})`);
}

/** Multiplies every think time; 0 turns them off (pure throughput runs) */
export const THINK_SCALE = Number(__ENV.THINK_SCALE ?? 1);

// Seeded customers (loadtest/seed.mjs). Paths in USERS_FILE are used as given (absolute inside the container);
// the default is resolved relative to this file so it works from any working directory.
const USERS_FILE = __ENV.USERS_FILE || import.meta.resolve('../../.data/users.json');

export const users = new SharedArray('users', () => {
  let list;
  try {
    list = JSON.parse(open(USERS_FILE));
  } catch (err) {
    throw new Error(`Cannot read the seeded users from ${USERS_FILE} (run loadtest/seed.mjs first): ${err}`);
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${USERS_FILE} lists no users`);
  for (const u of list) {
    if (!u.email || !u.password || !Array.isArray(u.accounts) || u.accounts.length < 2) {
      throw new Error(`${USERS_FILE}: every user needs email, password and two accounts (re-run the seed)`);
    }
  }
  return list;
});

/** VUs map to users round-robin, so a user is shared by ceil(VUs / users) VUs */
export function currentUser() {
  return users[(exec.vu.idInTest - 1) % users.length];
}

export function accountOf(user, accountType) {
  return user.accounts.find((a) => a.accountType === accountType) ?? user.accounts[0];
}

export const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
export const pick = (items) => items[Math.floor(Math.random() * items.length)];

/** Weighted choice: [[value, weight], ...] */
export function weighted(entries) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1][0];
}
