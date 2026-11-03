# sec-edgar

US company filings from SEC EDGAR, for the US equities you hold and watch: 8-Ks with their
item descriptions (results, officer changes, material agreements…), 10-Qs, 10-Ks, 6-Ks,
20-Fs, proxies and 13D/13G stakes.

## Access

EDGAR's public JSON: `www.sec.gov/files/company_tickers.json` (ticker → CIK, refreshed
daily) and `data.sec.gov/submissions/CIK##########.json` per company. No keys, but EDGAR's
fair-access policy asks every program to name a contact in its User-Agent, so add an email
in SET (`sec-contact`). bloomd sends `bloomterm/0.1 (personal market terminal; <email>)`.

## Provides

- `news` (kind `filing`): form, items, acceptance time and a link to the primary document,
  tagged with the company's security key. Polled every 30 minutes, 40 companies at most,
  one request every 200 ms.

## Limits

- Only companies you hold or watch; there's no market-wide filing stream here.
- Ownership forms (3, 4, 5, 144) are skipped.

## Verified

2026-10-28: `data.sec.gov` submissions answered; `company_tickers.json` refuses requests
without a contact, as documented.
