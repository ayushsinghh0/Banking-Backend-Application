import crypto from 'crypto';

type RawClient = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };

/** Identifies this process for lease ownership */
export const INSTANCE_ID = `${process.env.HOSTNAME || 'local'}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/**
 * Leader election for periodic jobs across replicas, via a row in the service's `job_leases` table:
 * the lease is taken if free or expired (or renewed if already ours). Only the holder runs the job, so a
 * full-table reconciliation runs once per interval for the whole deployment, not once per replica.
 */
export async function acquireJobLease(prisma: RawClient, name: string, ttlSeconds: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ holder: string }>>`
    INSERT INTO job_leases (name, holder, expires_at)
    VALUES (${name}, ${INSTANCE_ID}, now() + make_interval(secs => ${ttlSeconds}))
    ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
    WHERE job_leases.expires_at < now() OR job_leases.holder = EXCLUDED.holder
    RETURNING holder
  `;
  return rows.length === 1;
}
