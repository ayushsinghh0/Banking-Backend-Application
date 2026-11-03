/**
 * A small stateful stand-in for the ledger's Prisma client, for the payment postings: accounts, transactions
 * (unique reference_id, append-only), entries, outbox and audit rows. Interactive transactions run one at a
 * time (like the row locks they would wait on) and roll back every write when the callback throws.
 */
export interface FakeAccount {
  id: string;
  kind: string;
  accountNumber: string;
  customerId: string;
  currency: string;
  balance: bigint;
  dailyLimit: bigint;
  isActive: boolean;
  closedAt: Date | null;
}

export interface FakeTransaction {
  id: string;
  referenceId: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  description: string | null;
  initiatedBy: string | null;
  topUpId: string | null;
  externalReference: string | null;
  createdAt: Date;
}

interface State {
  accounts: Map<string, FakeAccount>;
  transactions: FakeTransaction[];
  entries: Array<{ transactionId: string; accountId: string; entryType: 'DEBIT' | 'CREDIT'; amount: bigint; balanceAfter: bigint }>;
  outbox: Array<{ aggregateId: string; eventType: string; payload: any }>;
  audit: Array<{ actorId: string; action: string; targetId: string | null }>;
}

const clone = (s: State): State => ({
  accounts: new Map([...s.accounts].map(([k, v]) => [k, { ...v }])),
  transactions: s.transactions.map((t) => ({ ...t })),
  entries: s.entries.map((e) => ({ ...e })),
  outbox: s.outbox.map((o) => ({ ...o })),
  audit: s.audit.map((a) => ({ ...a })),
});

const uniqueViolation = () => Object.assign(new Error('Unique constraint failed on reference_id'), { code: 'P2002' });

let ids = 0;
const nextId = (prefix: string) => `${prefix}-${String(++ids).padStart(6, '0')}`;

function matches(t: FakeTransaction, where: any): boolean {
  for (const [key, cond] of Object.entries<any>(where ?? {})) {
    const value = (t as any)[key];
    if (cond && typeof cond === 'object' && 'startsWith' in cond) {
      if (typeof value !== 'string' || !value.startsWith(cond.startsWith)) return false;
    } else if (value !== cond) return false;
  }
  return true;
}

