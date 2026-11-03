import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useAuth, useUser } from '@/lib/auth/AuthProvider';
import { HOME } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { AuthHeading, AuthIcon } from '@/components/layout/AuthLayout';
import { AuthenticatorSetup } from '@/features/security/AuthenticatorSetup';
import { useFragmentToken } from './fragment';
import { peekEnrolmentToken, takeEnrolmentToken } from './enrolment';

/** Mandatory authenticator enrolment for staff (after activation, a bootstrap, or an MFA reset) */
export default function MfaEnrolPage() {
  const user = useUser();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const linkToken = useFragmentToken();
  const [knownToken] = useState(() => peekEnrolmentToken() ?? linkToken);
  const [typedToken, setTypedToken] = useState('');

  if (user.role === 'CUSTOMER') return <Navigate to="/settings/security" replace />;
  if (user.mfa) return <Navigate to={HOME[user.role]} replace />;

  const enrolmentToken = knownToken ?? (typedToken.trim() || undefined);

  return (
    <div>
      <AuthHeading
        icon={<AuthIcon><ShieldCheck aria-hidden="true" /></AuthIcon>}
        title="Set up your authenticator"
        description="Staff accounts are protected by two-factor authentication. You’ll use a code from your phone every time you sign in."
      />
      {knownToken ? null : (
        <div className="mb-4">
          <Field label="Enrolment code" hint="From your enrolment email, or the code your administrator gave you.">
            {(p) => <Input {...p} value={typedToken} onChange={(e) => setTypedToken(e.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
        </div>
      )}
      <AuthenticatorSetup
        enrolmentToken={enrolmentToken}
        onComplete={() => {
          takeEnrolmentToken();
          navigate(HOME[user.role], { replace: true });
        }}
      />
      <Button
        variant="ghost"
        className="mt-4 w-full text-muted-foreground"
        onClick={async () => {
          await signOut();
          navigate('/login', { replace: true });
        }}
      >
        <LogOut aria-hidden="true" /> Sign out
      </Button>
    </div>
  );
}
