import type { Security } from '@bloomterm/core';
import { getJson, ProviderError, USER_AGENT } from '../http.ts';
import { defineIntegration, type NewsData, type NewsFeed, type SecretLookup } from '../sdk.ts';

// SEC EDGAR filings for the US companies you hold and watch: 8-Ks (material events), 10-Qs,
// 10-Ks and the like, from data.sec.gov. EDGAR asks every program to say who runs it in its
// User-Agent, so this one needs a contact email (SET). It stays well under EDGAR's
// 10 requests a second.

const TICKERS = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const MAX_COMPANIES = 40;

/** The forms worth a headline. Ownership forms (3/4/5, 144) are left out: too many, too small. */
const FORMS: Record<string, string> = {
  '8-K': 'Current report',
  '10-Q': 'Quarterly report',
  '10-K': 'Annual report',
  '6-K': 'Foreign issuer report',
  '20-F': 'Annual report (foreign issuer)',
  'DEF 14A': 'Proxy statement',
  'S-1': 'Registration statement',
  'SC 13D': 'Activist stake (13D)',
  'SC 13G': 'Large stake (13G)',
};

const ITEMS: Record<string, string> = {
  '1.01': 'material agreement',
  '1.02': 'agreement ended',
  '2.01': 'acquisition or sale completed',
  '2.02': 'results of operations',
  '2.03': 'new debt',
  '2.05': 'restructuring costs',
  '2.06': 'impairment',
  '3.01': 'delisting notice',
  '4.01': 'auditor change',
  '4.02': 'restatement',
  '5.02': 'officer or director change',
  '5.07': 'shareholder vote',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'other events',
};

interface Submissions {
  cik: string;
  name: string;
  tickers?: string[];
  filings: { recent: { accessionNumber: string[]; form: string[]; acceptanceDateTime: string[]; primaryDocument: string[]; items: string[] } };
}

/** Recent filings of one company, newest first, as news. */
export function fromSubmissions(s: Submissions, key: string, since: Date): NewsData[] {
  const r = s.filings.recent;
  const cik = String(Number(s.cik));
  const out: NewsData[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i]!;
    const label = FORMS[form];
    const ts = r.acceptanceDateTime[i];
    if (!label || !ts || Date.parse(ts) < since.getTime()) continue;
    const items = (r.items[i] ?? '')
      .split(',')
      .map((x) => ITEMS[x.trim()])
      .filter(Boolean);
    const acc = r.accessionNumber[i]!;
    out.push({
      id: acc,
      headline: `${s.name}: ${form} ${items.length ? items.join(', ') : label.toLowerCase()}`,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`,
      outlet: `SEC · ${form}`,
      ts: new Date(ts).toISOString(),
      lang: 'en',
      kind: 'filing',
      tickers: [key],
    });
  }
  return out;
}

export function secFeed(secret: SecretLookup, now: () => Date = () => new Date()): NewsFeed {
  let ciks: { at: number; map: Map<string, string> } | null = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    everyMs: 30 * 60_000,
    async latest({ securities, since }) {
      const us = securities.filter((s: Security) => s.sector === 'Equity' && s.market === 'US').slice(0, MAX_COMPANIES);
      if (!us.length) return [];
      const contact = (await secret('sec-contact'))?.trim();
      if (!contact) throw new ProviderError('sec-edgar', 'SEC filings need a contact email in SET: EDGAR asks every program to say who runs it');
      const headers = { 'user-agent': `${USER_AGENT.slice(0, -1)}; ${contact})` };
      if (!ciks || Date.now() - ciks.at > 86_400_000) {
        const all = await getJson<Record<string, { cik_str: number; ticker: string }>>('sec-edgar', TICKERS, headers, 20_000);
        ciks = { at: Date.now(), map: new Map(Object.values(all).map((c) => [c.ticker.toUpperCase(), String(c.cik_str).padStart(10, '0')])) };
      }
      const from = new Date(Math.max(since?.getTime() ?? 0, now().getTime() - 7 * 86_400_000) - 3_600_000);
      const out: NewsData[] = [];
      for (const sec of us) {
        const cik = ciks.map.get(sec.ticker.replace('.', '-'));
        if (!cik) continue;
        out.push(...fromSubmissions(await getJson<Submissions>('sec-edgar', SUBMISSIONS(cik), headers, 15_000), sec.key, from));
        await sleep(200);
      }
      return out;
    },
  };
}

export default defineIntegration({
  id: 'sec-edgar',
  name: 'SEC EDGAR filings',
  covers: '8-K, 10-Q, 10-K and other filings from the US companies you hold and watch',
  access: 'api',
  status: 'ready',
  docs: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces',
  secrets: [{ name: 'sec-contact', label: 'Contact email for SEC EDGAR', covers: 'US company filings (EDGAR asks each program for a contact)', signup: 'https://www.sec.gov/os/accessing-edgar-data' }],
  news: ({ secret }) => secFeed(secret),
});
