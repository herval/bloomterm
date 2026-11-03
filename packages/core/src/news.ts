// News (SPEC §10.4): the shapes bloomd stores and the UI shows, plus the rule-based half of
// news intelligence: tagging items with the securities they mention, and telling when two
// headlines tell the same story. The agent refines both later; these run on every item.
// Browser-safe.

export type NewsKind = 'news' | 'filing';
/** Who tagged an item with a security: the source itself, the rules here, or the agent. */
export type TagOrigin = 'source' | 'rule' | 'agent';

export interface NewsItem {
  /** `<integration>:<the source's own id>` */
  id: string;
  /** The integration that fetched it. */
  source: string;
  /** When it was published (ISO); when the source doesn't say, when bloomd first saw it. */
  ts: string;
  headline: string;
  /** Who published it, e.g. "Valor", "Reuters via InfoMoney", "CVM · Fato Relevante". */
  outlet: string;
  url: string;
  kind: NewsKind;
  lang: string | null;
  summary: string | null;
  storyId: string | null;
  tags: { security: string; by: TagOrigin }[];
}

/** The same story from one or more outlets. */
export interface NewsStory {
  id: string;
  title: string;
  summary: string | null;
  /** `rule`: grouped by headline similarity; `agent`: titled and grouped by the agent. */
  by: 'rule' | 'agent';
  firstTs: string;
  lastTs: string;
  outlets: string[];
  tags: string[];
  items: NewsItem[];
}

/** Companies the rules recognize by name. A mention maps to all of a company's share classes. */
export interface Company {
  name: string;
  keys: string[];
  /** Plain names, matched whole-word and case-insensitively, without accents. */
  names: string[];
  /** Names that are also ordinary words, matched case-sensitively ("Vale", "Meta"). */
  exact?: string[];
}

const bz = (...t: string[]) => t.map((x) => `${x} BZ Equity`);
const us = (...t: string[]) => t.map((x) => `${x} US Equity`);

