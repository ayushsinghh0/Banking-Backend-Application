import crypto from 'crypto';
import { INSTANCE_ID } from '@banksphere/common';

/**
 * An in-memory stand-in for the auth-service Prisma client, for the account-security suites. Unlike the
 * jest.fn() mock in auth.service.spec.ts it keeps real tables and evaluates the `where` clauses the service
 * writes (equality, null, not/in/lt/lte/gt/gte/contains, OR/AND/NOT), orders, pages, projects and joins the
 * user relation, so a test proves behaviour ("only that session is revoked") rather than call shapes. Raw
 * SQL is recognised by shape: row locks, advisory locks, the audit-chain head, job leases and the two
 * retention deletes. Interactive transactions roll the tables back when the callback throws.
 */
type Row = Record<string, any>;

export type Model =
  | 'user'
  | 'refreshToken'
  | 'passwordResetToken'
  | 'emailVerificationToken'
  | 'enrolmentToken'
  | 'adminRequest'
  | 'outboxEvent'
  | 'auditLog'
  | 'userSession'
  | 'securityEvent'
  | 'ipRule';

const SQL_TABLES: Record<string, Model> = {
  users: 'user',
  refresh_tokens: 'refreshToken',
  security_events: 'securityEvent',
  user_sessions: 'userSession',
  ip_rules: 'ipRule',
  audit_log: 'auditLog',
};

const UNIQUE: Partial<Record<Model, string[]>> = {
  user: ['email'],
  refreshToken: ['tokenHash'],
  passwordResetToken: ['tokenHash'],
  emailVerificationToken: ['tokenHash'],
  enrolmentToken: ['tokenHash'],
  outboxEvent: ['seq'],
};

const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object' || v instanceof Date || typeof v === 'bigint';

const toComparable = (v: unknown): number | string | bigint => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as number | string | bigint;
};

function equal(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'bigint' || typeof b === 'bigint') return BigInt(a as never) === BigInt(b as never);
  return toComparable(a) === toComparable(b);
}

function compare(a: unknown, b: unknown): number {
  // Nulls sort last whichever way, like Postgres defaults
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = BigInt(a as never);
    const y = BigInt(b as never);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toComparable(a);
  const y = toComparable(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchesField(value: unknown, cond: any): boolean {
  if (cond === undefined) return true; // Prisma: an undefined filter is no filter
  if (cond === null) return value === null || value === undefined;
  if (isScalar(cond)) return equal(value, cond);
  if ('equals' in cond && !matchesField(value, cond.equals)) return false;
  if ('not' in cond) {
    const not = cond.not;
    if (not === null ? value === null || value === undefined : isScalar(not) ? equal(value, not) : matchesField(value, not)) return false;
  }
  if ('in' in cond && !(cond.in as unknown[]).some((v) => equal(value, v))) return false;
  if ('notIn' in cond && (cond.notIn as unknown[]).some((v) => equal(value, v))) return false;
  if (value === null || value === undefined) {
    return !('lt' in cond || 'lte' in cond || 'gt' in cond || 'gte' in cond || 'contains' in cond || 'startsWith' in cond);
  }
  if ('lt' in cond && !(compare(value, cond.lt) < 0)) return false;
  if ('lte' in cond && !(compare(value, cond.lte) <= 0)) return false;
  if ('gt' in cond && !(compare(value, cond.gt) > 0)) return false;
  if ('gte' in cond && !(compare(value, cond.gte) >= 0)) return false;
  if ('contains' in cond) {
    const haystack = cond.mode === 'insensitive' ? String(value).toLowerCase() : String(value);
    const needle = cond.mode === 'insensitive' ? String(cond.contains).toLowerCase() : String(cond.contains);
    if (!haystack.includes(needle)) return false;
  }
  if ('startsWith' in cond && !String(value).startsWith(String(cond.startsWith))) return false;
  return true;
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matchesWhere(row, w))) return false;
    } else if (key === 'AND') {
      const all = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
      if (!all.every((w) => matchesWhere(row, w))) return false;
    } else if (key === 'NOT') {
      const any = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
      if (any.some((w) => matchesWhere(row, w))) return false;
    } else if (!matchesField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o as Record<string, 'asc' | 'desc'>));
  return [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      const c = compare(a[field], b[field]);
      if (c !== 0) return direction === 'desc' ? -c : c;
    }
    return 0;
  });
}

const notFound = () => Object.assign(new Error('An operation failed because it depends on one or more records that were required but not found.'), { code: 'P2025' });
const uniqueViolation = (field: string) => Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), { code: 'P2002' });

export class FakeModel {
  constructor(
    private readonly db: FakePrisma,
    private readonly model: Model
  ) {}

