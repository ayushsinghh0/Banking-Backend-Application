import { delay, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aProfile, IDS } from '@/test/fixtures';
import { asStaff, queryOf, resetToasts } from './testing';
import KycQueuePage from './KycQueuePage';

afterEach(resetToasts);

const pending = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    aProfile({
      id: `prof-${i}`,
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      fullName: `Customer ${i}`,
      kycStatus: 'PENDING',
    })
  );

function listHandler(respond: (query: Record<string, string>) => Response | Promise<Response>) {
  const calls: Array<Record<string, string>> = [];
  server.use(
    http.get(apiUrl('/customers'), ({ request }) => {
      const query = queryOf(request);
      calls.push(query);
      return respond(query);
    })
  );
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('KycQueuePage', () => {
  it('shows the pending queue by default, oldest first, with masked phones and waiting time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T09:30:00.000Z'));
    const calls = listHandler(() =>
      ok([aProfile({ kycStatus: 'PENDING', updatedAt: '2026-10-23T09:30:00.000Z', phoneNumber: '+919876543210' })])
    );
    renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });

    expect(screen.getByRole('heading', { name: 'KYC review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pending' })).toHaveAttribute('aria-selected', 'true');
    const row = (await screen.findByRole('button', { name: 'Open Asha Rao' })).closest('tr') as HTMLElement;
    // The tab already says the status, so rows don't repeat it
    expect(within(row).queryByText('Pending review')).not.toBeInTheDocument();
    expect(within(row).getByText('+91 ••••• 3210')).toBeInTheDocument();
    expect(within(row).queryByText('+919876543210')).not.toBeInTheDocument();
    expect(within(row).getByText('4 days')).toBeInTheDocument();
    expect(calls[0]).toEqual({ kycStatus: 'PENDING', limit: '20', offset: '0' });
  });

  it('announces loading while the queue is fetched', async () => {
    listHandler(async () => {
      await delay('infinite');
      return ok([]);
    });
    renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    expect(await screen.findByText('Loading customers…')).toBeInTheDocument();
  });

  it('says when nothing is waiting for review', async () => {
    listHandler(() => ok([]));
    renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    expect(await screen.findByText('No profiles waiting for review')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempt = 0;
    listHandler(() => (attempt++ === 0 ? fail(503, 'SERVICE_UNAVAILABLE') : ok([aProfile({ kycStatus: 'PENDING' })])));
    const { user } = renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    expect(await screen.findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: 'Open Asha Rao' })).toBeInTheDocument();
  });

  it('switches status tabs and drops the waiting column outside the pending queue', async () => {
    const calls = listHandler((query) =>
      ok(query.kycStatus === 'VERIFIED' ? [aProfile({ fullName: 'Ravi Kumar', kycStatus: 'VERIFIED' })] : [aProfile({ kycStatus: 'PENDING' })])
    );
    const { user } = renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    expect(await screen.findByRole('columnheader', { name: 'Waiting' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Verified' }));
    expect(await screen.findByRole('button', { name: 'Open Ravi Kumar' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Waiting' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Last updated' })).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ kycStatus: 'VERIFIED', limit: '20', offset: '0' });
  });

  it('searches by name, phone or user id after typing pauses', async () => {
    const calls = listHandler((query) => ok(query.q ? [aProfile({ fullName: 'Asha Rao', kycStatus: 'PENDING' })] : pending(2)));
    const { user } = renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    await screen.findByRole('button', { name: 'Open Customer 0' });
    await user.type(screen.getByLabelText('Search'), 'asha');
    expect(await screen.findByRole('button', { name: 'Open Asha Rao' })).toBeInTheDocument();
    // One request for the settled term, not one per keystroke
    expect(calls.filter((c) => c.q)).toEqual([{ kycStatus: 'PENDING', q: 'asha', limit: '20', offset: '0' }]);
  });

  it('says when a search matches nothing', async () => {
    listHandler((query) => ok(query.q ? [] : pending(1)));
    const { user } = renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    await screen.findByRole('button', { name: 'Open Customer 0' });
    await user.type(screen.getByLabelText('Search'), 'zzz');
    expect(await screen.findByText('No customers match “zzz”')).toBeInTheDocument();
  });

  it('pages through the queue', async () => {
    const calls = listHandler((query) => ok(query.offset === '20' ? pending(3) : pending(20)));
    const { user } = renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    await screen.findByRole('button', { name: 'Open Customer 19' });
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ kycStatus: 'PENDING', limit: '20', offset: '20' }));
    expect(await screen.findByText('Showing 21–23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('opens the customer record from a row', async () => {
    listHandler(() => ok([aProfile({ kycStatus: 'PENDING' })]));
    const { user } = renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    await user.click(await screen.findByRole('button', { name: 'Open Asha Rao' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`/customers/${IDS.customer}`);
  });

  it('tells administrators the view is read-only', async () => {
    listHandler(() => ok([]));
    renderWithApp(<KycQueuePage />, { ...asStaff('BANK_ADMIN'), route: '/kyc' });
    expect(await screen.findByText(/decisions are made by KYC officers/i)).toBeInTheDocument();
  });

  it('does not show the read-only note to KYC officers', async () => {
    listHandler(() => ok([]));
    renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc' });
    await screen.findByText('No profiles waiting for review');
    expect(screen.queryByText(/decisions are made by KYC officers/i)).not.toBeInTheDocument();
  });

  it('restores the tab and search from the address', async () => {
    const calls = listHandler(() => ok([aProfile({ kycStatus: 'REJECTED' })]));
    renderWithApp(<KycQueuePage />, { ...asStaff('KYC_OFFICER'), route: '/kyc?status=rejected&q=asha', path: '/kyc' });
    expect(await screen.findByRole('button', { name: 'Open Asha Rao' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Rejected' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Search')).toHaveValue('asha');
    expect(calls[0]).toEqual({ kycStatus: 'REJECTED', q: 'asha', limit: '20', offset: '0' });
  });
});
