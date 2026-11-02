import { isStaff } from '@banksphere/common';
import { suggestionsFor } from '../assistant/suggestions';
import { HelpArticle } from '../knowledge/articles';
import { CONFIDENT_SCORE, searchHelp } from '../knowledge/search';
import {
  AccountsData,
  DraftData,
  HelpData,
  LimitsData,
  PayeesData,
  SpendingData,
  ToolOutcome,
  TopUpsData,
  TransactionsData,
} from '../tools/tools';
import { DataIntent, Intent, routeIntent } from './intents';
import { AnswerProvider, streamWords, TurnInput } from './provider';

/**
 * Sphere without a model: an intent router over the same tools, with templated answers streamed word by word.
 * It is deterministic (same message and data, same answer), costs nothing per message, and is what answers when
 * no LLM key is configured, when the token budget can't be accounted for, or when the model fails before
 * saying anything.
 */
export class BuiltinProvider implements AnswerProvider {
  readonly kind = 'builtin' as const;

  constructor(
    private readonly options: { articles: readonly HelpArticle[]; wordDelayMs: number }
  ) {}

  public async respond(input: TurnInput): Promise<{ content: string }> {
    const text = await this.compose(input);
    await streamWords(text, input.emit, input.signal, this.options.wordDelayMs);
    return { content: text };
  }

  private async compose(input: TurnInput): Promise<string> {
    const staff = isStaff(input.user);
    const intent = routeIntent(input.message);
    const examples = suggestionsFor(input.user.role).slice(0, 3).map((s) => `“${s}”`).join(', ');

    switch (intent.kind) {
      case 'prompt_reveal':
        return `I can’t share how I’m set up, but I’m happy to help with your banking. You could ask: ${examples}.`;
      case 'other_user':
        return staff
          ? 'I can’t look up anyone’s account data here. For customer records, use the operations screens, where every access is recorded.'
          : 'I can only help with your own accounts, so I can’t look up anyone else’s details.';
      case 'greeting':
        return staff
          ? `Hi! I’m Sphere. I can help with procedures and general questions. Try: ${examples}.`
          : 'Hi! I’m Sphere, your BankSphere assistant. Ask me about your balance, recent transactions, spending, payees, top-ups or limits.';
      case 'thanks':
        return 'You’re welcome! Is there anything else I can help with?';
      case 'capabilities':
        return staff
          ? `I can walk you through procedures such as day close, KYC review, fraud triage, four-eyes approvals and refunds. I don’t have access to customer data. Try: ${examples}.`
          : 'I can tell you your balances, show recent transactions, add up your spending, list your payees and top-ups, explain your limits and how-tos, and prepare a transfer for you to review. I can’t move money myself.';
      case 'smalltalk':
        return `I’m Sphere, BankSphere’s banking assistant, so I can only help with banking questions. You could ask: ${examples}.`;
      case 'help':
        return this.help(input, intent.query, intent.fallback, examples);
      case 'unknown':
        return this.help(input, input.message, undefined, examples);
      default:
        if (staff) {
          return `As a staff member you can ask me about procedures and general help. I can’t look up customer or account data; use the operations screens for that, where every access is recorded. Try: ${examples}.`;
        }
        return this.customerData(input, intent);
    }
  }

  private async help(input: TurnInput, query: string, fallback: DataIntent | undefined, examples: string): Promise<string> {
    const audience = isStaff(input.user) ? 'staff' : 'customer';
    const best = searchHelp(this.options.articles, query, audience, 1)[0];
    if (!best || best.score < CONFIDENT_SCORE) {
      if (fallback && !isStaff(input.user)) return this.customerData(input, fallback);
      return `I’m not sure I understood that. You could ask: ${examples}.`;
    }
    const outcome = (await input.tools.run('search_help', { query })) as ToolOutcome<HelpData>;
    if (!outcome.ok) return outcome.error;
    const article = outcome.data.articles[0];
    if (!article) return `I couldn’t find a help article for that. You could ask: ${examples}.`;
    const more = article.steps.length > 1 ? ' The full steps are below.' : '';
    return `${article.title}: ${article.steps[0]}${more}`;
  }

  private async customerData(input: TurnInput, intent: Exclude<Intent, { kind: 'help' | 'unknown' | 'greeting' | 'thanks' | 'capabilities' | 'smalltalk' | 'prompt_reveal' | 'other_user' }>): Promise<string> {
    const { tools } = input;
    switch (intent.kind) {
      case 'balances':
        return balancesAnswer((await tools.run('list_accounts', {})) as ToolOutcome<AccountsData>);
      case 'transactions':
        return transactionsAnswer(
          (await tools.run('recent_transactions', { ...(intent.limit && { limit: intent.limit }), ...(intent.account && { account: intent.account }) })) as ToolOutcome<TransactionsData>
        );
      case 'spending':
        return spendingAnswer((await tools.run('spending_summary', { days: intent.days })) as ToolOutcome<SpendingData>);
      case 'payees':
        return payeesAnswer((await tools.run('list_payees', {})) as ToolOutcome<PayeesData>);
      case 'topups':
        return topUpsAnswer((await tools.run('list_top_ups', {})) as ToolOutcome<TopUpsData>);
      case 'limits':
        return limitsAnswer((await tools.run('explain_limits', {})) as ToolOutcome<LimitsData>);
      case 'transfer':
        return draftAnswer(
          (await tools.run('draft_transfer', {
            ...(intent.payee && { toPayee: intent.payee }),
            ...(intent.amount && { amount: intent.amount }),
            ...(intent.note && { note: intent.note }),
          })) as ToolOutcome<DraftData>
        );
    }
  }
}