export const COMPANIES: Company[] = [
  { name: 'Petrobras', keys: [...bz('PETR4', 'PETR3'), ...us('PBR')], names: ['petrobras', 'petroleo brasileiro'] },
  { name: 'Vale', keys: [...bz('VALE3'), ...us('VALE')], names: [], exact: ['Vale S.A.', 'Vale'] },
  { name: 'Itaú Unibanco', keys: [...bz('ITUB4', 'ITUB3'), ...us('ITUB')], names: ['itau unibanco', 'itau'] },
  { name: 'Bradesco', keys: bz('BBDC4', 'BBDC3'), names: ['bradesco'] },
  { name: 'Banco do Brasil', keys: bz('BBAS3'), names: ['banco do brasil'] },
  { name: 'Ambev', keys: bz('ABEV3'), names: ['ambev'] },
  { name: 'WEG', keys: bz('WEGE3'), names: [], exact: ['WEG'] },
  { name: 'Suzano', keys: bz('SUZB3'), names: ['suzano'] },
  { name: 'Gerdau', keys: bz('GGBR4', 'GOAU4'), names: ['gerdau'] },
  { name: 'Localiza', keys: bz('RENT3'), names: ['localiza'] },
  { name: 'Eletrobras', keys: bz('ELET3', 'ELET6'), names: ['eletrobras'] },
  { name: 'Santander Brasil', keys: bz('SANB11'), names: ['santander brasil'] },
  { name: 'BTG Pactual', keys: bz('BPAC11'), names: ['btg pactual', 'btg'] },
  { name: "Rede D'Or", keys: bz('RDOR3'), names: ["rede d'or", 'rede dor'] },
  { name: 'Rumo', keys: bz('RAIL3'), names: [], exact: ['Rumo'] },
  { name: 'Embraer', keys: [...bz('EMBR3'), ...us('ERJ')], names: ['embraer'] },
  { name: 'Natura', keys: bz('NATU3'), names: ['natura'] },
  { name: 'Magazine Luiza', keys: bz('MGLU3'), names: ['magazine luiza', 'magalu'] },
  { name: 'Raízen', keys: bz('RAIZ4'), names: ['raizen'] },
  { name: 'Cosan', keys: bz('CSAN3'), names: ['cosan'] },
  { name: 'Usiminas', keys: bz('USIM5'), names: ['usiminas'] },
  { name: 'CSN', keys: bz('CSNA3'), names: ['companhia siderurgica nacional'], exact: ['CSN'] },
  { name: 'Sabesp', keys: bz('SBSP3'), names: ['sabesp'] },
  { name: 'Equatorial', keys: bz('EQTL3'), names: ['equatorial energia'] },
  { name: 'Hapvida', keys: bz('HAPV3'), names: ['hapvida'] },
  { name: 'PRIO', keys: bz('PRIO3'), names: ['petrorio'], exact: ['PRIO'] },
  { name: 'TIM Brasil', keys: bz('TIMS3'), names: ['tim brasil'] },
  { name: 'Telefônica Brasil', keys: bz('VIVT3'), names: ['telefonica brasil'] },
  { name: 'Cemig', keys: bz('CMIG4'), names: ['cemig'] },
  { name: 'Klabin', keys: bz('KLBN11'), names: ['klabin'] },
  { name: 'Assaí', keys: bz('ASAI3'), names: ['assai atacadista'] },
  { name: 'Lojas Renner', keys: bz('LREN3'), names: ['lojas renner', 'renner'] },
  { name: 'Totvs', keys: bz('TOTS3'), names: ['totvs'] },
  { name: 'Brava Energia', keys: bz('BRAV3'), names: ['brava energia'] },
  { name: 'XP Inc.', keys: us('XP'), names: ['xp inc'] },
  { name: 'Nubank', keys: us('NU'), names: ['nubank', 'nu holdings'] },
  { name: 'StoneCo', keys: us('STNE'), names: ['stoneco'] },
  { name: 'PagSeguro', keys: us('PAGS'), names: ['pagseguro', 'pagbank'] },
  { name: 'MercadoLibre', keys: us('MELI'), names: ['mercadolibre', 'mercado livre'] },
  { name: 'Apple', keys: us('AAPL'), names: [], exact: ['Apple'] },
  { name: 'Microsoft', keys: us('MSFT'), names: ['microsoft'] },
  { name: 'Nvidia', keys: us('NVDA'), names: ['nvidia'] },
  { name: 'Alphabet', keys: us('GOOGL', 'GOOG'), names: ['alphabet', 'google'] },
  { name: 'Amazon', keys: us('AMZN'), names: ['amazon'] },
  { name: 'Meta Platforms', keys: us('META'), names: ['meta platforms', 'facebook'], exact: ['Meta'] },
  { name: 'Tesla', keys: us('TSLA'), names: ['tesla'] },
  { name: 'Berkshire Hathaway', keys: us('BRK.B'), names: ['berkshire hathaway', 'berkshire'] },
  { name: 'JPMorgan Chase', keys: us('JPM'), names: ['jpmorgan', 'jp morgan'] },
  { name: 'Visa', keys: us('V'), names: [], exact: ['Visa Inc', 'Visa'] },
  { name: 'Mastercard', keys: us('MA'), names: ['mastercard'] },
  { name: 'Netflix', keys: us('NFLX'), names: ['netflix'] },
  { name: 'Oracle', keys: us('ORCL'), names: [], exact: ['Oracle'] },
  { name: 'Broadcom', keys: us('AVGO'), names: ['broadcom'] },
  { name: 'AMD', keys: us('AMD'), names: ['advanced micro devices'], exact: ['AMD'] },
  { name: 'Intel', keys: us('INTC'), names: [], exact: ['Intel'] },
  { name: 'Salesforce', keys: us('CRM'), names: ['salesforce'] },
  { name: 'Walmart', keys: us('WMT'), names: ['walmart'] },
  { name: 'Exxon Mobil', keys: us('XOM'), names: ['exxon', 'exxonmobil'] },
  { name: 'Chevron', keys: us('CVX'), names: ['chevron'] },
  { name: 'Coca-Cola', keys: us('KO'), names: ['coca-cola', 'coca cola'] },
  { name: 'Boeing', keys: us('BA'), names: ['boeing'] },
  { name: 'Palantir', keys: us('PLTR'), names: ['palantir'] },
  { name: 'Uber', keys: us('UBER'), names: [], exact: ['Uber'] },
  { name: 'Disney', keys: us('DIS'), names: ['walt disney', 'disney'] },
  { name: 'Goldman Sachs', keys: us('GS'), names: ['goldman sachs', 'goldman'] },
  { name: 'Morgan Stanley', keys: us('MS'), names: ['morgan stanley'] },
  { name: 'Bank of America', keys: us('BAC'), names: ['bank of america'] },
  { name: 'Eli Lilly', keys: us('LLY'), names: ['eli lilly'] },
  { name: 'UnitedHealth', keys: us('UNH'), names: ['unitedhealth'] },
  { name: 'Costco', keys: us('COST'), names: ['costco'] },
  { name: 'Qualcomm', keys: us('QCOM'), names: ['qualcomm'] },
  { name: 'Micron', keys: us('MU'), names: ['micron technology', 'micron'] },
  { name: 'TSMC', keys: us('TSM'), names: ['taiwan semiconductor'], exact: ['TSMC'] },
  { name: 'Bitcoin', keys: ['BTCUSD Crypto'], names: ['bitcoin'] },
  { name: 'Ether', keys: ['ETHUSD Crypto'], names: ['ethereum'] },
  { name: 'Ibovespa', keys: ['IBOV Index'], names: ['ibovespa'] },
];

