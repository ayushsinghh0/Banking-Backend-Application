/** OutboxRelay (packages/common/src/outbox/outbox-relay.ts): retention purge */
import { OutboxRelay } from '@banksphere/common';

describe('OutboxRelay.purgePublished', () => {
  const publisher = { publish: jest.fn() };
  const sql = (call: any[]) => (call[0] as TemplateStringsArray).join('?');

  afterEach(() => jest.restoreAllMocks());

  it('deletes in bounded batches (one short statement each) until a batch comes back short', async () => {
    const prisma = { $queryRaw: jest.fn(), $executeRaw: jest.fn().mockResolvedValueOnce(5000).mockResolvedValueOnce(5000).mockResolvedValueOnce(12) };
    const relay = new OutboxRelay(prisma, publisher, { purgeBatchSize: 5000, retentionDays: 7 });
    expect(await relay.purgePublished()).toBe(10_012);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    for (const call of prisma.$executeRaw.mock.calls) {
      expect(sql(call)).toMatch(/DELETE FROM outbox_events[\s\S]*status = 'PUBLISHED'[\s\S]*LIMIT \?/);
      expect(call.slice(1)).toEqual([7, 5000]);
    }
  });

  it('stops at its time budget even if more rows remain (the next run continues)', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const prisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(async () => {
        now += 20_000; // each batch takes 20s
        return 5000;
      }),
    };
    const relay = new OutboxRelay(prisma, publisher, { purgeBatchSize: 5000, purgeBudgetMs: 60_000 });
    expect(await relay.purgePublished()).toBe(15_000);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });
});
