import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { fail, ok, renderWithApp } from '@/test/render';
import { asStaff } from '@/features/staff/testing';
import { anAudit, auditHandlers } from './test/handlers';
import { AuditBreachNotice, AuditIntegrityCard } from './AuditIntegrityCard';

const render = () => renderWithApp(<AuditIntegrityCard />, asStaff('BANK_ADMIN'));

const rowFor = async (name: string) => (await within(screen.getByRole('region', { name: 'Audit integrity' })).findByText(name)).closest('li') as HTMLElement;

describe('AuditIntegrityCard', () => {
  it('shows both chains verified with how many records were checked', async () => {
    server.use(...auditHandlers());
    render();
    const ledger = await rowFor('Ledger');
    await waitFor(() => expect(ledger).toHaveTextContent('Verified'));
    expect(ledger).toHaveTextContent('12,840 records checked');
    const auth = await rowFor('Sign-in and administration');
    await waitFor(() => expect(auth).toHaveTextContent('3,120 records checked'));
  });

  it('says where a chain is broken', async () => {
    server.use(...auditHandlers(anAudit({ ok: false, checked: 500, brokenAt: 431 })));
    render();
    const ledger = await rowFor('Ledger');
    await waitFor(() => expect(ledger).toHaveTextContent('Broken'));
    expect(ledger).toHaveTextContent('First broken link at record 431');
  });

  it('shows a failed check on its own row with a retry', async () => {
    let attempt = 0;
    server.use(...auditHandlers(() => (attempt++ === 0 ? fail(503, 'SERVICE_BUSY') : ok(anAudit()))));
    const { user } = render();
    const ledger = await rowFor('Ledger');
    await waitFor(() => expect(ledger).toHaveTextContent('Couldn’t check'));
    await user.click(within(ledger).getByRole('button', { name: 'Try again checking the ledger' }));
    await waitFor(() => expect(ledger).toHaveTextContent('Verified'));
  });

  it('checks both again on request', async () => {
    const calls = { ledger: 0, auth: 0 };
    server.use(
      ...auditHandlers(
        () => {
          calls.ledger++;
          return anAudit();
        },
        () => {
          calls.auth++;
          return anAudit({ checked: 3120 + calls.auth });
        }
      )
    );
    const { user } = render();
    const auth = await rowFor('Sign-in and administration');
    await waitFor(() => expect(auth).toHaveTextContent('3,121 records checked'));
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(auth).toHaveTextContent('3,122 records checked'));
    expect(calls).toEqual({ ledger: 2, auth: 2 });
  });

  it('does not claim a result it didn’t get', async () => {
    server.use(...auditHandlers([], {}));
    render();
    const ledger = await rowFor('Ledger');
    await waitFor(() => expect(ledger).toHaveTextContent('No result'));
  });

  it('raises a banner only when a chain is broken', async () => {
    server.use(...auditHandlers(anAudit(), anAudit({ ok: false, checked: 12, brokenAt: null })));
    renderWithApp(
      <>
        <AuditBreachNotice />
        <AuditIntegrityCard />
      </>,
      asStaff('BANK_ADMIN')
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('An audit log has been altered');
    expect(await rowFor('Sign-in and administration')).toHaveTextContent('A link doesn’t match');
  });

  it('shows no banner while the chains are intact', async () => {
    server.use(...auditHandlers());
    renderWithApp(
      <>
        <AuditBreachNotice />
        <AuditIntegrityCard />
      </>,
      asStaff('BANK_ADMIN')
    );
    await waitFor(async () => expect(await rowFor('Ledger')).toHaveTextContent('Verified'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
