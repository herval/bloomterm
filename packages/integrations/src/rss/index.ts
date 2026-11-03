import { getText, ProviderError } from '../http.ts';
import { defineIntegration, type NewsData, type NewsFeed } from '../sdk.ts';
import { parseFeed } from './parse.ts';

// Open news feeds (SPEC §7.7: no paid news). Each outlet's public RSS, read every 10
// minutes. Headlines and summaries are untrusted text: bloomd stores and shows them as data.

export interface Outlet {
  outlet: string;
  url: string;
  lang: 'pt' | 'en';
}

export const OUTLETS: Outlet[] = [
  { outlet: 'Valor', url: 'https://pox.globo.com/rss/valor/', lang: 'pt' },
  { outlet: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', lang: 'pt' },
  { outlet: 'Brazil Journal', url: 'https://braziljournal.com/feed/', lang: 'pt' },
  { outlet: 'Exame', url: 'https://exame.com/feed/', lang: 'pt' },
  { outlet: 'Money Times', url: 'https://www.moneytimes.com.br/feed/', lang: 'pt' },
  { outlet: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', lang: 'en' },
  { outlet: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', lang: 'en' },
];

/** Wires whose stories outlets republish: "Reuters via InfoMoney". */
const WIRES = /^(Reuters|Bloomberg|Associated Press|AP|AFP|Estadão Conteúdo|Agência Brasil|Dow Jones)$/i;

export function fromFeed(o: Outlet, xml: string): NewsData[] {
  return parseFeed(xml).map((e) => ({
    id: e.id,
    headline: e.title,
    url: e.link,
    outlet: e.author && WIRES.test(e.author) ? `${e.author} via ${o.outlet}` : o.outlet,
    ts: e.published,
    summary: e.summary,
    lang: o.lang,
    kind: 'news' as const,
  }));
}

export function rssFeed(outlets: Outlet[] = OUTLETS): NewsFeed {
  return {
    everyMs: 10 * 60_000,
    async latest() {
      const results = await Promise.allSettled(outlets.map(async (o) => fromFeed(o, await getText('rss', o.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, 15_000))));
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${outlets[i]!.outlet}: ${(r.reason as Error).message}`] : []));
      if (failed.length === outlets.length) throw new ProviderError('rss', `no feed answered (${failed.join('; ')})`);
      // One outlet down doesn't hold up the rest; it's retried on the next poll.
      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    },
  };
}

export default defineIntegration({
  id: 'rss',
  name: 'News feeds',
  covers: 'Headlines from Valor, InfoMoney, Brazil Journal, Exame, Money Times, CNBC and MarketWatch',
  access: 'api',
  status: 'ready',
  docs: 'https://www.rssboard.org/rss-specification',
  news: () => rssFeed(),
});
