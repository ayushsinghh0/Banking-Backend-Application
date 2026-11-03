import { delay, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aProfile, IDS } from '@/test/fixtures';
import { asStaff, queryOf, resetToasts } from './testing';
import CustomersPage from './CustomersPage';

afterEach(resetToasts);

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

const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    aProfile({ id: `p${i}`, userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, fullName: `Customer ${i}` })
  );

describe('CustomersPage', () => {
  it('asks for a search before listing anyone', async () => {
    // No handler: any request would fail the test
    renderWithApp(<CustomersPage />, { ...asStaff('SUPPORT'), route: '/customers' });
    expect(screen.getByRole('heading', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.getByText('Search for a customer')).toBeInTheDocument();
    expect(screen.getByText(/opening a customer record is logged/i)).toBeInTheDocument();
  });

  it('finds customers by name and opens their record', async () => {
    const calls = listHandler(() => ok([aProfile()]));
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('SUPPORT'), route: '/customers' });
    await user.type(screen.getByLabelText('Search'), 'Asha');
    const open = await screen.findByRole('button', { name: 'Open Asha Rao' });
    expect(within(open.closest('tr') as HTMLElement).getByText('Verified')).toBeInTheDocument();
    expect(calls).toEqual([{ q: 'Asha', limit: '20', offset: '0' }]);
    await user.click(open);
    expect(screen.getByTestId('location')).toHaveTextContent(`/customers/${IDS.customer}`);
  });

  it('can list by KYC status alone', async () => {
    const calls = listHandler(() => ok([aProfile({ kycStatus: 'REJECTED' })]));
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('KYC_OFFICER'), route: '/customers' });
    await user.selectOptions(screen.getByLabelText('KYC status'), 'REJECTED');
    expect(await screen.findByRole('button', { name: 'Open Asha Rao' })).toBeInTheDocument();
    expect(calls).toEqual([{ kycStatus: 'REJECTED', limit: '20', offset: '0' }]);
  });

  it('combines the search with the KYC filter', async () => {
    const calls = listHandler(() => ok([]));
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('BANK_ADMIN'), route: '/customers' });
    await user.selectOptions(screen.getByLabelText('KYC status'), 'PENDING');
    await user.type(screen.getByLabelText('Search'), '98765');
    await waitFor(() => expect(calls.at(-1)).toEqual({ kycStatus: 'PENDING', q: '98765', limit: '20', offset: '0' }));
    expect(await screen.findByText('No customers match “98765”')).toBeInTheDocument();
  });

  it('announces loading', async () => {
    listHandler(async () => {
      await delay('infinite');
      return ok([]);
    });
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('SUPPORT'), route: '/customers' });
    await user.type(screen.getByLabelText('Search'), 'asha');
    expect(await screen.findByText('Loading customers…')).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    let attempt = 0;
    listHandler(() => (attempt++ === 0 ? fail(500, 'INTERNAL_SERVER_ERROR') : ok([aProfile()])));
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('SUPPORT'), route: '/customers?q=asha', path: '/customers' });
    expect(await screen.findByText('Something went wrong on our side')).toBeInTheDocument();
    expect(screen.getByText('Reference: test-corr')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: 'Open Asha Rao' })).toBeInTheDocument();
  });

  it('pages through results', async () => {
    const calls = listHandler((query) => ok(query.offset === '20' ? many(1) : many(20)));
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('SUPPORT'), route: '/customers?q=customer', path: '/customers' });
    await screen.findByRole('button', { name: 'Open Customer 19' });
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ q: 'customer', limit: '20', offset: '20' }));
    expect(await screen.findByText('Showing 21–21')).toBeInTheDocument();
  });

  it('goes back to the prompt when the search is cleared', async () => {
    listHandler(() => ok([aProfile()]));
    const { user } = renderWithApp(<CustomersPage />, { ...asStaff('SUPPORT'), route: '/customers?q=asha', path: '/customers' });
    await screen.findByRole('button', { name: 'Open Asha Rao' });
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Search for a customer')).toBeInTheDocument();
  });
});
