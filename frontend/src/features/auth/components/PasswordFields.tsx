import { Check, Circle } from 'lucide-react';
import type { UseFormReturn, FieldValues, Path } from 'react-hook-form';
import { z } from 'zod';
import { cn } from '@/lib/cn';
import { PASSWORD_RULES, passwordSchema, passwordScore } from '@/lib/validation';
import { Field, PasswordInput } from '@/components/ui/input';

const STRENGTH = ['Too weak', 'Weak', 'Fair', 'Good', 'Excellent'] as const;
const STRENGTH_TONE = ['bg-destructive', 'bg-destructive', 'bg-warning', 'bg-success', 'bg-success'] as const;

/** Live checklist of the password policy plus a strength bar */
export function PasswordChecklist({ value }: { value: string }) {
  const score = passwordScore(value);
  return (
    <div className="space-y-2.5" aria-live="polite">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={cn('h-1 flex-1 rounded-full bg-muted transition-colors', value && score >= i && STRENGTH_TONE[score])} />
          ))}
        </div>
        <span className="w-20 text-right text-[12px] text-muted-foreground">{value ? STRENGTH[score] : ''}</span>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {PASSWORD_RULES.map((rule) => {
          const met = rule.test(value);
          return (
            <li key={rule.id} data-met={String(met)} className={cn('flex items-center gap-1.5 text-[12.5px]', met ? 'text-success' : 'text-muted-foreground')}>
              {met ? <Check className="size-3.5" aria-hidden="true" /> : <Circle className="size-3" aria-hidden="true" />}
              <span>{rule.label}</span>
              <span className="sr-only">{met ? '(met)' : '(not met)'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** password + confirmation, with the "must match" rule */
export const newPasswordShape = {
  password: passwordSchema,
  confirm: z.string().min(1, 'Confirm your password'),
};

export function refineMatch<T extends { password: string; confirm: string }>(schema: z.ZodType<T, T>) {
  return schema.refine((v) => v.password === v.confirm, { message: 'Passwords don’t match', path: ['confirm'] });
}

export function NewPasswordFields<T extends FieldValues & { password: string; confirm: string }>({
  form,
  label = 'Password',
  confirmLabel = 'Confirm password',
}: {
  form: UseFormReturn<T>;
  label?: string;
  confirmLabel?: string;
}) {
  const errors = form.formState.errors as Partial<Record<'password' | 'confirm', { message?: string }>>;
  const value = (form.watch('password' as Path<T>) as string | undefined) ?? '';
  return (
    <>
      <Field label={label} error={errors.password?.message}>
        {(p) => <PasswordInput {...p} {...form.register('password' as Path<T>)} autoComplete="new-password" />}
      </Field>
      <PasswordChecklist value={value} />
      <Field label={confirmLabel} error={errors.confirm?.message}>
        {(p) => <PasswordInput {...p} {...form.register('confirm' as Path<T>)} autoComplete="new-password" />}
      </Field>
    </>
  );
}

/** Puts server-side field errors (from a VALIDATION_ERROR) onto the matching inputs */
export function applyFieldErrors<T extends FieldValues>(form: UseFormReturn<T>, fieldErrors: Record<string, string>, rename: Record<string, string> = {}): boolean {
  let applied = false;
  for (const [field, message] of Object.entries(fieldErrors)) {
    const name = (rename[field] ?? field) as Path<T>;
    form.setError(name, { type: 'server', message });
    applied = true;
  }
  return applied;
}
