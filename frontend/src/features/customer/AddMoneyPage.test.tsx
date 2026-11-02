import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { mockRealtimeStream } from '@/test/realtime';
import { IDS, aPaymentConfig, aProfile, aTopUp, anAccount, type PaymentConfigOverrides } from '@/test/fixtures';
import type { TopUp } from '@/lib/api/types';
import { RealtimeProvider } from '@/lib/realtime';
import { qk } from '@/lib/query';
import { mockCustomerApi } from './testing';
import { resetRazorpayLoader, type RazorpayOptions } from './razorpay';
import AddMoneyPage from './AddMoneyPage';

const savings = anAccount();
const current = anAccount({ id: IDS.current, accountNumber: '100111112222', accountType: 'CURRENT' });
const frozen = anAccount({ id: IDS.payeeAccount, accountNumber: '100133334444', status: 'FROZEN' });
const PROOF = { razorpayPaymentId: 'pay_SIM123', razorpayOrderId: 'order_SIM1', razorpaySignature: 'sig' };
const CHECKOUT = {
  keyId: 'rzp_test_banksphere',
  orderId: 'order_SIM1',
  amount: '50000',
  currency: 'INR',
  name: 'BankSphere',
  description: 'Add money to ••••6789',
  prefill: { email: 'asha@example.in' },
};

interface Recorded {
  path: string;
  body: unknown;
  key: string | null;
}

/**
 * The payment service: answers each route with the given responses in turn (the last one repeats) and
 * records what was sent.
 */
function paymentsApi(
  routes: {
    create?: Array<() => Response>;
    confirm?: Array<() => Response>;
    simulate?: Array<() => Response>;
    cancel?: Array<() => Response>;
    get?: Array<() => Response>;
  } = {}
) {
  const sent: Recorded[] = [];
  const counts: Record<string, number> = {};
  const answer = (name: keyof typeof routes, fallback: () => Response) => async ({ request }: { request: Request }) => {
    const text = await request.text();
    sent.push({ path: `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}`, body: text ? JSON.parse(text) : undefined, key: request.headers.get('Idempotency-Key') });
    const list = routes[name] ?? [fallback];
    counts[name] = (counts[name] ?? 0) + 1;
    return list[Math.min(counts[name]! - 1, list.length - 1)]!();
  };
  server.use(
    http.post(apiUrl('/payments/top-ups'), answer('create', () => ok({ topUp: aTopUp(), checkout: CHECKOUT }, 201))),
    http.post(apiUrl('/payments/top-ups/:id/confirm'), answer('confirm', () => ok({ topUp: credited() }))),
    http.post(apiUrl('/payments/top-ups/:id/simulate'), answer('simulate', () => ok(PROOF))),
    http.post(apiUrl('/payments/top-ups/:id/cancel'), answer('cancel', () => ok({ topUp: aTopUp({ status: 'CANCELLED' }) }))),
    http.get(apiUrl('/payments/top-ups/:id'), answer('get', () => ok(credited())))
  );
  return sent;
}

const credited = (o: Partial<TopUp> = {}) =>
  aTopUp({ status: 'CREDITED', method: 'card', providerPaymentId: 'pay_SIM123', creditedAt: '2026-10-27T09:31:00.000Z', ...o });

function setup(
  options: { config?: PaymentConfigOverrides; route?: string; topUps?: TopUp[]; realtime?: boolean } = {}
) {
  mockCustomerApi({
    profile: aProfile(),
    accounts: [savings, current, frozen],
    balances: { [IDS.savings]: '12550075', [IDS.current]: '4999925' },
  });
  server.use(
    http.get(apiUrl('/payments/config'), () => ok(aPaymentConfig(options.config))),
    http.get(apiUrl('/payments/top-ups'), () => ok({ items: options.topUps ?? [], nextCursor: null }))
  );
  const ui = options.realtime ? (
    <RealtimeProvider>
      <AddMoneyPage />
    </RealtimeProvider>
  ) : (
    <AddMoneyPage />
  );
  return renderWithApp(ui, { route: options.route ?? '/add-money', path: '/add-money' });
}

