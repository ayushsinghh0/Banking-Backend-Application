import { Audience, HelpArticle } from './articles';

/**
 * Deterministic retrieval: keyword scoring with a light stemmer. Same question, same article, every time, for
 * both the built-in assistant and the model's search_help tool. Staff procedures are never returned to customers.
 */
export interface HelpMatch {
  article: HelpArticle;
  score: number;
}

/** A match at least this strong answers the question on its own (one keyword hit) */
export const CONFIDENT_SCORE = 3;

const STOPWORDS = new Set(
  (
    'a an the i im me my mine we our you your it its this that these those is are was were be been am do does did ' +
    'to of for in on at by with from and or but if so as can could would should will shall may might please pls ' +
    'how what when where which who why whats hows tell show give about want need know get got there here any some ' +
    'kaise kaisa kya hai hain ho ka ki ke ko mera meri mere mujhe karo kare karna kar batao bata se me mein aur ' +
    'hello hi hey sphere'
  ).split(' ')
);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9₹\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plurals and common verb endings ("payees", "beneficiaries", "refunded", "transferring" -> "transferr") */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokens(text: string): string[] {
  return normalizeText(text)
    .split(/[\s-]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

/** Staff see their procedures and the general help (to guide customers); customers never see staff procedures */
function audienceAllows(article: HelpArticle, audience: Exclude<Audience, 'all'>): boolean {
  return audience === 'staff' || article.audience !== 'staff';
}

function score(article: HelpArticle, query: string, queryTokens: Set<string>): number {
  let total = 0;
  const padded = ` ${query.replace(/-/g, ' ')} `;
  // "top-up" and "top up" are one keyword
  for (const normalized of new Set(article.keywords.map((k) => normalizeText(k).replace(/-/g, ' ')))) {
    if (normalized.includes(' ')) {
      if (padded.includes(` ${normalized} `)) total += 4;
    } else if (queryTokens.has(stem(normalized))) {
      total += 3;
    }
  }
  for (const word of new Set(tokens(article.title))) if (queryTokens.has(word)) total += 2;
  let stepHits = 0;
  for (const word of new Set(article.steps.flatMap((s) => tokens(s)))) if (queryTokens.has(word)) stepHits += 0.5;
  return total + Math.min(stepHits, 2);
}

export function searchHelp(
  articles: readonly HelpArticle[],
  query: string,
  audience: Exclude<Audience, 'all'>,
  limit = 3
): HelpMatch[] {
  const normalized = normalizeText(query);
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size && !normalized) return [];
  return articles
    .map((article, index) => ({ article, index, score: audienceAllows(article, audience) ? score(article, normalized, queryTokens) : 0 }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ article, score: s }) => ({ article, score: s }));
}
