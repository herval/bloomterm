import { parseSecurity } from '@bloomterm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAlpacaNews } from '../src/alpaca/index.ts';
import { companyName, cvmFeed, parseRad } from '../src/cvm/index.ts';
import { integrations, newsProviders } from '../src/index.ts';
import { fromFeed, rssFeed } from '../src/rss/index.ts';
import { parseFeed } from '../src/rss/parse.ts';
import { plain } from '../src/text.ts';
import { fromSubmissions, secFeed } from '../src/sec-edgar/index.ts';

// Made-up feeds and filings in the sources' real shapes. No network.

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Exemplo</title>
  <item>
    <title><![CDATA[Petrobras eleva produção no 3º trimestre &amp; mira recorde]]></title>
    <link>https://news.example.com/mercados/petrobras-producao</link>
    <dc:creator><![CDATA[Reuters]]></dc:creator>
    <pubDate>Wed, 28 Oct 2026 21:42:08 +0000</pubDate>
    <guid isPermaLink="false">https://news.example.com/?p=1</guid>
    <description><![CDATA[<p><img src="x.jpg" />A estatal disse que a produção subiu&nbsp;4%.</p>]]></description>
  </item>
  <item>
    <title>Sem link</title>
  </item>
  <item>
    <title>Dólar fecha em queda</title>
    <link>https://news.example.com/cambio/dolar</link>
    <description>&lt;p&gt;O real ganhou força &amp;amp; o dólar caiu.&lt;/p&gt;</description>
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="html">Nvidia &lt;b&gt;beats&lt;/b&gt; estimates</title>
    <link rel="alternate" href="https://news.example.com/nvda"/>
    <id>tag:example.com,2026:1</id>
    <updated>2026-10-28T20:00:00Z</updated>
    <author><name>Jane Roe</name></author>
    <summary>Revenue rose.</summary>
  </entry>
