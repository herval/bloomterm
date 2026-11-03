# bcb

Banco Central do Brasil, PTAX: the official daily USDBRL fixing.

## Access

`api`, no key. Olinda OData service:
`https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(...)`.
Times are Brasília (UTC−3).

## Provides

- market: USDBRL. A fixing, not a live rate: one value per business day, published around
  13:00 BRT, so the UI treats it as current for up to 72h. Bars draw as a line. No intraday bars, so
  no 1D chart.

## Limits

- USDBRL only, and only the PTAX fixing: none on weekends or Brazilian holidays.
- Today's value appears after the BCB publishes it, around 13:00 BRT.

## Verified

2026-10-28: the last fixings match what the BCB site shows.
