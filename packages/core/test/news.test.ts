import { describe, expect, it } from 'vitest';
import { companyFor, headlineWords, similarity, tagText, watchedKeys } from '../src/index.ts';

describe('tagging news with securities', () => {
  it('finds tickers written out, listings and cashtags', () => {
    expect(tagText('PETR4 sobe; ITUB4 cai')).toEqual(expect.arrayContaining(['PETR4 BZ Equity', 'ITUB4 BZ Equity']));
    expect(tagText('Example Corp (NASDAQ: EXMP) beats')).toContain('EXMP US Equity');
    expect(tagText('watching $NVDA today')).toContain('NVDA US Equity');
  });

  it('maps a company name to all its share classes, without accents or case', () => {
    expect(tagText('Lucro do Itaú supera estimativas')).toEqual(expect.arrayContaining(['ITUB4 BZ Equity', 'ITUB3 BZ Equity']));
    expect(tagText('PETROBRAS anuncia dividendos')).toEqual(expect.arrayContaining(['PETR4 BZ Equity', 'PETR3 BZ Equity', 'PBR US Equity']));
  });

  it("doesn't take ordinary words for names", () => {
    expect(tagText('Vale a pena investir em renda fixa?')).toEqual([]);
    expect(tagText('Meta de inflação é mantida')).toEqual([]);
    expect(tagText('Vale despenca com minério')).toContain('VALE3 BZ Equity');
    expect(tagText('apple pie recipe')).toEqual([]);
  });

  it('adds names you follow that the built-in list lacks', () => {
    expect(tagText('Example Widgets raises guidance', [{ name: 'Example Widgets', keys: ['EXW US Equity'], names: ['example widgets'] }])).toEqual(['EXW US Equity']);
  });

  it('knows filers by their registered names', () => {
    expect(companyFor('PETROLEO BRASILEIRO S.A. PETROBRAS')?.name).toBe('Petrobras');
    expect(companyFor('BANCO DO BRASIL S.A.')?.name).toBe('Banco do Brasil');
    expect(companyFor('EMPRESA EXEMPLO S.A.')).toBeUndefined();
  });
});

describe('telling the same story apart', () => {
  it('scores the same event from two outlets above unrelated news', () => {
    const a = headlineWords('Petrobras raises Q3 oil production to record');
    const b = headlineWords("Petrobras' Q3 oil production hits a record");
    const c = headlineWords('Fed holds rates steady as inflation cools');
    expect(similarity(a, b)).toBeGreaterThan(0.4);
    expect(similarity(a, c)).toBe(0);
  });
});

describe('watchlists', () => {
  it('lists every watched key once, with the defaults when there are none', () => {
    expect(watchedKeys({ current: 'A', lists: { A: ['X US Equity', 'Y US Equity'], B: ['X US Equity'] } })).toEqual(['X US Equity', 'Y US Equity']);
    expect(watchedKeys(null)).toContain('PETR4 BZ Equity');
  });
});
