# coinbase

Coinbase Exchange public market data: crypto against USD.

## Access

`api`, no key. `GET https://api.exchange.coinbase.com/products/<BASE>-USD/stats` and `/ticker`
for quotes, `/candles?granularity=86400` (300 per call, paged) for history.

## Provides

- market: real-time quotes (15s cache); change is against 24h ago. Daily candles back to 2015; for
  1D, the last 24 hours in 5-minute candles.

## Limits

Public endpoints: ~10 requests/second per IP.

## Verified

2026-10-28: BTCUSD and ETHUSD quotes, 1Y and MAX bars.