  private get rows(): Row[] {
    return this.db.tables[this.model];
  }

  private project(row: Row, args: { select?: Row; include?: Row } = {}): Row {
    const out: Row = args.select ? Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, row[k]])) : { ...row };
    if (args.include?.user) out.user = this.db.tables.user.find((u) => u.id === row.userId) ?? null;
    return out;
  }

  private query(args: Row = {}): Row[] {
    let rows = sortRows(this.rows.filter((r) => matchesWhere(r, args.where)), args.orderBy);
    if (args.cursor) {
      const at = rows.findIndex((r) => matchesWhere(r, args.cursor));
      rows = at < 0 ? [] : rows.slice(at);
    }
    if (args.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = JSON.stringify((args.distinct as string[]).map((f) => r[f]));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows;
  }

  public async findMany(args: Row = {}): Promise<Row[]> {
    return this.query(args).map((r) => this.project(r, args));
  }

  public async findFirst(args: Row = {}): Promise<Row | null> {
    const [row] = this.query({ ...args, take: 1 });
    return row ? this.project(row, args) : null;
  }

  public async findUnique(args: Row): Promise<Row | null> {
    return this.findFirst(args);
  }

  public async findUniqueOrThrow(args: Row): Promise<Row> {
    const row = await this.findFirst(args);
    if (!row) throw notFound();
    return row;
  }

  public async count(args: Row = {}): Promise<number> {
    return this.rows.filter((r) => matchesWhere(r, args.where)).length;
  }

  public async create(args: { data: Row; select?: Row; include?: Row }): Promise<Row> {
    const row = this.db.withDefaults(this.model, args.data);
    for (const field of ['id', ...(UNIQUE[this.model] ?? [])]) {
      if (row[field] !== null && row[field] !== undefined && this.rows.some((r) => equal(r[field], row[field]))) throw uniqueViolation(field);
    }
    this.rows.push(row);
    return this.project(row, args);
  }

  private apply(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        if ('increment' in value) row[key] = (row[key] ?? 0) + value.increment;
        else if ('decrement' in value) row[key] = (row[key] ?? 0) - value.decrement;
        else if ('set' in value) row[key] = value.set;
        else row[key] = value; // JSON columns
      } else {
        row[key] = value;
      }
    }
    if (this.model === 'user') row.updatedAt = new Date();
  }

  public async update(args: { where: Row; data: Row; select?: Row; include?: Row }): Promise<Row> {
    const row = this.rows.find((r) => matchesWhere(r, args.where));
    if (!row) throw notFound();
    this.apply(row, args.data);
    return this.project(row, args);
  }

  public async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
    const matched = this.rows.filter((r) => matchesWhere(r, args.where));
    matched.forEach((r) => this.apply(r, args.data));
    return { count: matched.length };
  }

  public async delete(args: { where: Row }): Promise<Row> {
    const at = this.rows.findIndex((r) => matchesWhere(r, args.where));
    if (at < 0) throw notFound();
    return this.rows.splice(at, 1)[0];
  }

  public async deleteMany(args: { where?: Row } = {}): Promise<{ count: number }> {
    const before = this.rows.length;
    this.db.tables[this.model] = this.rows.filter((r) => !matchesWhere(r, args.where));
    return { count: before - this.rows.length };
  }
}

export interface RawCall {
  sql: string;
  values: unknown[];
}

export class FakePrisma {
  public tables: Record<Model, Row[]> = {
    user: [],
    refreshToken: [],
    passwordResetToken: [],
    emailVerificationToken: [],
    enrolmentToken: [],
    adminRequest: [],
    outboxEvent: [],
    auditLog: [],
    userSession: [],
    securityEvent: [],
    ipRule: [],
  };
  /** Every raw statement, in order (job leases, locks, retention deletes) */
  public readonly raw: RawCall[] = [];
  /** Job leases requested through acquireJobLease */
  public readonly leaseRequests: Array<{ name: string; ttlSeconds: number }> = [];
  /** Whether acquireJobLease succeeds */
  public leaseGranted = true;
  /** Makes the next N raw deletes throw (a failing retention run) */
  public executeRawFailures = 0;

  private seq = 0n;
  private depth = 0;

  public readonly user = new FakeModel(this, 'user');
  public readonly refreshToken = new FakeModel(this, 'refreshToken');
  public readonly passwordResetToken = new FakeModel(this, 'passwordResetToken');
  public readonly emailVerificationToken = new FakeModel(this, 'emailVerificationToken');
  public readonly enrolmentToken = new FakeModel(this, 'enrolmentToken');
  public readonly adminRequest = new FakeModel(this, 'adminRequest');
  public readonly outboxEvent = new FakeModel(this, 'outboxEvent');
  public readonly auditLog = new FakeModel(this, 'auditLog');
  public readonly userSession = new FakeModel(this, 'userSession');
  public readonly securityEvent = new FakeModel(this, 'securityEvent');
  public readonly ipRule = new FakeModel(this, 'ipRule');

