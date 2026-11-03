/**
 * The built-in assistant's intent router: ordered rules over the normalised message, first match wins, so the
 * same message always gets the same answer. It understands common English and Hinglish phrasings ("balance kitna
 * hai", "Mom ko 500 bhejo"). Rules that refuse (prompt reveal, other people's data) run before anything that
 * would call a tool.
 */
export type DataIntent =
  | { kind: 'balances' }
  | { kind: 'transactions'; limit?: number; account?: string }
  | { kind: 'spending'; days: number }
  | { kind: 'payees' }
  | { kind: 'topups' };

export type Intent =
  | DataIntent
  | { kind: 'limits' }
  | { kind: 'transfer'; amount?: string; payee?: string; note?: string }
  | { kind: 'help'; query: string; fallback?: DataIntent }
  | { kind: 'greeting' }
  | { kind: 'thanks' }
  | { kind: 'capabilities' }
  | { kind: 'smalltalk' }
  | { kind: 'prompt_reveal' }
  | { kind: 'other_user' }
  | { kind: 'unknown' };

const PROMPT_REVEAL =
  /\b(system prompt|your (instructions|prompt|rules|guidelines|system|configuration|initial prompt)|ignore (all |any |the |your )*(previous|prior|above|earlier)|reveal (your|the) (prompt|instructions)|developer mode|jailbreak|pretend (to be|you are))\b/;
const GREETING_ONLY =
  /^(hi+|hello+|hey+|hiya|yo|namaste|namaskar|hola|good (morning|afternoon|evening|night)|kaise ho|kya haal hai|how are you|how r u)( (there|sphere|team|ji|bhai|friend))*[!.?, ]*$/;
const THANKS_ONLY =
  /^((ok|okay|great|cool|nice|got it|perfect)[ ,!.]*)?(thanks|thank you|thank u|thx|ty|shukriya|dhanyavad|dhanyawad)( (so much|a lot|very much|sphere|ji))*[!. ]*$/;
const WHO_CAN_I_PAY = /\bwho (can|do) i (send|pay|transfer)/;
const LIMITS = /\blimits?\b|\bmaximum\b|\bhow much (can|may|could) i (send|transfer|withdraw|add|pay)\b|\bkitna (bhej|transfer|nikal|add)/;

const SEND = /\b(send|transfer|pay|wire|bhej\w*)\b/;
const PAST_PAYMENT = /\b(did|have|has|had|was|were)\b[^.?!]*\b(send|sent|pay|paid|transfer\w*)\b/;
const SEND_ME = /\bsend me\b/;

