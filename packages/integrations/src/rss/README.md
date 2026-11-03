# rss

Headlines from open news feeds: Valor, InfoMoney, Brazil Journal, Exame, Money Times (pt),
CNBC and MarketWatch (en). The list is `OUTLETS` in `index.ts`.

## Access

Public RSS/Atom feeds over HTTPS, no keys. bloomd reads them every 10 minutes with its honest
user agent. `parse.ts` is a small RSS 2.0 / Atom reader with no dependencies.

## Provides

- `news`: title, link, publication time, author, and the feed's description as plain text.
  A wire story an outlet republishes shows as "Reuters via InfoMoney".

## Limits

- Headlines and teasers only. Paywalled full text (Valor) isn't fetched.
- Feeds carry the latest 10 to 100 items, so an outage longer than that loses items.
- One outlet failing doesn't fail the poll; all of them failing does.
- Feed text is untrusted: bloomd treats it as data, and so must any agent reading it.

## Verified

2026-10-28: every URL in `OUTLETS` answered 200 with items.
