import {
  ArrowLeftRight,
  Banknote,
  BellRing,
  ClipboardCheck,
  CreditCard,
  HandCoins,
  House,
  Landmark,
  LayoutGrid,
  ReceiptText,
  ScanFace,
  Search,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Stamp,
  UserRound,
  Users,
  Vault,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@/lib/auth/session';

export interface NavItem {
  to: string;
  label: string;
  /** Tab-bar label on phones; always a word of `label`, so the visible text stays part of the accessible name */
  short?: string;
  icon: LucideIcon;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

/** Operations shared by several staff roles (platform design, section 14) */
const payments: NavItem = { to: '/payments', label: 'Payments', icon: CreditCard };
const securityCentre: NavItem = { to: '/security-centre', label: 'Security centre', short: 'Security', icon: ShieldAlert };

/**
 * Where each role works. Personal settings (profile, security) are not destinations: they live in the
 * account menu, see ACCOUNT_LINKS.
 */
export const NAVIGATION: Record<Role, NavSection[]> = {
  CUSTOMER: [
    {
      items: [
        { to: '/dashboard', label: 'Overview', icon: House },
        { to: '/accounts', label: 'Accounts', icon: Wallet },
        { to: '/transfer', label: 'Transfer', icon: ArrowLeftRight },
        { to: '/payees', label: 'Payees', icon: Users },
        { to: '/cash-withdrawal', label: 'Cash withdrawal', short: 'Cash', icon: Banknote },
      ],
    },
  ],
  TELLER: [
    {
      title: 'Branch',
      items: [
        { to: '/teller', label: 'Cash desk', short: 'Desk', icon: Landmark },
        { to: '/teller/operations', label: 'My operations', short: 'Operations', icon: ReceiptText },
      ],
    },
  ],
  KYC_OFFICER: [
    {
      title: 'Compliance',
      items: [
        { to: '/kyc', label: 'KYC review', short: 'KYC', icon: ScanFace },
        { to: '/customers', label: 'Customers', icon: Search },
      ],
    },
  ],
  FRAUD_ANALYST: [
    {
      title: 'Risk',
      items: [
        { to: '/fraud', label: 'Fraud alerts', short: 'Alerts', icon: Siren },
        { to: '/notifications', label: 'Notifications', icon: BellRing },
        payments,
      ],
    },
  ],
  SUPPORT: [
    {
      title: 'Customers',
      items: [
        { to: '/customers', label: 'Customers', icon: Search },
        { to: '/directory', label: 'User directory', short: 'Directory', icon: Users },
      ],
    },
    {
      title: 'Operations',
      items: [
        { to: '/teller-sessions', label: 'Teller sessions', short: 'Sessions', icon: Vault },
        { to: '/cash-operations', label: 'Cash operations', short: 'Cash', icon: HandCoins },
        { to: '/fraud', label: 'Fraud alerts', short: 'Alerts', icon: Siren },
        { to: '/notifications', label: 'Notifications', icon: BellRing },
        payments,
        securityCentre,
      ],
    },
  ],
  BANK_ADMIN: [
    {
      items: [
        { to: '/overview', label: 'Overview', icon: LayoutGrid },
        { to: '/approvals', label: 'Approvals', icon: Stamp },
      ],
    },
    {
      title: 'Branch cash',
      items: [
        { to: '/teller-sessions', label: 'Teller sessions', short: 'Sessions', icon: Vault },
        { to: '/cash-operations', label: 'Cash approvals', short: 'Cash', icon: HandCoins },
      ],
    },
    {
      title: 'People and accounts',
      items: [
        { to: '/directory', label: 'Staff & users', short: 'Staff', icon: Users },
        { to: '/customers', label: 'Customers', icon: Search },
        { to: '/kyc', label: 'KYC status', short: 'KYC', icon: ClipboardCheck },
      ],
    },
    {
      title: 'Oversight',
      items: [
        { to: '/fraud', label: 'Fraud alerts', short: 'Alerts', icon: Siren },
        { to: '/notifications', label: 'Notifications', icon: BellRing },
        payments,
        securityCentre,
      ],
    },
  ],
};

const security: NavItem = { to: '/settings/security', label: 'Security', icon: ShieldCheck };

/** Personal settings, reached from the account menu */
export const ACCOUNT_LINKS: Record<Role, NavItem[]> = {
  CUSTOMER: [{ to: '/profile', label: 'Profile & KYC', icon: UserRound }, security],
  TELLER: [security],
  KYC_OFFICER: [security],
  FRAUD_ANALYST: [security],
  SUPPORT: [security],
  BANK_ADMIN: [security],
};

export const HOME: Record<Role, string> = {
  CUSTOMER: '/dashboard',
  TELLER: '/teller',
  KYC_OFFICER: '/kyc',
  FRAUD_ANALYST: '/fraud',
  SUPPORT: '/customers',
  BANK_ADMIN: '/overview',
};

export const ROLE_LABEL: Record<Role, string> = {
  CUSTOMER: 'Personal banking',
  TELLER: 'Teller',
  KYC_OFFICER: 'KYC officer',
  FRAUD_ANALYST: 'Fraud analyst',
  SUPPORT: 'Customer support',
  BANK_ADMIN: 'Bank administrator',
};
