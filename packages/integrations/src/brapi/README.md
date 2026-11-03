# brapi

brapi.dev: B3 stocks, FIIs, ETFs, BDRs, and IBOV (`^BVSP`).

## Access

`api`. `GET https://brapi.dev/api/quote/<T>[?range=1y&interval=1d]`, with
`Authorization: Bearer <brapi>` when the `brapi` key is set (SET; free at brapi.dev).

## Provides

- market: quotes (~30 min delay, 5 min cache) and daily bars from the same call; and for 1D, the
  latest session's 5-minute bars (`?range=5d&interval=5m`; `range=1d` can come back empty).

## Limits

- Without a token: only PETR4, VALE3, ITUB4 and MGLU3, **one request in flight** (more get 429),
  so requests are queued and a 429 is retried once after 1.5s.
- Free token: 15k requests/month, one ticker per call, 3 months of history.

## Verified

2026-10-28: PETR4, VALE3, ITUB4 quotes and 1Y bars, no token.
2026-11-03: PETR4 5-minute bars, no token: the two latest finished sessions, not today's yet.
