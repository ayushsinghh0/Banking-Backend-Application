import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { IDS, anAccount } from '@/test/fixtures';
import { qk } from '@/lib/query';
import type { Role } from '@/lib/auth/session';
import { SphereLauncher, SphereProvider } from './Sphere';

const SUGGESTIONS = ['What’s my balance?', 'How much did I spend this week?'];
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Each message POST gets a stream the test writes to */
function assistantApi(options: { conversations?: unknown[]; conversation?: unknown; refuse?: () => Response } = {}) {
  const encoder = new TextEncoder();
  const replies: Array<{ body: unknown; controller: ReadableStreamDefaultController<Uint8Array> }> = [];
  const created: unknown[] = [];
  const deleted: string[] = [];
  server.use(
    http.get(apiUrl('/assistant/meta'), () => ok({ provider: 'builtin', suggestions: SUGGESTIONS })),
    http.post(apiUrl('/assistant/conversations'), async ({ request }) => {
      created.push(await request.json());
      return ok({ id: 'c1', title: 'New', updatedAt: '2026-10-28T09:00:00.000Z' }, 201);
    }),
    http.get(apiUrl('/assistant/conversations'), () => ok(options.conversations ?? [])),
    http.get(apiUrl('/assistant/conversations/:id'), () => ok(options.conversation)),
    http.delete(apiUrl('/assistant/conversations/:id'), ({ params }) => {
      deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl('/assistant/conversations/:id/messages'), async ({ request }) => {
      if (options.refuse) return options.refuse();
      const body = await request.json();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          replies.push({ body, controller });
        },
      });
      return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    })
  );
  const latest = () => replies[replies.length - 1]!;
  return {
    replies,
    created,
    deleted,
    emit: (event: string, data: unknown) => latest().controller.enqueue(encoder.encode(frame(event, data))),
    finish: () => latest().controller.close(),
    answer(text: string, extra: Array<[string, unknown]> = []) {
      for (const [event, data] of extra) this.emit(event, data);
      this.emit('message.start', { messageId: 'm1' });
      for (const word of text.split(/(?<= )/)) this.emit('token', { text: word });
      this.emit('message.end', { messageId: 'm1' });
      this.finish();
    },
  };
}

function setup(role: Role = 'CUSTOMER', variant: 'floating' | 'header' = 'floating') {
  return renderWithApp(
    <SphereProvider>
      <SphereLauncher variant={variant} />
    </SphereProvider>,
    { route: '/dashboard', path: '/dashboard', role }
  );
}

type User = ReturnType<typeof setup>['user'];

async function openSphere(user: User) {
  await user.click(screen.getByRole('button', { name: /ask sphere/i }));
  return screen.findByRole('dialog', { name: 'Sphere' });
}

const live = (panel: HTMLElement) => panel.querySelector('[aria-live="polite"][aria-atomic="true"]')!;

