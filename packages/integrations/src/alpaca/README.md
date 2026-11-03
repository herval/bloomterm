# alpaca

Alpaca market data: US stocks and ETFs.

## Access

`api`. `GET https://data.alpaca.markets/v2/stocks/<T>/snapshot?feed=iex` for quotes,
`/v2/stocks/<T>/bars?timeframe=1Day&feed=sip` for history. Headers `APCA-API-KEY-ID` and
`APCA-API-SECRET-KEY`, from the `alpaca-key-id` and `alpaca-secret` keys (SET; free account at
alpaca.markets).

## Provides

- market: real-time IEX quotes (15s cache); SIP daily bars, which are free once 15 minutes old;
  and for 1D, the latest session's 5-minute SIP bars, pre- and after-market included, 16 minutes behind.
  IEX volume is a slice of the market's, so quotes leave volume out.
- news: `GET /v1beta1/news` for the US tickers you hold and watch (the whole wire when there
  are none), every 5 minutes. It's Benzinga's wire, tagged with Alpaca's own symbols.

## Limits

200 requests/minute on the free plan.

## Verified

Not yet: written from Alpaca's docs; needs keys in SET.
