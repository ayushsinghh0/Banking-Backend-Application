/**
 * Bootstraps the first BANK_ADMIN account. Public registration can only create CUSTOMER
 * users, so this script (run by an operator with database access) is the root of trust.
 *
 *   ADMIN_EMAIL=ops@bank.example ADMIN_PASSWORD='...' npm run create-admin -w @banksphere/auth-service
 */
import { PrismaClient, Role } from '../../generated/client';
import { AuthService } from '../services/auth.service';
import { TokenService } from '../services/token.service';

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  const prisma = new PrismaClient();
  try {
    const authService = new AuthService(prisma, new TokenService());
    const user = await authService.createStaffUser({ email, password, role: Role.BANK_ADMIN });
    console.log(`Created BANK_ADMIN ${user.email} (${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
