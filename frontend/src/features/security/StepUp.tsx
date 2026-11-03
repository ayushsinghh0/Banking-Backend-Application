import { createContext, useCallback, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Clock, KeyRound, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { describeError, isApiError } from '@/lib/api/errors';
import { Button } from '@/components/ui/button';
import { Field, OtpInput } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { AuthIcon } from '@/components/layout/AuthLayout';

type Mode = 'code' | 'enrol' | 'cooling';

interface StepUpContextValue {
  /**
   * Runs a high-risk action. If the API answers STEP_UP_REQUIRED, asks for a fresh authenticator code,
   * upgrades the session and runs the SAME action once more (callers reuse their idempotency key).
   */
  run: <T>(action: () => Promise<T>) => Promise<T>;
  /**
   * Makes sure the session has a fresh step-up before an action that is merely better with one (e.g. an
   * instantly active payee). Resolves false if the person cancels or has no authenticator.
   */
  ensureFresh: () => Promise<boolean>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { api, applyTokens, user, hasFreshStepUp } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('code');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<((verified: boolean) => void) | null>(null);

  const settle = (verified: boolean) => {
    pending.current?.(verified);
    pending.current = null;
  };

  const askForCode = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setCode('');
        setError(undefined);
        setMode('code');
        setOpen(true);
      }),
    []
  );

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (first) {
        if (!isApiError(first) || !first.requiresStepUp) throw first;
        if (!user?.mfa) {
          setMode('enrol');
          setOpen(true);
          throw first;
        }
        if (!(await askForCode())) throw first;
        try {
          return await action();
        } catch (second) {
          if (isApiError(second) && second.requiresStepUp) {
            // The code was right, but this authenticator is too new to approve high-value actions yet
            setMode('cooling');
            setOpen(true);
          }
          throw second;
        }
      }
    },
    [askForCode, user?.mfa]
  );

  const ensureFresh = useCallback(async (): Promise<boolean> => {
    if (hasFreshStepUp()) return true;
    if (!user?.mfa) {
      setMode('enrol');
      setOpen(true);
      return false;
    }
    return askForCode();
  }, [askForCode, hasFreshStepUp, user?.mfa]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const tokens = await api.auth.stepUp(code);
      applyTokens(tokens);
      setOpen(false);
      settle(true);
    } catch (e) {
      setError(describeError(e).description);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (!next) settle(false);
  };

  const value = useMemo(() => ({ run, ensureFresh }), [run, ensureFresh]);

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="sm">
          {mode === 'code' ? (
            <form onSubmit={submit} className="grid gap-5" noValidate>
              <DialogHeader
                icon={<AuthIcon><KeyRound aria-hidden="true" /></AuthIcon>}
                title="Confirm it’s you"
                description="This is a high-value action. Enter the current code from your authenticator app to approve it."
              />
              <Field label="Authenticator code" error={error}>
                {(p) => <OtpInput {...p} autoFocus value={code} onValueChange={setCode} />}
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy}>
                  Verify and continue
                </Button>
              </DialogFooter>
            </form>
          ) : mode === 'enrol' ? (
            <div className="grid gap-5">
              <DialogHeader
                icon={<AuthIcon><ShieldAlert aria-hidden="true" /></AuthIcon>}
                title="Turn on two-factor authentication"
                description="High-value transfers, instant payees and large cash withdrawals must be approved with an authenticator app. It takes about a minute to set up."
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Not now
                </Button>
                <Button asChild>
                  <Link to="/settings/security" onClick={() => onOpenChange(false)}>
                    Set up authenticator
                  </Link>
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="grid gap-5">
              <DialogHeader
                icon={<AuthIcon><Clock aria-hidden="true" /></AuthIcon>}
                title="Your authenticator is still new"
                description="For your protection, a recently added authenticator can’t approve high-value actions straight away (24 hours by default). Try a smaller amount, or come back later."
              />
              <DialogFooter>
                <Button onClick={() => onOpenChange(false)}>Understood</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return ctx;
}
