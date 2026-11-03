# EVOLVE: building and repairing integrations

This is the routine an agent follows when bloomterm asks it to build, extend or fix an
integration (`bt evolve <id> [goal]`, or `EVOLVE <id>` in the terminal). It's also the guide
for a person doing the same by hand. SPEC.md §6.11 has the design.

You run in a folder made for this run. It holds:

- `<id>/`: the integration you're working on, a copy of the owner's version, or of
  bloomterm's built-in, or empty if it's new. **This is the only thing you change.**
- `./check`: bloomd's checks of `<id>/` (below). Run it as often as you like.
- `sdk/`: the sources of `@bloomterm/sdk`, to read. Start at `sdk/integrations/sdk-surface.ts`.
- `examples/`: bloomterm's built-in integrations, written the same way (`rss/` and `cvm/` for
  news, `brapi/` and `alpaca/` for market data, `b3/` for a browser adapter).

When you stop, bloomd checks `<id>/` again. The owner reads the diff and approves it, or
doesn't. Only approved files run: bloomd keeps a hash of exactly what they approved.

## Hard rules

These come before the goal. If the goal needs one of them broken, stop and say why.

1. **Read-only.** bloomterm never trades, transfers, pays or changes anything in an account.
   Don't write code that does, and don't call anything that could: no POST, PUT, PATCH or
   DELETE to the institution unless it's a read with a body (a GraphQL `query`, a search).
   Then declare it in `allowWrites` as narrowly as you can (`{ url, graphql: 'queries-only' }`).
   The mutation guard blocks everything else and fails the job.
2. **No credentials, ever.** The owner signs in themselves, in the bloomterm Chrome profile.
   Never ask for, type, store, log or print a password, one-time code, cookie value or token.
   Code runs inside the signed-in profile (`request` and `page` from the strategy context),
   so credentials never leave it. If you get a sign-in page, stop and say
   `LOGIN <id>` is needed.
3. **No evasion.** Don't fake headers, user agents, origins or fingerprints. Don't solve or
   bypass CAPTCHAs, bot walls or rate limits. A `blocked` site stays blocked until the owner
   clears it. Keep `minIntervalMs` and `maxJobsPerHour` modest; the defaults are fine.
4. **Nothing personal in the folder.** Fixtures and tests use made-up data: no names, emails,
   addresses, account or document numbers (CPF), and no real balances or positions. Never
   save a HAR, a cookie, a raw capture or a screenshot.
5. **Stay in your folder.** Write only to `<id>/`. Everything else here is thrown away.
6. **Import only `@bloomterm/sdk`, `node:` modules and your own files.** There are no npm
   packages here, and bloomd refuses any other import. Relative imports end in `.ts`.

## The contract

An integration is a folder whose `index.ts` default-exports `defineIntegration({...})`
(`sdk/integrations/sdk.ts`). It must have:

- `id` (kebab-case, the folder name), `name`, and `covers`: one line on what it gives the owner.
- `access`: `'api'` if it uses an API with keys or no auth, or `'browser'` if it goes through
  the signed-in browser.
- `status`: `'draft'` until `try_dataset` has passed against the live site, then `'ready'`.
  Drafts are never scheduled.
- `secrets`: every API key it reads, each with a label and a sign-up URL. It can read only
  the secrets it declares. The owner enters them in SET; you never see them.
- what it provides: `market` (quotes and daily bars, plus `intraday` 5-minute bars for the 1D chart
  if the source has them), `news` (headlines and filings, polled), and/or
  `browser` (account datasets).
- `README.md` with `# <id>`, `## Access`, `## Provides`, `## Limits` and `## Verified`.

Account data has fixed shapes, from `@bloomterm/sdk`: `Account`, `Position` and `Balance`.
A dataset with `persist: 'positions' | 'balances' | 'accounts'` must match `z.array(<that>)`.
Map the site's fields onto them; don't widen them. If something won't fit, say so in the
summary.

bloomd runs your files with Node's own TypeScript support, which strips the types and runs
what's left. So write only erasable TypeScript: no `enum`, no `namespace`, no constructor
parameter properties; use `import type` for types. `./check` catches these.

## The routine

### 1. Read what's there

- `<id>/` if it has files: the code, the README (what's mapped, what isn't), the tests.
- `get_sources` and `get_jobs` (source `<id>`): is it signed in, and how did it last fail?
- The goal. "Fix" usually means a changed endpoint, a changed field, or a schema mismatch;
  the failing job's error says which.

### 2. Look for an API first

