import { PAYMENT_STATUSES, PaymentStatus } from '../domain/status';
import { addDays, istDate, startOfIstDay } from '../domain/time';
import { Page, PageRequest, StaffFilter, TopUp } from '../domain/types';
import { PaymentStore } from '../store/payment-store';

export interface PaymentsSummary {
  day: string;
  byStatus: Record<PaymentStatus, { count: number; amountPaise: string }>;
  total: { count: number; amountPaise: string };
  /** credited (incl. later refunded) / (credited + failed + expired + blocked); null before anything finished */
  successRate: number | null;
  medianSecondsToCredit: number | null;
}

const SUCCEEDED: readonly PaymentStatus[] = ['CREDITED', 'REFUND_PENDING', 'REFUNDED'];
const UNSUCCESSFUL: readonly PaymentStatus[] = ['FAILED', 'EXPIRED', 'CREDIT_BLOCKED'];

/** Staff read side: filtered lists and today's (IST) summary */
export class AdminService {
  constructor(
    private readonly store: PaymentStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  public list(filter: StaffFilter, page: PageRequest): Promise<Page<TopUp>> {
    return this.store.listForStaff(filter, page);
  }

  public async summary(): Promise<PaymentsSummary> {
    const now = this.now();
    const from = startOfIstDay(now);
    const data = await this.store.summarize(from, addDays(from, 1));
    const byStatus = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, { count: 0, amountPaise: '0' }])) as PaymentsSummary['byStatus'];
    let count = 0;
    let amount = 0n;
    for (const row of data.byStatus) {
      byStatus[row.status] = { count: row.count, amountPaise: row.amountPaise.toString() };
      count += row.count;
      amount += row.amountPaise;
    }
    const sum = (statuses: readonly PaymentStatus[]) => statuses.reduce((n, s) => n + byStatus[s].count, 0);
    const succeeded = sum(SUCCEEDED);
    const finished = succeeded + sum(UNSUCCESSFUL);
    return {
      day: istDate(now),
      byStatus,
      total: { count, amountPaise: amount.toString() },
      successRate: finished ? Math.round((succeeded / finished) * 10_000) / 10_000 : null,
      medianSecondsToCredit: data.medianSecondsToCredit === null ? null : Math.round(data.medianSecondsToCredit * 10) / 10,
    };
  }
}