type User = ReturnType<typeof setup>['user'];

async function enterAmount(user: User, amount = '500') {
  const field = await screen.findByLabelText('Amount');
  await user.clear(field);
  await user.type(field, amount);
}

afterEach(() => {
  resetRazorpayLoader();
  delete window.Razorpay;
});

describe('AddMoneyPage', () => {
  it('starts from the account in the link and shows today’s limits and how people can pay', async () => {
    setup({ route: `/add-money?account=${IDS.current}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'Add money' })).toBeInTheDocument();
    const account = await screen.findByLabelText('To account');
    await waitFor(() => expect(account).toHaveValue(IDS.current));
    // Frozen accounts can't receive money
    expect(within(account).queryByRole('option', { name: /••••4444/ })).not.toBeInTheDocument();
    expect(await screen.findByText(/₹1,50,000\.00 left today/)).toBeInTheDocument();
    expect(screen.getByText(/up to ₹1,00,000\.00 per payment/i)).toBeInTheDocument();
    expect(screen.getByText(/UPI, cards and net banking/i)).toBeInTheDocument();
    expect(screen.getByText(/test mode/i)).toBeInTheDocument();
  });

  it('fills the amount from the quick chips', async () => {
    const { user } = setup();
    const chips = await screen.findByRole('group', { name: 'Quick amounts' });
    await user.click(within(chips).getByRole('button', { name: '₹5,000' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('5000');
    expect(within(chips).getByRole('button', { name: '₹5,000' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chips).getByRole('button', { name: '₹500' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('turns off chips above what can still be added today', async () => {
    setup({ config: { limits: { remainingTodayPaise: '300000' } } });
    const chips = await screen.findByRole('group', { name: 'Quick amounts' });
    expect(within(chips).getByRole('button', { name: '₹1,000' })).toBeEnabled();
    expect(within(chips).getByRole('button', { name: '₹5,000' })).toBeDisabled();
  });

  it('checks the amount against the limits before paying', async () => {
    const sent = paymentsApi();
    const { user } = setup({ config: { limits: { minPaise: '10000', remainingTodayPaise: '600000' } } });
    await screen.findByText(/left today/);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter an amount')).toBeInTheDocument();
    await enterAmount(user, '50');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('The smallest amount you can add is ₹100.00')).toBeInTheDocument();
    await enterAmount(user, '7000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('You can add up to ₹6,000.00 more today')).toBeInTheDocument();
    await enterAmount(user, '100001');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('You can add up to ₹1,00,000.00 in one payment')).toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('pays in the simulated checkout and shows a receipt', async () => {
    const sent = paymentsApi();
    const { user, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const sheet = await screen.findByRole('dialog', { name: 'Test checkout' });
    expect(within(sheet).getByText('Simulated payment — no real money moves')).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: 'UPI' })).toBeChecked();
    await user.click(within(sheet).getByRole('radio', { name: 'Card' }));
    await user.click(within(sheet).getByRole('button', { name: 'Pay ₹500.00' }));

    expect(await screen.findByRole('heading', { name: 'Money added' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Test checkout' })).not.toBeInTheDocument();
    const receipt = screen.getByRole('region', { name: 'Money added' });
    expect(receipt).toHaveTextContent('Savings ••••6789');
    expect(receipt).toHaveTextContent('pay_SIM123');
    expect(receipt).toHaveTextContent('Card');
    expect(within(receipt).getByRole('button', { name: 'Copy reference' })).toBeInTheDocument();
    expect(within(receipt).getByRole('link', { name: 'View account' })).toHaveAttribute('href', `/accounts/${IDS.savings}`);

    expect(sent.map((s) => s.path).filter((path) => path.startsWith('POST'))).toEqual([
      'POST /payments/top-ups',
      'POST /payments/top-ups/top-1/simulate',
      'POST /payments/top-ups/top-1/confirm',
    ]);
    expect(sent[0]!.body).toEqual({ accountId: IDS.savings, amountPaise: '50000' });
    expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]!.body).toEqual({ outcome: 'success', method: 'card' });
    expect(sent[2]!.body).toEqual(PROOF);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.balances });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.payments });

    await user.click(screen.getByRole('button', { name: 'Add more money' }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('');
  });

  it('waits for the credit and finishes when the real-time update arrives', async () => {
    const stream = mockRealtimeStream();
    let gets = 0;
    paymentsApi({
      confirm: [() => ok({ topUp: aTopUp({ status: 'CAPTURED', providerPaymentId: 'pay_SIM123' }) })],
      get: [
        () => {
          gets += 1;
          return ok(gets === 1 ? aTopUp({ status: 'CAPTURED' }) : credited());
        },
      ],
    });
    const { user } = setup({ realtime: true });
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Pay ₹500.00' }));
    expect(await screen.findByRole('heading', { name: 'Confirming your payment' })).toBeInTheDocument();
    await waitFor(() => expect(stream.connections.length).toBeGreaterThan(0));
    stream.send('payment.updated', { topUpId: 'top-1', status: 'CREDITED', amountInPaise: '50000', accountId: IDS.savings });
    expect(await screen.findByRole('heading', { name: 'Money added' })).toBeInTheDocument();
  });

  it('keeps checking without real-time updates, and when the confirmation itself failed', async () => {
    paymentsApi({
      confirm: [() => fail(503, 'SERVICE_UNAVAILABLE', 'down')],
      get: [() => ok(aTopUp({ status: 'PENDING' })), () => ok(credited())],
    });
    const { user } = setup();
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Pay ₹500.00' }));
    expect(await screen.findByRole('heading', { name: 'Confirming your payment' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Money added' })).toBeInTheDocument();
  });

  it('declines in the simulated checkout, explains the failure and retries with a new key', async () => {
    const sent = paymentsApi({
      simulate: [() => ok(PROOF)],
      confirm: [() => fail(422, 'PAYMENT_NOT_CAPTURED', 'Payment failed')],
      get: [() => ok(aTopUp({ status: 'FAILED', failureReason: 'PAYMENT_DECLINED' }))],
    });
    const { user } = setup();
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeInTheDocument();
    expect(screen.getByText(/payment declined/i)).toBeInTheDocument();
    expect(sent[1]!.body).toEqual({ outcome: 'failure', method: 'upi' });

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('dialog', { name: 'Test checkout' });
    const creates = sent.filter((s) => s.path === 'POST /payments/top-ups');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.key).not.toBe(creates[0]!.key);
  });

  it('cancels the top-up when the checkout is closed', async () => {
    const sent = paymentsApi();
    const { user } = setup();
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const sheet = await screen.findByRole('dialog', { name: 'Test checkout' });
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Payment cancelled')).toBeInTheDocument();
    await waitFor(() => expect(sent.map((s) => s.path)).toContain('POST /payments/top-ups/top-1/cancel'));
    expect(screen.getByLabelText('Amount')).toHaveValue('500');
  });

  it('shows a problem inside the test checkout and lets the customer try again', async () => {
    paymentsApi({ simulate: [() => fail(503, 'SERVICE_UNAVAILABLE', 'down'), () => ok(PROOF)] });
    const { user } = setup();
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const sheet = await screen.findByRole('dialog', { name: 'Test checkout' });
    await user.click(within(sheet).getByRole('button', { name: 'Pay ₹500.00' }));
    expect(await within(sheet).findByText('Temporarily unavailable')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Pay ₹500.00' }));
    expect(await screen.findByRole('heading', { name: 'Money added' })).toBeInTheDocument();
  });

  it('reuses the idempotency key when the same top-up is retried after a network failure', async () => {
    const sent = paymentsApi({ create: [() => HttpResponse.error(), () => ok({ topUp: aTopUp(), checkout: CHECKOUT }, 201)] });
    const { user } = setup();
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('You appear to be offline')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('dialog', { name: 'Test checkout' });
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });

  it('explains a refusal next to the field it is about', async () => {
    paymentsApi({ create: [() => fail(422, 'TOPUP_DAILY_LIMIT_EXCEEDED', 'Daily top-up limit exceeded')] });
    const { user } = setup();
    await enterAmount(user, '500');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Daily limit reached')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says when today’s limit has been used up', async () => {
    setup({ config: { limits: { usedTodayPaise: '20000000', remainingTodayPaise: '0' } } });
    expect(await screen.findByText('You’ve reached today’s limit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  describe('with Razorpay Checkout', () => {
    function fakeRazorpay() {
      const instances: Array<{ options: RazorpayOptions; failed?: (r: unknown) => void; opened: boolean }> = [];
      window.Razorpay = class {
        private readonly entry: (typeof instances)[number];
        constructor(options: RazorpayOptions) {
          this.entry = { options, opened: false };
          instances.push(this.entry);
        }
        open() {
          this.entry.opened = true;
        }
        close() {}
        on(_event: string, handler: (r: unknown) => void) {
          this.entry.failed = handler;
        }
      } as unknown as typeof window.Razorpay;
      return instances;
    }

    it('opens Checkout for the order and confirms the signed payment', async () => {
      const instances = fakeRazorpay();
      const sent = paymentsApi();
      const { user } = setup({ config: { mode: 'test' } });
      expect(await screen.findByText(/processed securely by Razorpay/i)).toBeInTheDocument();
      await enterAmount(user, '500');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(instances[0]?.opened).toBe(true));
      expect(instances[0]!.options).toMatchObject({
        key: 'rzp_test_banksphere',
        order_id: 'order_SIM1',
        amount: '50000',
        currency: 'INR',
        prefill: { email: 'asha@example.in' },
      });
      instances[0]!.options.handler({ razorpay_payment_id: 'pay_SIM123', razorpay_order_id: 'order_SIM1', razorpay_signature: 'sig' });
      expect(await screen.findByRole('heading', { name: 'Money added' })).toBeInTheDocument();
      expect(sent.find((s) => s.path.endsWith('/confirm'))!.body).toEqual(PROOF);
    });

    it('cancels the top-up when Checkout is dismissed', async () => {
      const instances = fakeRazorpay();
      const sent = paymentsApi();
      const { user } = setup({ config: { mode: 'live' } });
      await enterAmount(user, '500');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(instances[0]?.opened).toBe(true));
      instances[0]!.options.modal!.ondismiss!();
      expect(await screen.findByText('Payment cancelled')).toBeInTheDocument();
      await waitFor(() => expect(sent.map((s) => s.path)).toContain('POST /payments/top-ups/top-1/cancel'));
    });

    it('shows the failure Razorpay reports, and does not cancel afterwards', async () => {
      const instances = fakeRazorpay();
      const sent = paymentsApi();
      const { user } = setup({ config: { mode: 'live' } });
      await enterAmount(user, '500');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(instances[0]?.opened).toBe(true));
      instances[0]!.failed!({ error: { code: 'BAD_REQUEST_ERROR', description: 'Your bank declined this payment' } });
      expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeInTheDocument();
      expect(screen.getByText('Your bank declined this payment')).toBeInTheDocument();
      instances[0]!.options.modal!.ondismiss!();
      expect(sent.map((s) => s.path)).not.toContain('POST /payments/top-ups/top-1/cancel');
    });

    it('cancels and explains when Checkout cannot be loaded', async () => {
      const sent = paymentsApi();
      const { user } = setup({ config: { mode: 'live' } });
      await enterAmount(user, '500');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(document.querySelector('script[src*="checkout.razorpay.com"]')).not.toBeNull());
      document.querySelector('script[src*="checkout.razorpay.com"]')!.dispatchEvent(new Event('error'));
      expect(await screen.findByText('We couldn’t open the payment window')).toBeInTheDocument();
      await waitFor(() => expect(sent.map((s) => s.path)).toContain('POST /payments/top-ups/top-1/cancel'));
      document.querySelector('script[src*="checkout.razorpay.com"]')?.remove();
    });
  });

  describe('recent top-ups', () => {
    it('lists them with their status, and money added in green', async () => {
      setup({
        topUps: [
          credited({ id: 't1', amountPaise: '250000', method: 'upi' }),
          aTopUp({ id: 't2', status: 'FAILED', amountPaise: '70000', accountId: IDS.current, accountNumberLast4: '2222' }),
          aTopUp({ id: 't3', status: 'PENDING', amountPaise: '10000' }),
        ],
      });
      const list = await screen.findByRole('list', { name: 'Recent top-ups' });
      const rows = await within(list).findAllByRole('listitem');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent('+₹2,500.00');
      expect(rows[0]).toHaveTextContent('UPI');
      expect(within(rows[0]!).queryByText('Added')).not.toBeInTheDocument();
      expect(rows[1]).toHaveTextContent('Current ••••2222');
      expect(rows[1]).toHaveTextContent('Failed');
      expect(rows[2]).toHaveTextContent('Waiting for payment');
    });

    it('loads older top-ups on request', async () => {
      const pages: Record<string, unknown> = {
        first: { items: [credited({ id: 't1' })], nextCursor: 'c2' },
        c2: { items: [credited({ id: 't2', amountPaise: '99900' })], nextCursor: null },
      };
      mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: {} });
      server.use(
        http.get(apiUrl('/payments/config'), () => ok(aPaymentConfig())),
        http.get(apiUrl('/payments/top-ups'), ({ request }) => ok(pages[new URL(request.url).searchParams.get('cursor') ?? 'first']))
      );
      const { user } = renderWithApp(<AddMoneyPage />, { route: '/add-money', path: '/add-money' });
      const list = await screen.findByRole('list', { name: 'Recent top-ups' });
      await within(list).findByText('+₹500.00');
      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(await within(list).findByText('+₹999.00')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    });

    it('says when there are none yet', async () => {
      setup();
      expect(await screen.findByText('No top-ups yet')).toBeInTheDocument();
    });
  });

  it('needs an active account', async () => {
    mockCustomerApi({ profile: aProfile(), accounts: [frozen], balances: {} });
    server.use(
      http.get(apiUrl('/payments/config'), () => ok(aPaymentConfig())),
      http.get(apiUrl('/payments/top-ups'), () => ok({ items: [], nextCursor: null }))
    );
    renderWithApp(<AddMoneyPage />, { route: '/add-money', path: '/add-money' });
    expect(await screen.findByText('No account to add money to')).toBeInTheDocument();
  });

  it('asks the customer to wait for identity verification', async () => {
    mockCustomerApi({ profile: aProfile({ kycStatus: 'PENDING' }), accounts: [savings], balances: {} });
    server.use(
      http.get(apiUrl('/payments/config'), () => ok(aPaymentConfig())),
      http.get(apiUrl('/payments/top-ups'), () => ok({ items: [], nextCursor: null }))
    );
    renderWithApp(<AddMoneyPage />, { route: '/add-money', path: '/add-money' });
    expect(await screen.findByText(/once we’ve verified your identity/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('offers a retry when the payment settings cannot be loaded', async () => {
    let calls = 0;
    mockCustomerApi({ profile: aProfile(), accounts: [savings], balances: {} });
    server.use(
      http.get(apiUrl('/payments/config'), () => {
        calls += 1;
        return calls === 1 ? fail(503, 'SERVICE_UNAVAILABLE', 'down') : ok(aPaymentConfig());
      }),
      http.get(apiUrl('/payments/top-ups'), () => ok({ items: [], nextCursor: null }))
    );
    const { user } = renderWithApp(<AddMoneyPage />, { route: '/add-money', path: '/add-money' });
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByLabelText('Amount')).toBeInTheDocument();
  });
});