  /** Column defaults (what the database would fill in) */
  public withDefaults(model: Model, data: Row): Row {
    const now = new Date();
    const defaults: Record<Model, Row> = {
      user: { role: 'CUSTOMER', isEmailVerified: false, isActive: true, tokenVersion: 0, passwordChangedAt: null, mfaEnabled: false, mfaEnabledAt: null, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaLastUsedStep: null, createdBy: null, firstSignInAt: null, updatedAt: now },
      refreshToken: { isRevoked: false, rotatedAt: null, mfaAuthenticated: false },
      passwordResetToken: { usedAt: null },
      emailVerificationToken: { usedAt: null },
      enrolmentToken: { usedAt: null },
      adminRequest: { status: 'PENDING' },
      outboxEvent: { seq: ++this.seq, status: 'PENDING', retryCount: 0, lastError: null, nextAttemptAt: null, lockedUntil: null, lockedBy: null, publishedAt: null },
      auditLog: { seq: ++this.seq, actorId: null, targetId: null, details: null, prevHash: null, hash: null },
      userSession: { firstIp: null, lastIp: null, userAgent: null, network: null, mfa: false, revokedAt: null, revokedReason: null },
      securityEvent: { userId: null, ip: null, deviceLabel: null, details: null },
      ipRule: { action: 'DENY', expiresAt: null, removedAt: null, removedBy: null },
    };
    const row: Row = { id: crypto.randomUUID(), createdAt: now, ...defaults[model] };
    for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
    if (model === 'userSession' && data.lastSeenAt === undefined) row.lastSeenAt = row.createdAt;
    return row;
  }

  /** Inserts rows with column defaults applied; returns them */
  public seed(model: Model, rows: Row[]): Row[] {
    return rows.map((data) => {
      const row = this.withDefaults(model, data);
      this.tables[model].push(row);
      return row;
    });
  }

  public async $transaction(arg: any): Promise<any> {
    if (typeof arg !== 'function') return Promise.all(arg);
    if (this.depth > 0) return arg(this); // nested (the chained audit write): part of the outer transaction
    const snapshot = Object.fromEntries(Object.entries(this.tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))])) as Record<Model, Row[]>;
    this.depth += 1;
    try {
      return await arg(this);
    } catch (err) {
      this.tables = snapshot;
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  public async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sql = strings.join('?');
    this.raw.push({ sql, values });
    if (/job_leases/.test(sql)) {
      this.leaseRequests.push({ name: String(values[0]), ttlSeconds: Number(values[2]) });
      return this.leaseGranted ? [{ holder: INSTANCE_ID }] : [];
    }
    if (/FOR UPDATE/.test(sql)) return [{ id: values[0] }];
    if (/pg_advisory_xact_lock/.test(sql)) return [{ pg_advisory_xact_lock: '' }];
    if (/SELECT 1/.test(sql)) return [{ '?column?': 1 }];
    return [];
  }

  public async $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown[]> {
    this.raw.push({ sql, values });
    if (/pg_advisory_xact_lock/.test(sql)) return [{ pg_advisory_xact_lock: '' }];
    const head = /SELECT hash FROM (\w+) WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1/.exec(sql);
    if (head) {
      const model = SQL_TABLES[head[1]];
      const [latest] = sortRows(this.tables[model].filter((r) => r.hash !== null), { seq: 'desc' });
      return latest ? [{ hash: latest.hash }] : [];
    }
    return [];
  }

  /** The retention deletes: DELETE FROM <table> ... WHERE <column> < now() - make_interval(days => $1) ... LIMIT $2 */
  public async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join('?');
    this.raw.push({ sql, values });
    if (this.executeRawFailures > 0) {
      this.executeRawFailures -= 1;
      throw new Error('database unavailable');
    }
    const match = /DELETE FROM (\w+)[\s\S]*WHERE (\w+) < \(now\(\)/.exec(sql);
    if (!match) return 0;
    const model = SQL_TABLES[match[1]];
    const column = match[2].replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    const cutoff = Date.now() - Number(values[0]) * 86_400_000;
    const limit = Number(values[1]);
    const doomed = sortRows(this.tables[model].filter((r) => r[column] instanceof Date && r[column].getTime() < cutoff), { [column]: 'asc' }).slice(0, limit);
    this.tables[model] = this.tables[model].filter((r) => !doomed.includes(r));
    return doomed.length;
  }

  public async $disconnect(): Promise<void> {}
}
