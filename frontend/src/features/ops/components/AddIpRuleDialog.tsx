import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError, type ErrorDescription } from '@/lib/api/errors';
import { notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/overlays';
import { Callout } from '@/components/ui/primitives';
import { opsKeys, useOpsApi } from '../api';
import { RULE_DURATIONS, describeOpsError, parseCidr } from '../format';

const schema = z.object({
  cidr: z.string().transform((value, ctx) => {
    const parsed = parseCidr(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.error });
      return z.NEVER;
    }
    return parsed.cidr;
  }),
  reason: z.string().trim().min(3, 'Say why, in a few words').max(200, 'Keep it to 200 characters'),
  duration: z.string(),
});

type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;
type FieldName = 'cidr' | 'reason' | 'duration';

const FIELD_FOR: Record<string, FieldName> = { cidr: 'cidr', reason: 'reason', expiresInMinutes: 'duration' };

/**
 * A deny rule: an address or range, why, and for how long. The form checks what it can (format, width); the
 * auth service refuses ranges that overlap staff networks or the administrator's own address, and its
 * explanation is shown as it gives it.
 */
export function AddIpRuleDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const ops = useOpsApi();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<ErrorDescription | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: { cidr: '', reason: '', duration: 'never' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ cidr, reason, duration }) => {
    setProblem(null);
    const minutes = RULE_DURATIONS.find((d) => d.value === duration)?.minutes;
    try {
      await ops.security.addIpRule(minutes ? { cidr, reason, expiresInMinutes: minutes } : { cidr, reason });
      notifySuccess('Rule added', `Requests from ${cidr} are refused within a few seconds.`);
      void queryClient.invalidateQueries({ queryKey: opsKeys.ipRules });
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error)) {
        for (const [field, message] of Object.entries(error.fieldErrors)) {
          const name = FIELD_FOR[field];
          if (name) form.setError(name, { message });
        }
      }
      setProblem(describeOpsError(error));
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !isSubmitting && onOpenChange(open)}>
      <DialogContent size="md">
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <DialogHeader
            title="Add an IP rule"
            description="Requests from this address or range are refused at the gateway. Staff networks and your own address can’t be blocked."
          />
          <Field label="Address or range" error={errors.cidr?.message} hint="For example 203.0.113.0/24 or 2001:db8:1::/48. A single address is fine too.">
            {(p) => <Input {...p} {...form.register('cidr')} autoFocus autoComplete="off" spellCheck={false} inputMode="text" className="font-mono" />}
          </Field>
          <Field label="Reason" error={errors.reason?.message} hint="Shown to colleagues next to the rule.">
            {(p) => <Textarea {...p} {...form.register('reason')} maxLength={200} rows={3} />}
          </Field>
          <Field label="Expires" error={errors.duration?.message}>
            {(p) => (
              <NativeSelect {...p} {...form.register('duration')}>
                {RULE_DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {problem ? (
            <Callout tone="danger" title={problem.title}>
              {problem.description}
              {problem.reference ? <span className="mt-1 block font-mono text-[12px]">Reference: {problem.reference}</span> : null}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Add rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