describe('Sphere', () => {
  it('opens a panel with suggestions, the composer focused and the safety line, and closes back to the launcher', async () => {
    assistantApi();
    const { user } = setup();
    const launcher = screen.getByRole('button', { name: 'Ask Sphere' });
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    const panel = await openSphere(user);
    await waitFor(() => expect(within(panel).getByLabelText('Message Sphere')).toHaveFocus());
    expect(await within(panel).findByRole('button', { name: SUGGESTIONS[0] })).toBeInTheDocument();
    expect(within(panel).getByText("Sphere can't move money. Answers can be wrong; check important details.")).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sphere' })).not.toBeInTheDocument());
    expect(launcher).toHaveFocus();
  });

  it('moves focus into the panel when it reopens on the conversation list', async () => {
    assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    await user.click(within(panel).getByRole('button', { name: 'Conversations' }));
    await within(panel).findByText('No conversations yet');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sphere' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Ask Sphere' }));
    // It reopens on the list it was closed on. Nothing stays focused behind it: its first control takes focus
    const reopened = await screen.findByRole('dialog', { name: 'Conversations' });
    await waitFor(() => expect(within(reopened).getByRole('button', { name: 'Back to chat' })).toHaveFocus());
  });

  it('streams an answer with tool status, cards and text, and announces it when done', async () => {
    const api = assistantApi();
    const { user, queryClient } = setup();
    queryClient.setQueryData(qk.accounts, [anAccount()]);
    const panel = await openSphere(user);
    await user.click(await within(panel).findByRole('button', { name: SUGGESTIONS[0] }));
    await waitFor(() => expect(api.replies).toHaveLength(1));
    expect(api.created).toEqual([{ title: SUGGESTIONS[0] }]);
    expect(api.replies[0]!.body).toEqual({ content: SUGGESTIONS[0] });
    const conversation = within(panel).getByRole('list', { name: 'Conversation' });
    expect(conversation).toHaveTextContent(SUGGESTIONS[0]!);

    api.emit('message.start', { messageId: 'm1' });
    api.emit('tool.call', { name: 'list_accounts', label: 'Checking your accounts…' });
    expect(await within(conversation).findByText('Checking your accounts…')).toBeInTheDocument();
    await waitFor(() => expect(live(panel)).toHaveTextContent('Checking your accounts…'));
    expect(within(panel).getByRole('button', { name: 'Stop answering' })).toBeInTheDocument();

    api.emit('tool.result', {
      name: 'list_accounts',
      card: { type: 'accounts', accounts: [{ id: IDS.savings, label: 'Savings', last4: '6789', balancePaise: '12550075' }] },
    });
    api.answer('You have **₹1,25,500.75** across your accounts.');
    expect(await within(panel).findByText('₹1,25,500.75', { selector: 'strong' })).toBeInTheDocument();
    expect(within(conversation).queryByText('Checking your accounts…')).not.toBeInTheDocument();
    const card = within(panel).getByRole('region', { name: 'Your accounts' });
    expect(card).toHaveTextContent('Savings');
    expect(card).toHaveTextContent('••••6789');
    await waitFor(() => expect(live(panel)).toHaveTextContent('You have ₹1,25,500.75 across your accounts.'));
    expect(within(panel).getByRole('button', { name: 'Send message' })).toBeInTheDocument();

    // Rows open the account and close the panel
    await user.click(within(card).getByRole('button', { name: /savings/i }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/accounts/${IDS.savings}`));
  });

  it('sends with Enter, keeps Shift+Enter for new lines, and continues the same conversation', async () => {
    const api = assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    const input = within(panel).getByLabelText('Message Sphere');
    await user.type(input, 'Line one{Shift>}{Enter}{/Shift}line two');
    expect(input).toHaveValue('Line one\nline two');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    expect(api.replies[0]!.body).toEqual({ content: 'Line one\nline two' });
    expect(input).toHaveValue('');
    api.answer('Noted.');
    await within(panel).findByText('Noted.');
    await user.type(input, 'And again{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(2));
    expect(api.created).toHaveLength(1);
  });

  it('stops an answer and asks the same question again on request', async () => {
    const api = assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Spending this month{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.emit('token', { text: 'You spent' });
    await within(panel).findByText('You spent');
    await user.click(within(panel).getByRole('button', { name: 'Stop answering' }));
    expect(await within(panel).findByText('You stopped this answer.')).toBeInTheDocument();
    await waitFor(() => expect(live(panel)).toHaveTextContent('Stopped'));
    await user.click(within(panel).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.replies).toHaveLength(2));
    expect(api.replies[1]!.body).toEqual({ content: 'Spending this month' });
    api.answer('₹12,000 this month.');
    expect(await within(panel).findByText('₹12,000 this month.')).toBeInTheDocument();
    expect(within(panel).queryByText('You stopped this answer.')).not.toBeInTheDocument();
  });

  it('explains an error from the assistant and retries', async () => {
    const api = assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Balance{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.emit('error', { code: 'LLM_TIMEOUT', message: 'The model took too long' });
    api.finish();
    expect(await within(panel).findByText('Sphere took too long', { selector: 'p' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.replies).toHaveLength(2));
    api.answer('Here it is.');
    expect(await within(panel).findByText('Here it is.')).toBeInTheDocument();
  });

  it('says when the answer was cut off', async () => {
    const api = assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Balance{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.emit('token', { text: 'Half' });
    api.finish();
    expect(await within(panel).findByText('The answer was cut off', { selector: 'p' })).toBeInTheDocument();
  });

  it('explains a refusal such as the message limit', async () => {
    assistantApi({ refuse: () => fail(429, 'RATE_LIMIT_EXCEEDED', 'slow down', {}) });
    const { user } = setup();
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Balance{Enter}');
    expect(await within(panel).findByText('Too many messages', { selector: 'p' })).toBeInTheDocument();
  });

  it('turns a transfer draft into a prefilled transfer the customer reviews', async () => {
    const api = assistantApi();
    const { user, queryClient } = setup();
    queryClient.setQueryData(qk.accounts, [anAccount()]);
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Send Ravi 2500 for rent{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.answer('I’ve drafted it. Review it before sending.', [
      ['tool.result', { name: 'draft_transfer', card: { type: 'transferDraft', fromAccountId: IDS.savings, toPayeeNickname: 'Ravi', amountPaise: '250000', note: 'Rent' } }],
    ]);
    const draft = await within(panel).findByRole('region', { name: 'Transfer draft' });
    expect(draft).toHaveTextContent('Savings ••••6789');
    expect(draft).toHaveTextContent('Ravi');
    expect(draft).toHaveTextContent('₹2,500.00');
    expect(draft).toHaveTextContent('Nothing has been sent');
    await user.click(within(draft).getByRole('button', { name: 'Review transfer' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/transfer?from=${IDS.savings}&payeeName=Ravi&amount=250000&note=Rent`)
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sphere' })).not.toBeInTheDocument());
  });

  it('draws every other card type', async () => {
    const api = assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Everything{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.answer('Done.', [
      ['tool.result', { name: 'recent_transactions', card: { type: 'transactions', accountLabel: 'Savings ••••6789', items: [{ id: 't1', at: '2026-10-27T09:30:00Z', description: 'Salary', direction: 'CREDIT', amountPaise: '5000000' }, { id: 't2', at: '2026-10-27T10:30:00Z', description: 'Rent', direction: 'DEBIT', amountPaise: '2500000' }] } }],
      ['tool.result', { name: 'spending_summary', card: { type: 'spending', days: 7, inPaise: '5000000', outPaise: '2500000', byDay: [{ date: '2026-10-26', inPaise: '0', outPaise: '0' }, { date: '2026-10-27', inPaise: '5000000', outPaise: '2500000' }] } }],
      ['tool.result', { name: 'list_payees', card: { type: 'payees', items: [{ nickname: 'Ravi', last4: '5432', active: true }, { nickname: 'Plumber', last4: '7888', active: false }] } }],
      ['tool.result', { name: 'list_top_ups', card: { type: 'topups', items: [{ id: 'u1', amountPaise: '50000', status: 'CREDITED', at: '2026-10-27T09:30:00Z' }, { id: 'u2', amountPaise: '70000', status: 'FAILED', at: '2026-10-27T09:40:00Z' }] } }],
      ['tool.result', { name: 'search_help', card: { type: 'help', title: 'Add a payee', steps: ['Open Payees', 'Choose Add payee'] } }],
    ]);
    await within(panel).findByText('Done.');
    expect(within(panel).getByRole('region', { name: /recent transactions/i })).toHaveTextContent('+₹50,000.00');
    expect(within(panel).getByRole('region', { name: /recent transactions/i })).toHaveTextContent('-₹25,000.00');
    expect(within(panel).getByRole('img', { name: /highest: ₹25,000\.00/i })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Your payees' })).toHaveTextContent('Not active yet');
    expect(within(panel).getByRole('region', { name: 'Recent top-ups' })).toHaveTextContent('Failed');
    expect(within(panel).getByRole('region', { name: 'Add a payee' })).toHaveTextContent('Choose Add payee');
    await user.click(within(panel).getByRole('button', { name: 'Add money' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/add-money'));
  });

  it('lists past conversations, reopens one and deletes one after confirming', async () => {
    assistantApi({
      conversations: [
        { id: 'c7', title: 'Rent and bills', updatedAt: '2026-10-27T09:30:00.000Z' },
        { id: 'c8', title: null, updatedAt: '2026-10-26T09:30:00.000Z' },
      ],
      conversation: {
        id: 'c7',
        title: 'Rent and bills',
        messages: [
          { id: 'u1', role: 'user', content: 'How do I add a payee?', cards: [], createdAt: '2026-10-27T09:30:00.000Z' },
          { id: 'a1', role: 'assistant', content: 'Like this:', cards: [{ type: 'help', title: 'Add a payee', steps: ['Open Payees'] }], createdAt: '2026-10-27T09:30:05.000Z' },
        ],
      },
    });
    const { user } = setup();
    const panel = await openSphere(user);
    await user.click(within(panel).getByRole('button', { name: 'Conversations' }));
    const list = await within(panel).findByRole('list', { name: 'Conversations' });
    expect(within(list).getByText('Untitled conversation')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /^rent and bills/i }));
    expect(await within(panel).findByText('How do I add a payee?')).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Add a payee' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Conversations' }));
    const again = await within(panel).findByRole('list', { name: 'Conversations' });
    expect(within(again).getByRole('button', { name: /^rent and bills/i })).toHaveAttribute('aria-current', 'true');
    await user.click(within(again).getByRole('button', { name: 'Delete “Rent and bills”' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this conversation?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(within(panel).getByRole('button', { name: 'Back to chat' }));
    expect(await within(panel).findByText('Ask Sphere')).toBeInTheDocument();
  });

  it('says when there are no past conversations, and starts afresh on request', async () => {
    const api = assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    await user.type(within(panel).getByLabelText('Message Sphere'), 'Hello{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.answer('Hi!');
    await within(panel).findByText('Hi!');
    await user.click(within(panel).getByRole('button', { name: 'New conversation' }));
    expect(within(panel).queryByText('Hi!')).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Conversations' }));
    expect(await within(panel).findByText('No conversations yet')).toBeInTheDocument();
  });

  it('keeps cards informational for staff, with a header launcher', async () => {
    const api = assistantApi();
    const { user } = setup('SUPPORT', 'header');
    const panel = await openSphere(user);
    expect(within(panel).getByText(/how BankSphere works and where to find things/i, { selector: 'p:not(.sr-only)' })).toBeInTheDocument();
    await user.type(within(panel).getByLabelText('Message Sphere'), 'How do refunds work?{Enter}');
    await waitFor(() => expect(api.replies).toHaveLength(1));
    api.answer('Like this.', [['tool.result', { name: 'search_help', card: { type: 'help', title: 'Refunds', steps: ['Open the payments console'] } }]]);
    await within(panel).findByText('Like this.');
    expect(within(panel).queryByRole('button', { name: /review transfer/i })).not.toBeInTheDocument();
  });

  it('counts characters near the message limit', async () => {
    assistantApi();
    const { user } = setup();
    const panel = await openSphere(user);
    const input = within(panel).getByLabelText('Message Sphere');
    await user.click(input);
    await user.paste('x'.repeat(1850));
    expect(within(panel).getByText('1,850 / 2,000')).toBeInTheDocument();
  });
});
