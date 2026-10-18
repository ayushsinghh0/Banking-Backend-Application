/**
 * Bootstraps the first BANK_ADMIN account. Public registration can only create CUSTOMER
 * users, so this script (run by an operator with database access) is the root of trust.
 *
 *   ADMIN_EMAIL=ops@bank.example ADMIN_PASSWORD='...' npm run create-admin -w @banksphere/auth-service
 */
import 'dotenv/config';
import { PrismaClient } from '../../generated/client';
import { connectRedis, ConsoleMailer, RedisTokenStateStore, prismaClientOptions } from '@banksphere/common';
import { AuthService } from '../services/auth.service';
import { TokenService } from '../services/token.service';
import { RedisAuthSecurityStore } from '../services/auth-security.store';

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required');
  }
  if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters with upper, lower case letters and a digit');
  }

  const prisma = new PrismaClient(prismaClientOptions());
  const redis = await connectRedis();
  try {
    const authService = new AuthService({
      prisma,
      tokenService: new TokenService(),
      tokenState: new RedisTokenStateStore(redis),
      security: new RedisAuthSecurityStore(redis, redis),
      mailer: new ConsoleMailer(), // bootstrap sends no email
    });
    const { user, enrolmentToken } = await authService.createBootstrapAdmin(email, password);
    console.log(`Created BANK_ADMIN ${user.email} (${user.id}).`);
    console.log('Sign in, then enrol MFA with POST /api/v1/auth/mfa/setup and /mfa/enable using this ONE-TIME enrolment token');
    console.log(`(valid ${authService.config.enrolmentTtlHours}h; hand it to the administrator out of band):`);
    console.log(`ENROLMENT_TOKEN=${enrolmentToken}`);
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