// --- templates ----------------------------------------------------------------------------------------------------

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const shortTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

function list(items: string[], max = 4): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function accountTitle(account: AccountsData['accounts'][number]): string {
  const base = account.label.replace(/ \(.*\)$/, '');
  return `${base} ••${account.last4}${account.status !== 'ACTIVE' ? ` (${account.status.toLowerCase()})` : ''}`;
}

function balancesAnswer(outcome: ToolOutcome<AccountsData>): string {
  if (!outcome.ok) return outcome.error;
  const { accounts, totalBalance, balanceUnavailable } = outcome.data;
  if (!accounts.length) return 'You don’t have any open accounts yet. Once your KYC is verified, you can open one from Accounts.';
  const withBalance = accounts.filter((a) => a.balance);
  const missing = balanceUnavailable.length ? ` I couldn’t load the balance of ${list(balanceUnavailable.map((d) => `••${d}`))} right now.` : '';
  if (accounts.length === 1 && withBalance.length === 1) return `Your ${accountTitle(accounts[0])} account has ${accounts[0].balance}.`;
  const parts = withBalance.map((a) => `${accountTitle(a)} has ${a.balance}`);
  return `You have ${totalBalance} across ${withBalance.length} account${withBalance.length === 1 ? '' : 's'}: ${list(parts)}.${missing}`;
}

function transactionsAnswer(outcome: ToolOutcome<TransactionsData>): string {
  if (!outcome.ok) return outcome.error;
  const { account, transactions } = outcome.data;
  if (!transactions.length) return `There are no transactions on ${account} yet.`;
  const latest = transactions[0];
  const what = `${latest.amount} ${latest.direction === 'in' ? 'in' : 'out'} (“${latest.description}”) on ${shortDate(latest.at)}`;
  return transactions.length === 1
    ? `The only transaction on ${account} is ${what}.`
    : `Here are the last ${transactions.length} transactions on ${account}. The latest was ${what}.`;
}

function spendingAnswer(outcome: ToolOutcome<SpendingData>): string {
  if (!outcome.ok) return outcome.error;
  const d = outcome.data;
  const period = d.days === 1 ? 'Today' : `In the last ${d.days} days`;
  if (!d.transactionsCounted) return d.days === 1 ? 'You haven’t had any money in or out today.' : `You had no money in or out in the last ${d.days} days.`;
  const up = !d.net.startsWith('-');
  let text = `${period} you received ${d.moneyIn} and spent ${d.moneyOut}, so you’re ${up ? 'up' : 'down'} ${d.net.replace(/^-/, '')}.`;
  if (d.biggestPayment) text += ` Your biggest payment was ${d.biggestPayment.amount} (“${d.biggestPayment.description}”) on ${shortDate(d.biggestPayment.date)}.`;
  if (d.internalTransfersExcluded) text += ' Transfers between your own accounts aren’t counted.';
  if (d.partial) text += ' Some older transactions couldn’t be included, so the totals may be incomplete.';
  return text;
}

function payeesAnswer(outcome: ToolOutcome<PayeesData>): string {
  if (!outcome.ok) return outcome.error;
  const { payees } = outcome.data;
  if (!payees.length) return 'You haven’t added any payees yet. Open Payees and add one with their 12-digit account number and a nickname.';
  const names = payees.map((p) => `${p.nickname} (••${p.last4}${!p.active && p.activatesAt ? `, can be paid from ${shortTime(p.activatesAt)}` : ''})`);
  return `You have ${payees.length} payee${payees.length === 1 ? '' : 's'}: ${list(names, 5)}.`;
}

function topUpsAnswer(outcome: ToolOutcome<TopUpsData>): string {
  if (!outcome.ok) return outcome.error;
  const { topUps } = outcome.data;
  if (!topUps.length) return 'You haven’t added money yet. Use Add money to top up with UPI, a card or net banking.';
  const latest = topUps[0];
  let text = `Your latest top-up of ${latest.amount} on ${shortDate(latest.at)}: ${latest.meaning}.`;
  if (latest.failureReason) text += ` Reason: ${latest.failureReason}.`;
  if (['CREATED', 'PENDING', 'CAPTURED'].includes(latest.status)) text += ' If you were charged, it will be added to your account or refunded automatically.';
  if (topUps.length > 1) text += ` Your last ${topUps.length} top-ups are below.`;
  return text;
}

function limitsAnswer(outcome: ToolOutcome<LimitsData>): string {
  if (!outcome.ok) return outcome.error;
  const [first, second] = outcome.data.lines;
  return `Here are your limits. ${first}.${second ? ` ${second}.` : ''} The full list is below.`;
}

function draftAnswer(outcome: ToolOutcome<DraftData>): string {
  if (!outcome.ok) return outcome.error;
  const d = outcome.data;
  let text = `I’ve prepared a draft${d.amount ? ` of ${d.amount}` : ''}${d.to ? ` to ${d.to}` : ''} from ${d.from}.`;
  if (d.warnings.length) text += ` ${d.warnings.join(' ')}`;
  if (!d.amount) text += ' Add the amount on the transfer screen.';
  if (!d.to && !d.payeeNotFound) text += ' Choose the payee on the transfer screen.';
  return `${text} Check it and confirm it on the transfer screen: I can’t send money myself.`;
}