</feed>`;

describe('the feed reader', () => {
  it('reads RSS items into plain text, and skips items without a link', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: 'https://news.example.com/?p=1',
      title: 'Petrobras eleva produção no 3º trimestre & mira recorde',
      link: 'https://news.example.com/mercados/petrobras-producao',
      published: '2026-10-28T21:42:08.000Z',
      author: 'Reuters',
      summary: 'A estatal disse que a produção subiu 4%.',
    });
    expect(items[1]).toMatchObject({ id: 'https://news.example.com/cambio/dolar', summary: 'O real ganhou força & o dólar caiu.', published: undefined });
  });

  it('reads Atom entries', () => {
    expect(parseFeed(ATOM)).toEqual([
      { id: 'tag:example.com,2026:1', title: 'Nvidia beats estimates', link: 'https://news.example.com/nvda', published: '2026-10-28T20:00:00.000Z', author: 'Jane Roe', summary: 'Revenue rose.' },
    ]);
  });

  it('drops scripts and decodes numeric entities', () => {
    expect(plain('<script>alert(1)</script>Caf&#233; &#x2014; ok')).toBe('Café — ok');
  });

  it('credits wire stories to the wire and the outlet', () => {
    const [first, second] = fromFeed({ outlet: 'Exemplo', url: 'https://news.example.com/feed', lang: 'pt' }, RSS);
    expect(first).toMatchObject({ outlet: 'Reuters via Exemplo', lang: 'pt', kind: 'news', headline: expect.stringContaining('Petrobras') });
    expect(second!.outlet).toBe('Exemplo');
  });
});

describe('news providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists every integration with a news feed', () => {
    expect(newsProviders(integrations, async () => null).map((p) => p.id)).toEqual(['alpaca', 'rss', 'cvm', 'sec-edgar']);
  });

  it('keeps the outlets that answered when one is down, and fails only when all are', async () => {
    const outlets = [
      { outlet: 'Up', url: 'https://up.example.com/feed', lang: 'en' as const },
      { outlet: 'Down', url: 'https://down.example.com/feed', lang: 'en' as const },
    ];
    vi.stubGlobal('fetch', async (url: string) => (url.includes('up.') ? new Response(ATOM) : new Response('nope', { status: 503 })));
    expect(await rssFeed(outlets).latest({ securities: [], since: null })).toHaveLength(1);
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));
    await expect(rssFeed(outlets).latest({ securities: [], since: null })).rejects.toThrow('no feed answered');
  });
});

describe('cvm', () => {
  const row = (protocol: string, company: string, subject: string, delivered: string) =>
    [
      '99999-9',
      company,
      'Fato Relevante',
      ' - ',
      `<spanOrder>${subject}</spanOrder> - `,
      '<spanOrder>20261028</spanOrder> 28/10/2026',
      `<spanOrder>20261028</spanOrder> ${delivered}`,
      'Ativo',
      '1',
      'AP',
      `<i onclick=OpenPopUpVer('frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=${protocol}')></i>`,
      subject,
      '',
    ].join('$&');

  it('reads RAD rows, in Brasília time, and tags known filers', () => {
    const items = parseRad([row('111', 'PETROLEO BRASILEIRO S.A. PETROBRAS', 'Produção do 3T26', '28/10/2026 17:57'), row('222', 'EMPRESA EXEMPLO DE TESTE S.A.', 'Aquisição', '28/10/2026 08:05')].join('&*'));
    expect(items).toEqual([
      {
        id: '111',
        headline: 'Petroleo Brasileiro S.A. Petrobras: Produção do 3T26',
        url: 'https://www.rad.cvm.gov.br/ENET/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=111',
        outlet: 'CVM · Fato Relevante',
        ts: '2026-10-28T20:57:00.000Z',
        lang: 'pt',
        kind: 'filing',
        tickers: ['PETR4 BZ Equity', 'PETR3 BZ Equity'],
      },
      expect.objectContaining({ id: '222', headline: 'Empresa Exemplo de Teste S.A.: Aquisição', tickers: undefined }),
    ]);
  });

  it('title-cases company names', () => {
    expect(companyName('BANCO DO BRASIL S.A.')).toBe('Banco do Brasil S.A.');
  });

  it('searches fatos relevantes since the last poll, as a POST read', async () => {
    let body: any;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ d: { temErro: false, dados: '' } });
    });
    const feed = cvmFeed(() => new Date('2026-10-28T15:00:00Z'));
    expect(await feed.latest({ securities: [], since: new Date('2026-10-28T12:00:00Z') })).toEqual([]);
    expect(body).toMatchObject({ dataDe: '28/10/2026', dataAte: '28/10/2026', categoria: 'IPE_4_-1_-1' });
  });
});

describe('sec-edgar', () => {
  const submissions = {
    cik: '0000320193',
    name: 'Example Corp',
    filings: {
      recent: {
        accessionNumber: ['0000000000-26-000003', '0000000000-26-000002', '0000000000-26-000001'],
        form: ['8-K', '4', '10-Q'],
        acceptanceDateTime: ['2026-10-28T20:30:00.000Z', '2026-10-27T20:30:00.000Z', '2026-09-01T20:30:00.000Z'],
        primaryDocument: ['ex-8k.htm', 'form4.xml', 'ex-10q.htm'],
        items: ['2.02,9.01', '', ''],
      },
    },
  };

  it('turns recent filings into headlines, skipping ownership forms and old ones', () => {
    expect(fromSubmissions(submissions, 'EXC US Equity', new Date('2026-10-01T00:00:00Z'))).toEqual([
      {
        id: '0000000000-26-000003',
        headline: 'Example Corp: 8-K results of operations',
        url: 'https://www.sec.gov/Archives/edgar/data/320193/000000000026000003/ex-8k.htm',
        outlet: 'SEC · 8-K',
        ts: '2026-10-28T20:30:00.000Z',
        lang: 'en',
        kind: 'filing',
        tickers: ['EXC US Equity'],
      },
    ]);
  });

  it('needs a contact email, and sends it in the User-Agent', async () => {
    const securities = [parseSecurity('EXC')!];
    await expect(secFeed(async () => null).latest({ securities, since: null })).rejects.toThrow('contact email in SET');
    const agents: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      agents.push((init.headers as Record<string, string>)['user-agent']!);
      return Response.json(url.includes('company_tickers') ? { 0: { cik_str: 320193, ticker: 'EXC' } } : submissions);
    });
    const items = await secFeed(async () => 'owner@example.com', () => new Date('2026-10-29T00:00:00Z')).latest({ securities, since: null });
    expect(items.map((i) => i.outlet)).toEqual(['SEC · 8-K']);
    expect(agents).toEqual(Array(2).fill('bloomterm/0.1 (personal market terminal; owner@example.com)'));
  });

  it('asks nothing when you follow no US companies', async () => {
    expect(await secFeed(async () => null).latest({ securities: [parseSecurity('PETR4')!], since: null })).toEqual([]);
  });
});

describe('alpaca news', () => {
  it('maps the wire with its own symbols', () => {
    expect(
      fromAlpacaNews({ id: 42, headline: 'Example rises', created_at: '2026-10-28T13:00:00Z', url: 'https://news.example.com/42', summary: '<p>Up&nbsp;</p>', symbols: ['AAPL', 'BTCUSD', 'PETR4'], source: 'benzinga' }),
    ).toEqual({
      id: '42',
      headline: 'Example rises',
      url: 'https://news.example.com/42',
      outlet: 'Benzinga',
      ts: '2026-10-28T13:00:00.000Z',
      summary: 'Up',
      lang: 'en',
      kind: 'news',
      tickers: ['AAPL US Equity', 'BTCUSD Crypto'],
    });
    expect(fromAlpacaNews({ id: 1, headline: 'x', created_at: '2026-10-28T13:00:00Z' })).toBeNull();
  });
});
