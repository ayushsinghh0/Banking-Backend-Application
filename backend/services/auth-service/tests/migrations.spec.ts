import fs from 'fs';
import path from 'path';

/**
 * Static checks on the SQL migrations (they are applied to real Postgres by the migrate job, not here).
 */
const dir = path.join(__dirname, '..', 'prisma', 'migrations');
const migrations = fs
  .readdirSync(dir)
  .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
  .sort()
  .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8') }));
/** SQL without comments, whitespace collapsed */
const code = (sql: string) => sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

describe('auth-service migrations', () => {
  it('are named <14-digit timestamp>_<snake_case>', () => {
    for (const { name } of migrations) expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/);
  });

  it('STEP-UP: users who enabled MFA before mfa_enabled_at existed get it backfilled', () => {
    const added = migrations.findIndex(({ sql }) => /ADD COLUMN\s+"mfa_enabled_at"/.test(sql));
    expect(added).toBeGreaterThanOrEqual(0);
    const backfill = migrations.slice(added).find(({ sql }) => /UPDATE "users"/.test(code(sql)));
    expect(backfill).toBeDefined();
    const statement = code(backfill!.sql);
    expect(statement).toMatch(/SET "mfa_enabled_at" = /);
    expect(statement).toMatch(/WHERE "mfa_enabled" = true AND "mfa_enabled_at" IS NULL/);
  });

  it('CREATE INDEX CONCURRENTLY runs alone (Postgres refuses it inside a multi-statement migration)', () => {
    for (const { name, sql } of migrations.filter(({ sql }) => /CONCURRENTLY/i.test(sql))) {
      const statements = code(sql).split(';').filter((s) => s.trim());
      expect([name, statements.length]).toEqual([name, 1]);
    }
  });
});