export function fakeLedgerDb() {
  let state: State = { accounts: new Map(), transactions: [], entries: [], outbox: [], audit: [] };
  let queue: Promise<unknown> = Promise.resolve();
  let committedTransactions = 0;

  const client: any = {
    $executeRaw: jest.fn(async () => 0),
    $queryRawUnsafe: jest.fn(async () => []),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM ledger_accounts') && sql.includes('FOR UPDATE')) {
        const wanted: string[] = values[0]?.values ?? [];
        return [...wanted]
          .sort()
          .map((id) => state.accounts.get(id))
          .filter((a): a is FakeAccount => Boolean(a))
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            balance: a.balance,
            is_active: a.isActive,
            closed_at: a.closedAt,
            account_number: a.accountNumber,
            customer_id: a.customerId,
            currency: a.currency,
            daily_limit: a.dailyLimit,
          }));
      }
      throw new Error(`fake ledger db: unexpected SQL ${sql}`);
    }),
    ledgerAccount: {
      findUnique: jest.fn(async ({ where }: any) => {
        const found = where.id ? state.accounts.get(where.id) : [...state.accounts.values()].find((a) => a.accountNumber === where.accountNumber);
        return found ? { ...found } : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const found = [...state.accounts.values()].find((a) => (where.id ? a.id === where.id : a.accountNumber === where.accountNumber));
        if (!found) throw new Error('not found');
        return { ...found };
      }),
      create: jest.fn(async ({ data }: any) => {
        if ([...state.accounts.values()].some((a) => a.accountNumber === data.accountNumber)) throw uniqueViolation();
        const account: FakeAccount = {
          id: data.id ?? nextId('acct'),
          kind: data.kind ?? 'CUSTOMER',
          accountNumber: data.accountNumber,
          customerId: data.customerId,
          currency: data.currency ?? 'INR',
          balance: data.balance ?? 0n,
          dailyLimit: data.dailyLimit ?? 10_000_000n,
          isActive: data.isActive ?? true,
          closedAt: data.closedAt ?? null,
        };
        state.accounts.set(account.id, account);
        return { ...account };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const account = state.accounts.get(where.id);
        if (!account) throw new Error('no account');
        Object.assign(account, data);
        return { ...account };
      }),
    },
    transaction: {
      findUnique: jest.fn(async ({ where }: any) => {
        const found = state.transactions.find((t) => t.referenceId === where.referenceId);
        return found ? { ...found } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (state.transactions.some((t) => t.referenceId === data.referenceId)) throw uniqueViolation();
        const row: FakeTransaction = {
          id: nextId('txn'),
          sourceAccountId: null,
          destinationAccountId: null,
          description: null,
          initiatedBy: null,
          topUpId: null,
          externalReference: null,
          currency: 'INR',
          createdAt: new Date(),
          ...data,
        };
        state.transactions.push(row);
        return { ...row };
      }),
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = state.transactions.filter((t) => matches(t, where));
        return { _sum: { amount: rows.length ? rows.reduce((sum, t) => sum + t.amount, 0n) : null } };
      }),
    },
    ledgerEntry: {
      create: jest.fn(async ({ data }: any) => {
        state.entries.push({ transactionId: data.transactionId, accountId: data.accountId, entryType: data.entryType, amount: data.amount, balanceAfter: data.balanceAfter });
        return data;
      }),
      // Newest first, with the transaction (what the history query asks for)
      findMany: jest.fn(async ({ where, take, skip }: any) =>
        state.entries
          .map((e, i) => ({ ...e, id: `entry-${String(i).padStart(6, '0')}`, createdAt: new Date(1_800_000_000_000 + i) }))
          .filter((e) => e.accountId === where.accountId)
          .reverse()
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 20))
          .map((e) => ({ ...e, transaction: state.transactions.find((t) => t.id === e.transactionId)! }))
      ),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        state.audit.push({ actorId: data.actorId, action: data.action, targetId: data.targetId ?? null });
        return data;
      }),
    },
    outboxEvent: {
      create: jest.fn(async ({ data }: any) => {
        state.outbox.push({ aggregateId: data.aggregateId, eventType: data.eventType, payload: data.payload });
        return data;
      }),
    },
  };

  client.$transaction = jest.fn((work: (tx: any) => Promise<unknown>) => {
    const run = queue.then(async () => {
      const before = clone(state);
      try {
        const result = await work(client);
        committedTransactions += 1;
        return result;
      } catch (err) {
        state = before;
        throw err;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  });

  return {
    client,
    get state() {
      return state;
    },
    committedTransactions: () => committedTransactions,
    addAccount(account: Partial<FakeAccount> & { id: string }): FakeAccount {
      const row: FakeAccount = {
        kind: 'CUSTOMER',
        accountNumber: `1001${account.id.replace(/\D/g, '').padStart(8, '0').slice(-8)}`,
        customerId: 'nobody',
        currency: 'INR',
        balance: 0n,
        dailyLimit: 10_000_000n,
        isActive: true,
        closedAt: null,
        ...account,
      };
      state.accounts.set(row.id, row);
      return row;
    },
    account(id: string): FakeAccount {
      const found = state.accounts.get(id);
      if (!found) throw new Error(`no account ${id}`);
      return found;
    },
    /** The ledger invariants reconciliation checks, computed over the fake's rows */
    invariants() {
      const assetKinds = ['TELLER_CASH', 'VAULT_CASH', 'CASH_SUSPENSE', 'PAYMENT_CLEARING'];
      const mismatched: string[] = [];
      for (const account of state.accounts.values()) {
        const netCredit = state.entries
          .filter((e) => e.accountId === account.id)
          .reduce((sum, e) => sum + (e.entryType === 'CREDIT' ? e.amount : -e.amount), 0n);
        const expected = account.kind === 'CUSTOMER' ? netCredit : assetKinds.includes(account.kind) ? -netCredit : null;
        if (expected === null || expected !== account.balance) mismatched.push(account.id);
      }
      const byTransaction = new Map<string, bigint>();
      for (const e of state.entries) byTransaction.set(e.transactionId, (byTransaction.get(e.transactionId) ?? 0n) + (e.entryType === 'DEBIT' ? e.amount : -e.amount));
      const unbalanced = [...byTransaction.values()].filter((v) => v !== 0n).length;
      const accounts = [...state.accounts.values()];
      const customers = accounts.filter((a) => a.kind === 'CUSTOMER').reduce((s, a) => s + a.balance, 0n);
      const assets = accounts.filter((a) => assetKinds.includes(a.kind)).reduce((s, a) => s + a.balance, 0n);
      return { mismatched, unbalanced, zeroSumDelta: customers - assets };
    },
  };
}