/** Lowercase, without accents: how names and headlines are compared. */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Vale a pena", "Meta de inflação": ordinary words that happen to be names.
const NOT_A_NAME = '(?! (?:a|o|as|os|de|do|da|dos|das|em|para|mais|menos|tudo|lembrar|ressaltar|destacar|fiscal|de inflacao)\\b)';

interface Matcher {
  keys: string[];
  folded?: RegExp;
  exact?: RegExp;
}

function matchers(companies: Company[]): Matcher[] {
  return companies.map((c) => ({
    keys: c.keys,
    folded: c.names.length ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${c.names.map((n) => escape(fold(n))).join('|')})(?![\\p{L}\\p{N}])`, 'u') : undefined,
    exact: c.exact?.length ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${c.exact.map(escape).join('|')})(?![\\p{L}\\p{N}])${NOT_A_NAME}`, 'u') : undefined,
  }));
}

const DEFAULT_MATCHERS = matchers(COMPANIES);
const B3_IN_TEXT = /\b([A-Z]{4}(?:3|4|5|6|11))\b/g;
const US_LISTING = /\((?:NASDAQ|Nasdaq|NYSE|NYSE American|AMEX)\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\)/g;
const CASHTAG = /(?:^|\s)\$([A-Z]{1,5})\b/g;

/**
 * The securities a text mentions: tickers written out (PETR4, "(NYSE: PBR)", $AAPL) and,
 * unless `names` is off, company names. `extra` adds names you hold or watch that the built-in
 * list lacks. Names in a teaser are often passing mentions, so callers match them in headlines only.
 */
export function tagText(text: string, extra: Company[] = [], o: { names?: boolean } = {}): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(B3_IN_TEXT)) out.add(`${m[1]} BZ Equity`);
  for (const m of text.matchAll(US_LISTING)) out.add(`${m[1]} US Equity`);
  for (const m of text.matchAll(CASHTAG)) out.add(`${m[1]} US Equity`);
  if (o.names === false) return [...out];
  const folded = fold(text);
  for (const m of [...DEFAULT_MATCHERS, ...(extra.length ? matchers(extra) : [])]) {
    if (m.folded?.test(folded) || m.exact?.test(text)) for (const k of m.keys) out.add(k);
  }
  return [...out];
}

/** The company a filer's registered name belongs to ("PETROLEO BRASILEIRO S.A. PETROBRAS" → Petrobras). */
export function companyFor(name: string): Company | undefined {
  const f = ` ${fold(name).replace(/[^a-z0-9' ]+/g, ' ')} `;
  return COMPANIES.find((c) => [...c.names, ...(c.exact ?? []).map(fold)].some((n) => f.includes(` ${n.replace(/[^a-z0-9' ]+/g, ' ')} `)));
}

const STOP = new Set(
  (
    'the a an of to in on for and or as at by with from is are was were be its it this that after before over amid into new says said ' +
    'o a os as de do da dos das e em no na nos nas para por com que se um uma ao aos sobre apos ate mais diz entre como sua seu'
  ).split(' '),
);

/** The words that carry a headline's meaning, for comparing two headlines. */
export function headlineWords(headline: string): Set<string> {
  return new Set(
    fold(headline)
      .replace(/[^a-z0-9%$ ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

/** Jaccard similarity of two headlines' words: 1 is the same words, 0 nothing in common. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}