An official API beats scraping. Search for one (web search, when it's on): developer portal,
personal access tokens, open-banking access for individuals. For Brazilian institutions,
Open Finance Brasil only serves registered companies, so it doesn't count. If there's an API
an individual can use:

- write an `access: 'api'` integration, with `secrets` for its keys;
- use `getJson` (it sends bloomterm's honest user agent and turns errors into readable
  `ProviderError`s), and parse responses with zod (`z`);
- tests use recorded-and-scrubbed responses, never the network;
- say in the summary which keys the owner must add in SET, and where to get them.

Today the API side of the contract carries market data (`market`) and news (`news`: a feed
with `everyMs` and `latest({ securities, since })` returning `NewsData` items; see
`examples/rss/` and `examples/cvm/`). Account data over an API isn't in the contract yet. If
that's what you found, describe the API and stop.

### 3. Otherwise, reverse-engineer the site's own API

Almost every bank and broker page loads its data from JSON endpoints. Find those; they're
far steadier than the HTML.

1. **Recordings.** `list_recordings` lists HARs the owner made with
   `bt record finance <url>`. `har_summary` lists the data requests; `match` narrows them.
   `har_entry` shows one request in full. Credentials are redacted; header and cookie names
   remain, so you can see how auth works.
2. **Live capture.** `browser_capture <url>` opens the page in the owner's signed-in
   profile and returns what it rendered plus every XHR and fetch it made, with bodies. Go
   from the landing page to the data the same way a person would, one capture per page.
3. **Confirm.** `browser_fetch <url>` makes the GET exactly as a `request` strategy will.
   If it returns the data, you have your strategy.

Work out:

- **Which endpoints** return the dataset, and the call order (often accounts first, then
  positions per account).
- **How auth rides along.** Cookies need nothing: `request` shares the profile's cookies.
  A bearer token or CSRF header the page reads from storage needs a `page`: open the app
  page, read the value with `page.evaluate`, and pass it in the request's headers. It stays
  inside the strategy; never log or return it.
- **Pagination, dates and currencies.** Amounts as strings, cents as integers, Brazilian
  `1.234,56` formats: convert explicitly, and test each case.
- **The signed-in check.** The cheapest call that's 200 when signed in and 401 or a
  redirect to a login page when not. That's `login.check`.

### 4. Write strategies, steadiest first

A dataset lists strategies in order. The first one whose output passes the schema wins
(`sdk/browser/types.ts`):

1. `request`: `ctx.fetchJson(url)` with the profile's cookies. Best.
2. `download`: the site's own CSV or PDF export, via `ctx.download(locator)`. Steady, but
   slow.
3. `intercept`: `ctx.capture(/pattern/, () => page.goto(...))` collects the JSON the page
   loads by itself. Use it when the request needs tokens you can't read.
4. `dom`: read the rendered page. Last resort: it breaks when the layout changes. Prefer
   ARIA roles and visible text over CSS classes.

Two strategies (say `request`, then `intercept`) make a dataset survive one of them breaking.
Never click anything named like buy, sell, transfer or pay; the click firewall blocks it anyway.

### 5. Test

In `<id>/`:

- `fixtures/`: scrubbed responses (rule 4). Keep the real structure and field names; replace
  every value that could identify the owner.
- `<id>.test.ts`: the mapping from fixtures to schema output, edge cases included (empty
  account, odd number formats, a missing optional field). Use `node:test` and
  `node:assert/strict`; read fixtures with `readFileSync(new URL('./fixtures/x.json',
  import.meta.url))`. Unit tests only: no browser, no network.
- Run `./check` and fix what fails. It reports four things:
  - **loads**: Node imports `index.ts` the way bloomd will, and it exports a valid
    integration whose id is the folder's name;
  - **typecheck**: `tsc`, strict, against `@bloomterm/sdk`;
  - **tests**: every `*.test.ts` passes;
  - **README**: the sections the contract asks for are there.
- What your shell may run depends on your CLI, and bloomd's instructions for this run say
  which. Claude Code runs an allowlist (`./check`, `ls`) and reads files with Read, Glob and
  Grep. Codex runs a shell sandboxed to this folder. A refused command doesn't mean the shell
  is off.

### 6. Verify against the live site

`try_dataset <name>` loads `<id>/` as it is now and runs it in the signed-in profile, guard
on. Nothing is saved. Read the result:

- `ok: true`: look at the data. Are the rows plausible, and are all accounts there?
- `stage: 'load'`: the module didn't import (syntax, an import bloomd refuses, export shape,
  id mismatch).
- schema issues: fix the mapping, not the schema.
- needs sign-in: stop and say so.
- a guard violation: something tried to write. Find out what before going on.

It counts against the site's rate limit, so fix what you can with unit tests first.

### 7. Wrap up

- `README.md`: what's mapped (endpoints by path, with no ids), what isn't, the limits (D-1
  data, rate limits, flaky parts), and under `## Verified` the date and what passed
  `try_dataset`.
- `status: 'ready'` only if every dataset passed `try_dataset` in this run.
- `./check` passes.
- End with a summary for the owner: what changed, what passed, what's missing, and anything
  they need to do (sign in, record a session, add a key).

The owner reviews the diff (in the run's chat, or `bt integrations diff <id> --run <chat>`),
approves it, and restarts bloomd.
