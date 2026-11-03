import { companyFor } from '@bloomterm/core';
import { getJson, ProviderError } from '../http.ts';
import { defineIntegration, type NewsData, type NewsFeed } from '../sdk.ts';

// CVM's RAD (Rede de Divulgação), where Brazilian listed companies file. This reads "Fato
// Relevante" filings: material facts, which move prices. The search is a POST with a JSON
// body, a read (a search form), like the site's own page makes.

const SEARCH = 'https://www.rad.cvm.gov.br/ENET/frmConsultaExternaCVM.aspx/ListarDocumentos';
const VIEW = 'https://www.rad.cvm.gov.br/ENET/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=';
/** IPE category 4: Fato Relevante. */
const FATO_RELEVANTE = 'IPE_4_-1_-1';

const ddmmyyyy = (d: Date) => {
  // Dates are Brasília's (UTC−3, no daylight saving since 2019).
  const b = new Date(d.getTime() - 3 * 3_600_000);
  return `${String(b.getUTCDate()).padStart(2, '0')}/${String(b.getUTCMonth() + 1).padStart(2, '0')}/${b.getUTCFullYear()}`;
};

const strip = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const SMALL = new Set(['de', 'do', 'da', 'dos', 'das', 'e']);
/** "RAIZEN S.A." → "Raizen S.A." */
export function companyName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (/^(s\.?a\.?|s\/a|ltda\.?)$/i.test(w)) return w.toUpperCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** One row of RAD's answer: fields split by `$&`, rows by `&*`. */
export function parseRad(dados: string): NewsData[] {
  const out: NewsData[] = [];
  for (const row of dados.split('&*')) {
    const f = row.split('$&');
    if (f.length < 12) continue;
    const protocol = /NumeroProtocoloEntrega=(\d+)/.exec(f[10] ?? '')?.[1];
    const subject = strip(f[11] || f[4] || '').replace(/\s+-\s*$/, '');
    const when = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(strip(f[6] ?? ''));
    if (!protocol || !f[1]) continue;
    const company = companyName(f[1]);
    const known = companyFor(f[1]);
    out.push({
      id: protocol,
      headline: subject ? `${company}: ${subject}` : `${company}: Fato Relevante`,
      url: `${VIEW}${protocol}`,
      outlet: `CVM · ${strip(f[2] ?? '') || 'Fato Relevante'}`,
      ts: when ? new Date(`${when[3]}-${when[2]}-${when[1]}T${when[4]}:${when[5]}:00-03:00`).toISOString() : undefined,
      lang: 'pt',
      kind: 'filing',
      tickers: known?.keys.filter((k) => k.endsWith(' BZ Equity')),
    });
  }
  return out;
}

export function cvmFeed(now: () => Date = () => new Date()): NewsFeed {
  return {
    everyMs: 15 * 60_000,
    async latest({ since }) {
      const to = now();
      // From the last poll (a day back at most), so a weekend or a sleeping Mac doesn't lose filings.
      const from = new Date(Math.max(since?.getTime() ?? 0, to.getTime() - 3 * 86_400_000) - 3_600_000);
      const body = {
        dataDe: ddmmyyyy(from),
        dataAte: ddmmyyyy(to),
        empresa: '',
        setorAtividade: '-1',
        categoriaEmissor: '-1',
        situacaoEmissor: '-1',
        tipoParticipante: '1',
        dataReferencia: '',
        categoria: FATO_RELEVANTE,
        periodo: '2',
        horaIni: '',
        horaFim: '',
        palavraChave: '',
        ultimaDtRef: 'false',
        tipoEmpresa: '0',
        token: '',
        versaoCaptcha: '',
      };
      const res = await getJson<{ d?: { temErro?: boolean; msgErro?: string; dados?: string } }>('cvm', SEARCH, { 'content-type': 'application/json; charset=utf-8' }, 20_000, { method: 'POST', body: JSON.stringify(body) });
      if (res.d?.temErro) throw new ProviderError('cvm', `cvm: ${res.d.msgErro || 'the search failed'}`);
      return parseRad(res.d?.dados ?? '');
    },
  };
}

export default defineIntegration({
  id: 'cvm',
  name: 'CVM filings',
  covers: 'Fatos relevantes (material facts) from Brazilian listed companies, as filed with CVM',
  access: 'api',
  status: 'ready',
  docs: 'https://www.rad.cvm.gov.br/ENET/frmConsultaExternaCVM.aspx',
  news: () => cvmFeed(),
});