const OTHER_USER =
  /\b(someone else'?s?|somebody else'?s?|another (customer|user|person|account holder)'?s?|other (customers?|users?|people)'?s?|(his|her|their) (balance|accounts?|transactions|money)|(?!(?:what|that|it|there|here|who|where|how|let|he|she)'s)[a-z]+'s (account|balance|transactions|spending|money|payees))/;

const HOW_TO = /\b(how (do|does|can|to|should|would|will|could)|kaise|kaisa|kese|steps? (to|for)|process (to|for)|procedure|guide me|explain|what does .{1,30} mean)\b/;
const ADD_PAYEE = /\badd(ing)? (a |new |my |another )*(payee|beneficiar)/;
const LOGIN_HISTORY = /\b(login|log-in|sign[- ]?in)s? (history|activity)\b/;
const TOPIC =
  /\b(freez\w*|unfreez\w*|block(ed)?|lost|stolen|hack\w*|kyc|authenticator|2fa|mfa|otp|step[- ]?up|withdrawal codes?|withdraw|sessions?|devices?|log ?out|sign ?out|support|customer care|complaint|scam|phishing|fraud|password|cooling|safety|security|safe)\b/;
const ADD_MONEY = /\b(add(ed)? money|money add\w*|paise add\w*|paisa add\w*|load money)\b/;
const TOPUP_STATUS = /\b(status|credited|through|pending|failed|success\w*|hua|history|recent|last)\b/;

const TOPUPS = /\btop[- ]?ups?\b|\brecharge\b|\brazorpay\b/;
const SPENDING = /\b(spen[dt]\w*|expens\w*|expenditure|kharch\w*|outgoings?|income|earn\w*|cash ?flow|money (in|out)|in and out|aamdani|budget)\b/;
const TRANSACTIONS =
  /\b(transactions?|txns?|statement|history|activity|passbook|len ?-?den|lenden|credits?|debits?|entries)\b|\bwho did i (pay|send)\b|\bpayments? (made|received|history)\b/;
const BALANCES =
  /\b(balances?|bal|funds?)\b|\bhow much (money|cash|funds?)\b|\bkitn[ae] paise\b|\bpaise kitne\b|\bkitna paisa\b|\bpaisa kitna\b|\bmy accounts?\b|\baccount (summary|details|overview)\b|\bnet worth\b/;
const PAYEES = /\b(payees?|beneficiar\w*)\b|\bsaved (contacts|accounts|people)\b/;

const CAPABILITIES = /^(help|help me|menu|options)[!.? ]*$|\bwhat can you do\b|\bwhat do you do\b|\bwho are you\b|\bwhat are you\b|\byour features\b|\bkya kar sakt/;
const SMALLTALK =
  /\b(weather|jokes?|poem|poetry|song|lyrics|movies?|film|cricket|football|ipl|match|politic\w*|election|recipe|news|stocks?|shares?|crypto\w*|bitcoin|invest\w*|horoscope|translate|capital of|girlfriend|boyfriend|story|game|sing)\b|\bwrite (me )?(a|an)\b/;
const GREETING_PREFIX = /^(hi+|hello+|hey+|namaste|namaskar|good (morning|afternoon|evening))\b/;
const THANKS = /\b(thanks|thank you|shukriya|dhanyavad|dhanyawad)\b/;

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function daysFrom(n: string): number {
  const days = /\b(\d{1,3})\s*(days?|din)\b/.exec(n);
  if (days) return clamp(Number(days[1]), 1, 90);
  const months = /\b(\d{1,2})\s*(months?|mahine|mahina)\b/.exec(n);
  if (months) return clamp(Number(months[1]) * 30, 1, 90);
  if (/\b(today|aaj)\b/.test(n)) return 1;
  if (/\b(week|weekly|hafte|hafta)\b/.test(n)) return 7;
  if (/\bfortnight\b/.test(n)) return 14;
  if (/\b(quarter|year|yearly|saal|annual)\b/.test(n)) return 90;
  return 30;
}

function dataIntent(n: string): DataIntent | null {
  if (TOPUPS.test(n) || (ADD_MONEY.test(n) && TOPUP_STATUS.test(n))) return { kind: 'topups' };
  if (SPENDING.test(n)) return { kind: 'spending', days: daysFrom(n) };
  if (TRANSACTIONS.test(n)) {
    const intent: Extract<DataIntent, { kind: 'transactions' }> = { kind: 'transactions' };
    const count = /\b(?:last|latest|recent|pichle)\s+(\d{1,2})\b/.exec(n) ?? /\b(\d{1,2})\s+(?:transactions?|txns?|entries|len ?-?den)\b/.exec(n);
    if (count) intent.limit = clamp(Number(count[1]), 1, 20);
    const account = /(?:ending(?: in| with)?|ends with|••|\*{2,}|\bx{2,})\s*(\d{4})\b/.exec(n);
    if (account) intent.account = account[1];
    return intent;
  }
  if (BALANCES.test(n)) return { kind: 'balances' };
  if (PAYEES.test(n)) return { kind: 'payees' };
  return null;
}

// Words around a payee's name that aren't part of it ("rupees bhejo papa", "my sister", "Mom's account")
const FILLER = new Set(
  (
    'rupees rupee rupaye rs inr bhejo bhej bhejna bhejiye bhejdo do de dena paise paisa send transfer pay please pls my mere meri mera ' +
    'the money amount karo kar kardo to account ka ki ke a an and some'
  ).split(' ')
);
const NOT_A_PAYEE = /^(me|us|him|her|them|myself|you|someone|somebody|savings?|current|accounts?|wallet|it|this|that)$/i;

function cleanPayee(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const words = raw.replace(/'s\b.*$/i, '').split(/\s+/).filter(Boolean);
  while (words.length && (FILLER.has(words[0].toLowerCase()) || /^[₹\d]/.test(words[0]))) words.shift();
  while (words.length && FILLER.has(words[words.length - 1].toLowerCase())) words.pop();
  const name = words.join(' ').replace(/[.,!?]+$/, '').trim();
  if (!name || name.length > 40 || !/^[a-z]/i.test(name) || NOT_A_PAYEE.test(name)) return undefined;
  return name;
}

function transferSlots(original: string): Extract<Intent, { kind: 'transfer' }> {
  const intent: Extract<Intent, { kind: 'transfer' }> = { kind: 'transfer' };
  let text = original.replace(/\s+/g, ' ').trim();

  const note = /\bfor\s+([^.!?]{1,60}?)\s*[.!?]*$/i.exec(text);
  if (note && !/^(me|us|him|her|them|you|now|today)$/i.test(note[1].trim())) {
    intent.note = note[1].trim();
    text = text.slice(0, note.index).trim();
  }

  const amount = /(?:₹|\brs\.?|\binr)?\s*(\d[\d,]*(?:\.\d{1,2})?)(\s*(?:k|thousand|hazaa?r|lakhs?|lacs?|crores?|cr)\b)?/i.exec(text);
  if (amount) intent.amount = `${amount[1].replace(/,$/, '')}${amount[2] ?? ''}`;

  const to = /\bto\s+(.{1,60}?)(?=\s+(?:for|from|on|today|tomorrow|now|please|pls|via|using|by|rs|inr)\b|\s*[₹\d]|\s*[.,!?]|\s*$)/i.exec(text);
  const ko = /(?:^|\s)((?:[a-z][\w.'-]*\s+){0,3}?[a-z][\w.'-]*)\s+ko\b/i.exec(text);
  const named = /\b(?:pay|send|transfer)\s+((?:[a-z][\w.'-]*\s+){0,2}?[a-z][\w.'-]*)\s+(?:₹|rs\.?\s*|inr\s*)?\d/i.exec(text);
  const payee = cleanPayee(to?.[1]) ?? cleanPayee(ko?.[1]) ?? cleanPayee(named?.[1]);
  if (payee) intent.payee = payee;

  // Return the slots in a stable key order
  const { amount: a, payee: p, note: n } = intent;
  return { kind: 'transfer', ...(a && { amount: a }), ...(p && { payee: p }), ...(n && { note: n }) };
}

export function routeIntent(text: string): Intent {
  const n = normalize(text);
  const query = text.replace(/\s+/g, ' ').trim();

  if (PROMPT_REVEAL.test(n)) return { kind: 'prompt_reveal' };
  if (GREETING_ONLY.test(n)) return { kind: 'greeting' };
  if (THANKS_ONLY.test(n)) return { kind: 'thanks' };
  if (WHO_CAN_I_PAY.test(n)) return { kind: 'payees' };
  if (LIMITS.test(n)) return { kind: 'limits' };

  const howTo = HOW_TO.test(n);
  const otherUser = OTHER_USER.test(n);
  if (SEND.test(n) && !howTo && !PAST_PAYMENT.test(n) && !SEND_ME.test(n)) return transferSlots(text);
  // "How can a customer freeze their account?" is a how-to question, not a request for someone's data
  if (otherUser && !howTo) return { kind: 'other_user' };

  if (howTo || ADD_PAYEE.test(n) || LOGIN_HISTORY.test(n) || TOPIC.test(n) || (ADD_MONEY.test(n) && !TOPUP_STATUS.test(n))) {
    // "how do I check my balance": if no article answers it, the data does (never for questions about others)
    const fallback = howTo && !otherUser ? dataIntent(n) : null;
    return fallback ? { kind: 'help', query, fallback } : { kind: 'help', query };
  }

  const data = dataIntent(n);
  if (data) return data;
  if (CAPABILITIES.test(n)) return { kind: 'capabilities' };
  if (SMALLTALK.test(n)) return { kind: 'smalltalk' };
  if (GREETING_PREFIX.test(n)) return { kind: 'greeting' };
  if (THANKS.test(n)) return { kind: 'thanks' };
  return { kind: 'unknown' };
}
