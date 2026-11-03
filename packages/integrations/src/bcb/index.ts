import type { Bar, Range, Security } from '@bloomterm/core';
import { getJson, ProviderError } from '../http.ts';
import { defineIntegration, type MarketFeed, type QuoteData } from '../sdk.ts';

// Banco Central do Brasil PTAX (SPEC §7.3, §7.6): the official daily USDBRL fixing.
// It's a fixing, not a live rate: one value per business day, published around 13:00 BRT.

const BASE = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata';

interface Row {
  cotacaoVenda: number;
  dataHoraCotacao: string; // "2026-10-27 13:05:26.521898", Brasília time
}

/** OData wants MM-DD-YYYY. */
const bcbDate = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
/** Brazil has had no DST since 2019, so Brasília is always UTC−3. */
const toIso = (s: string) => new Date(`${s.replace(' ', 'T').slice(0, 19)}-03:00`).toISOString();

function feed(): MarketFeed {
  async function period(from: Date, to: Date): Promise<Row[]> {
    const q =
      `CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)` +
      `?@dataInicial='${bcbDate(from)}'&@dataFinalCotacao='${bcbDate(to)}'&$format=json&$select=cotacaoVenda,dataHoraCotacao`;
    const res = await getJson<{ value: Row[] }>('bcb', `${BASE}/${q}`, {}, 20_000);
    return [...res.value].sort((a, b) => a.dataHoraCotacao.localeCompare(b.dataHoraCotacao));
  }

  return {
    quoteTtlMs: 30 * 60_000,
    supports: (sec) => sec.sector === 'Curncy' && sec.ticker === 'USDBRL',

    async quote(): Promise<QuoteData> {
      const now = new Date();
      const rows = await period(new Date(now.getTime() - 14 * 86_400_000), now);
      const last = rows.at(-1);
      const prev = rows.at(-2);
      if (!last) throw new ProviderError('bcb', 'no PTAX fixing in the last two weeks');
      return {
        symbol: 'USDBRL PTAX',
        name: 'USD/BRL PTAX (BCB fixing)',
        currency: 'BRL',
        last: last.cotacaoVenda,
        prevClose: prev?.cotacaoVenda,
        change: prev ? last.cotacaoVenda - prev.cotacaoVenda : undefined,
        changePct: prev ? ((last.cotacaoVenda - prev.cotacaoVenda) / prev.cotacaoVenda) * 100 : undefined,
        changeBasis: 'prev_fixing',
        asOf: toIso(last.dataHoraCotacao),
      };
    },

    async bars(_sec: Security, _range: Range, from: Date) {
      const rows = await period(from, new Date());
      const bars: Bar[] = rows.map((r) => {
        const day = Math.floor(Date.parse(`${r.dataHoraCotacao.slice(0, 10)}T00:00:00Z`) / 1000);
        return { t: day, o: r.cotacaoVenda, h: r.cotacaoVenda, l: r.cotacaoVenda, c: r.cotacaoVenda };
      });
      return { bars, currency: 'BRL' };
    },
  };
}

export default defineIntegration({
  id: 'bcb',
  name: 'Banco Central do Brasil (PTAX)',
  covers: 'USDBRL: the official daily PTAX fixing, no key',
  access: 'api',
  status: 'ready',
  docs: 'https://dadosabertos.bcb.gov.br/dataset/dolar-americano-usd-todos-os-boletins-diarios',
  market: () => feed(),
});
