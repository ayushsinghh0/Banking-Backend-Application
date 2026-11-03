import { useUser } from '@/lib/auth/AuthProvider';
import { Callout, PageHeader } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { useListParams } from '@/features/staff/components/hooks';
import { BansPanel } from './components/BansPanel';
import { IpRulesPanel } from './components/IpRulesPanel';
import { SecurityEventsPanel } from './components/SecurityEventsPanel';

const TABS = [
  { value: 'rules', label: 'IP rules' },
  { value: 'bans', label: 'Automatic bans' },
  { value: 'events', label: 'Security events' },
] as const;

type Tab = (typeof TABS)[number]['value'];

/**
 * Edge and sign-in security for the whole bank: deny rules at the gateway, automatic bans, and the security
 * event log. Administrators change rules and bans; support can see everything.
 */
export default function SecurityCentrePage() {
  const user = useUser();
  const canWrite = user.role === 'BANK_ADMIN';
  const { params, update } = useListParams();
  const tab: Tab = TABS.find((t) => t.value === params.get('tab'))?.value ?? 'rules';

  return (
    <div className="space-y-6 lg:space-y-8">
      <PageHeader title="Security centre" description="Who is blocked at the gateway, and sign-in activity across the bank." />
      {canWrite ? null : (
        <Callout tone="info" title="Read-only view">
          Bank administrators add and remove rules and lift bans.
        </Callout>
      )}
      <Tabs
        value={tab}
        // Each tab keeps its own filters; switching starts the next one clean
        onValueChange={(value) => update({ tab: value === 'rules' ? undefined : value, type: undefined, userId: undefined })}
        className="space-y-4"
      >
        <TabsList aria-label="Security centre sections" className="w-full sm:w-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-1 sm:flex-none">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="rules" className="mt-0">
          <IpRulesPanel canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="bans" className="mt-0">
          <BansPanel canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="events" className="mt-0">
          <SecurityEventsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
