import type { ComponentType } from 'react';
import { Outlet, type RouteObject } from 'react-router';
import { StepUpProvider } from '@/features/security/StepUp';
import { AppShell } from '@/components/layout/AppShell';
import { AuthLayout } from '@/components/layout/AuthLayout';
import type { Role } from '@/lib/auth/session';
import { HomeRedirect, PublicOnly, RequireAuth, RequireRole } from './guards';
import { RouteError } from './RouteError';
import NotFoundPage from './NotFoundPage';

type Loader = () => Promise<{ default: ComponentType }>;

/** Code-split page: each route downloads only its own bundle */
const page = (path: string, load: Loader): RouteObject => ({
  path,
  lazy: async () => ({ Component: (await load()).default }),
});

const roles = (allowed: readonly Role[], children: RouteObject[]): RouteObject => ({
  element: <RequireRole roles={allowed} />,
  children,
});

const STAFF: Role[] = ['TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'SUPPORT', 'BANK_ADMIN'];

export const routes: RouteObject[] = [
  {
    element: (
      <StepUpProvider>
        <Outlet />
      </StepUpProvider>
    ),
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <HomeRedirect /> },
      {
        element: <PublicOnly />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              page('/login', () => import('@/features/auth/LoginPage')),
              page('/register', () => import('@/features/auth/RegisterPage')),
              page('/forgot-password', () => import('@/features/auth/ForgotPasswordPage')),
            ],
          },
        ],
      },
      {
        // Links from emails work whether or not someone is signed in on this device
        element: <AuthLayout />,
        children: [
          page('/verify-email', () => import('@/features/auth/VerifyEmailPage')),
          page('/reset-password', () => import('@/features/auth/ResetPasswordPage')),
          page('/staff/activate', () => import('@/features/auth/StaffActivatePage')),
        ],
      },
      {
        element: <RequireAuth />,
        children: [{ element: <AuthLayout />, children: [page('/mfa/enrol', () => import('@/features/auth/MfaEnrolPage'))] }],
      },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          roles(['CUSTOMER'], [
            page('/dashboard', () => import('@/features/customer/DashboardPage')),
            page('/accounts', () => import('@/features/customer/AccountsPage')),
            page('/accounts/:accountId', () => import('@/features/customer/AccountDetailPage')),
            page('/transfer', () => import('@/features/customer/TransferPage')),
            page('/add-money', () => import('@/features/customer/AddMoneyPage')),
            page('/payees', () => import('@/features/customer/PayeesPage')),
            page('/cash-withdrawal', () => import('@/features/customer/CashWithdrawalPage')),
            page('/profile', () => import('@/features/customer/ProfilePage')),
          ]),
          roles(['TELLER'], [
            page('/teller', () => import('@/features/teller/TellerDeskPage')),
            page('/teller/operations', () => import('@/features/teller/TellerOperationsPage')),
          ]),
          roles(['KYC_OFFICER', 'BANK_ADMIN'], [page('/kyc', () => import('@/features/staff/KycQueuePage'))]),
          roles(['KYC_OFFICER', 'BANK_ADMIN', 'SUPPORT'], [page('/customers', () => import('@/features/staff/CustomersPage'))]),
          roles(STAFF, [page('/customers/:userId', () => import('@/features/staff/CustomerDetailPage'))]),
          roles(['FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'], [
            page('/fraud', () => import('@/features/staff/FraudAlertsPage')),
            page('/fraud/:alertId', () => import('@/features/staff/FraudAlertDetailPage')),
          ]),
          roles(['FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'], [page('/notifications', () => import('@/features/staff/NotificationsPage'))]),
          // Operations (platform design, section 14): payments:read:any; refunds and reconciliation stay admin-only inside the page
          roles(['FRAUD_ANALYST', 'BANK_ADMIN', 'SUPPORT'], [page('/payments', () => import('@/features/ops/PaymentsPage'))]),
          roles(['BANK_ADMIN', 'SUPPORT'], [
            page('/teller-sessions', () => import('@/features/branch/TellerSessionsPage')),
            page('/cash-operations', () => import('@/features/branch/CashOperationsPage')),
            page('/directory', () => import('@/features/admin/DirectoryPage')),
            // security:ip-rules:read; the events tab resolves people through the staff directory, which these two roles may read
            page('/security-centre', () => import('@/features/ops/SecurityCentrePage')),
          ]),
          roles(['BANK_ADMIN'], [
            page('/overview', () => import('@/features/admin/OverviewPage')),
            page('/approvals', () => import('@/features/admin/ApprovalsPage')),
          ]),
          page('/settings/security', () => import('@/features/security/SecurityPage')),
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
