# bloomterm — Product & Technical Spec

Status: draft v0.4 · 2026-10-28 · owner: herval · markets: US + Brazil (B3) · display: USD

A personal, keyboard-first market terminal, in the tradition of the professional ones. It runs locally on
your own machine and pulls from every data source you have access to. Sources with an API are called
through the API. Sources without one go through a real Chrome browser driven by bloomterm, using a saved
profile that you sign into yourself, so bloomterm never handles your passwords.

It is AI-first. It needs Claude Code or Codex installed and runs them on your own subscription (no API
keys) for two jobs. One is ASK, a chat over the terminal's data (§10.2). The other is EVOLVE (§6.11):
the agent writes and repairs bloomterm's integrations, finding a site's API or its own JSON calls
through your signed-in browser, and testing against the live site. Its work lands in your data
folder, and runs only once you review and approve it.

---

## 1. Goals and non-goals

### Goals

1. **One screen for markets and your money.** Quotes, charts, news, filings, fundamentals, macro, the
   economic and earnings calendars, and *your* positions across every account, all behind one command line.
2. **Any source, API or not.** Each dataset can come from an official API, an unofficial endpoint, or a
   browser session. The source is swappable without changing the UI.
3. **Your credentials stay in your browser.** You type passwords and 2FA codes into a real Chrome window.
   bloomterm keeps the resulting session (cookies) in a dedicated profile directory and never reads,
   stores, or types credentials itself.
4. **Terminal ergonomics.** `TICKER FUNCTION <GO>` mnemonics, dense amber-on-black panels, linked
   panels, saved layouts, and everything reachable from the keyboard.
5. **Trustworthy numbers.** Every value records its source, how it was fetched, and when, and the UI
   shows when a value is stale or came from a fallback.
6. **AI-native.** `ASK` answers questions over your local data with citations. `BRIEF` writes a morning
   summary. When a scraper's parser breaks, an LLM extracts the data instead so the feed keeps working.
7. **Agent-accessible.** The same functions are exposed through a CLI and an MCP server, so Claude Code
   and other agents can query the terminal.

### Non-goals (v1)

- **Trading or any other account changes.** bloomterm is read-only toward financial accounts, and the
  browser layer actively blocks requests that change account state (see §6.8).
- Multi-user use, hosting, or redistributing data. This is a single-user tool on your machine.
- Institutional-grade coverage of OTC markets, evaluated bond pricing, CDS, or chat.
- Tick-level or HFT data, order books, and backtesting. These may come later; none of the v1 design depends on them.
- Bypassing paywalls or auth. The browser only reaches pages your own accounts and subscriptions can already open.
- Tax calculation (Brazilian IR/DARF, US cost-basis reporting). It's a good candidate after P2, since the
  transaction data will already be in `txn`.

---

## 2. User and context

- One user on one Mac in v1. The daemon runs whenever the machine is awake.
- **Markets in v1: US and Brazil (B3).** Portfolio values show in USD by default, with a BRL toggle (§7.6).
- **Accounts in v1** are the kinds an investor in both markets tends to have:
  - US: a brokerage and a bank.
  - Brazil: a broker, a digital bank and an incumbent bank, plus B3's Área do Investidor.
  - No paid news subscriptions. The route for each kind of account is in §7.7.
- The user is a power user who lives on the keyboard, often checks in from a phone, and runs many agents.
- **Laptop sleep matters.** Scheduled scrapes are missed while the machine sleeps, so the scheduler
  catches up on wake (§8.3). An always-on host such as a Mac mini is an open question (§15).

---

## 3. Product principles

1. **Cache-first, never block on the network.** Each panel renders immediately from local data,
   showing its age, then updates live as fresher data arrives. Browser fetches can take minutes, and the
   UI must never wait on them.
2. **Prefer the most reliable route.** Use an official API first, then an unofficial endpoint, then
   the browser. Within the browser, prefer an export file or JSON over DOM scraping, and DOM scraping
   over LLM extraction (§6.6).
3. **Every number has provenance.** Record `source`, `method`, `fetched_at`, `as_of`, and `confidence`
   on each value. Hovering a value shows them.
4. **Fail loud, degrade gracefully.** When a source breaks, show stale data with a warning rather than a
   blank panel, and raise the failure in `SRC`.
5. **One registry, four surfaces.** Each function (GP, DES, PORT, ...) is declared once and drives the
   UI panel, the CLI command, the ASK tool, and the MCP tool.

---

## 4. UX

### 4.1 Layout

bloomterm is a web app with pages, not a terminal clone. The four-panel terminal is still there, as
one of the pages.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ bloomterm   [⌘K Search tickers, pages, or ask…]          ● US open 2h10m  ● B3 open  ✦ claude ●│ ← top bar
├───────────────┬──────────────────────────────────────────────────────────┬───────────────────┤
│ Today         │ Today  Wed, Oct 28                                         │ ✦ Ask        ⤢  × │
│ Markets       │ [IBOV ~~ -1.5%] [SPY ~~ +1.2%] [QQQ] [USDBRL] [BTC]        │                   │
│ Portfolio     │ ┌ Net worth ────────┐ ┌ ✦ Brief ─────────── Regenerate ┐ │   How is PETR4    │
│ News          │ │ $1,284,331 +0.66% │ │ • Markets mixed; PETR4 led …   │ │      doing?  ─┐   │
│ Watchlists    │ └───────────────────┘ └────────────────────────────────┘ │ PETR4 52.55 …     │
│  # Core   11  │ ┌ Movers ─── Why? ┐ ┌ News for you ┐ ┌ Pinned ────────┐ │ [PETR4 ~~ -0.4%]  │
│ Boards        │ │ PETR4 ~~ -2.1%  │ │ Petrobras … │ │ answers from   │ │ [📌 Pin to Today] │
│  Terminal     │ └─────────────────┘ └─────────────┘ └ Ask ───────────┘ │ [Follow up…     ➤]│
│ ✦ Ask ⌘J      │ ┌ Heatmap ──────────────────────┐ ┌ Watchlist: Core ─┐ │                   │
│ Sources  1    │ └───────────────────────────────┘ └──────────────────┘ │                   │
└───────────────┴──────────────────────────────────────────────────────────┴───────────────────┘
```

- **Pages have URLs:** `/` Today, `/markets?list=`, `/s/PETR4?range=1Y`, `/portfolio`,
  `/news?f=me&security=&story=`, `/ask/<chat>`, `/terminal`, `/sources`, `/jobs`, `/settings`,
  `/help`. Back works, and any of them can be bookmarked or opened in a new tab. bloomd serves the app
  for any path that isn't an API or a file.
- **Today** is the default page. It shows:
  - the markets strip;
  - net worth, from your accounts;
  - the brief (§10.3);
  - movers, sorted by their dollar impact on what you hold, each with "Why?";
  - news on what you hold and watch;
  - answers you pinned from Ask;
  - a heatmap, and the current watchlist.
- **A security's page** has:
  - the price with today's change, and the change over the chart's range;
  - a chart with news and filing markers: 1D is today's session in 5-minute bars, and scrolling
    back past the range loads older daily bars;
  - "why it moved";
  - your position;
  - key stats;
  - the news and filings tagged with it.
- **Sidebar.** The pages, your watchlists, and boards (the terminal). At the bottom: Ask, Sources (with
  a count of what needs attention), Jobs, Settings, Help. It shrinks to icons on narrow screens, and
  phones get a tab bar instead.
- **Top bar.** Search (⌘K), market sessions, the agent CLI in use, bloomd's connection, and the most
  urgent problem (a sign-in, a failed job).
- **Ask** opens as a drawer beside any page (⌘J) or as its own page. It knows the page you're on.
- **The terminal** (`/terminal`) is the original board:
  - four panels with a command line;
  - link groups, so loading a security in one panel loads it in the others of the same group;
  - resizable splits and maximize (`Ctrl+M`).
  
  Every panel view also has a page.
- **Launchpad (`LP`, later).** Saved named boards.

### 4.2 Command grammar

```
[security] [FUNCTION] [args...] <GO>
```

- `<GO>` is Enter. `Esc` goes back or cancels. `Tab` autocompletes and
  `↑`/`↓` move through history.
- **Securities** use a `ticker [exchange] sector` key: `AAPL US Equity`,
  `PETR4 BZ Equity`, `EURUSD Curncy`, `BTCUSD Crypto`, `SPX Index`, `CL1 Comdty`, `US10Y Govt`.
  You type as little as resolves unambiguously: `aapl`, `petr4`, `eurusd`, `btc`, `spx`. Typing a company name (`apple`) fuzzy-matches.
  - **Brazil keys:**

    | Key | Instrument |
    |---|---|
    | `PETR4 BZ Equity` | Stock |
    | `HGLG11 BZ Equity` | FII |
    | `BOVA11 BZ Equity` | ETF |
    | `AAPL34 BZ Equity` | BDR, linked to `AAPL US Equity` |
    | `IBOV Index`, `IFIX Index` | Indices |
    | `USDBRL Curncy` | Currency |
    | `DI1F27 Comdty` | DI future |
    | `NTNB35 Govt`, `LTN27 Govt`, `LFT29 Govt` | Tesouro Direto titles (bloomterm's own short codes) |

  - B3 tickers end in a digit, so they rarely collide with US tickers. A name can match several share
    classes: `petrobras` matches both PETR3 and PETR4, and the picker shows both.
- **Function** is a 1–5 letter mnemonic. With no function, the security opens its default view (`OV`).
- **Numbered drill-down.** Every list row is numbered. Typing `3 <GO>` opens row 3.
- **Natural-language fallback.** Input that doesn't parse as a command goes to `ASK`
  (e.g. `why is nvda down today`).
- **Everywhere, not just the terminal.** ⌘K takes the same grammar. `PETR4 GP 1Y` opens PETR4's page
  on the 1Y chart; `W` opens Markets; `EVOLVE b3` starts a run and shows it in Ask. On the terminal page,
  commands run in the active panel as before.
- No action requires the mouse, though clicks and scrolling work everywhere.

### 4.3 Keyboard

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Search: securities (by ticker or company name), pages, actions, mnemonics; `⌘↵` asks instead |
| `⌘J` / `Ctrl+J` | Open or close Ask beside the page |
| `/` or any letter | On a page: start a search. In the terminal: type on the command line |
| `Enter` | GO |
| `Esc` | Back / cancel / close |
| `Ctrl+1…9` | Terminal: focus panel N |
| `Ctrl+Shift+←/→` | Terminal: previous/next tab in the panel (later) |
| `Ctrl+M` | Terminal: maximize/restore the panel |
| `F1` / `HELP` | Help for the current function |
| `Ctrl+.` | Show provenance of the focused value |

### 4.4 Visual language

Dense but modern: an app for reading numbers, not a terminal costume. Light by default, with a dark
theme.

- **Themes.** Light (the default), Dark, or System (follows macOS), in Settings → Appearance, the
  sun/moon in the top bar, or ⌘K. The choice is per browser (localStorage), so it applies before
  anything loads. Every color is a token in `styles.css`; charts and the heatmap read the same tokens.
- **Surfaces.** Light: white cards (`#FFFFFF`) on a cool grey page (`#F4F5F7`). Dark: graphite
  (`#0B0D10`) with cards (`#12151A`). Both use 1px hairline borders and 10px corners, with shadows only
  on the palette and floating drawers.
- **Type.** Geist for text and Geist Mono for every number, at 12–13px. Both are bundled, since the CSP
  allows no outside fonts.
- **Color** (light / dark).
  - Text: ink `#13161B` / near-white `#E7EAEE`; muted `#677180` / `#8A939E`.
  - Up/down: green `#0A7F55` / `#3DDC97`, red `#CF2F2F` / `#FF7A7A`. The light ones are darker so
    they read on white.
  - Links and commands: `#1A66D6` / `#6CB6FF`. Filings: violet.
  - Amber: the agent (✦), focus, and anything that needs you. Text in amber is `#B45F06` on light;
    filled buttons are `#F5A524` in both.
- **Charts.** Candles or an area line colored by direction, no vertical grid, SMA 50/200 on demand, and
  news and filing markers you can click. Sparklines show the last month.
- **Tick flash.** A changed value's background flashes green or red for 300ms.
- **Staleness.** A value older than its freshness threshold dims and shows its age. Every quote shows
  its source and delay on hover.

---

## 5. Function catalog

Phase tags: **P0** foundation, **P1** daily driver, **P2** depth (see §13).

### Market overview

| Mnemonic | Name | What it shows | Phase |
|---|---|---|---|
| `TOP` | Top news | Clustered, deduped headlines across all news sources, ranked | P1 |
| `WEI` | World equity indices | Major indices by region (incl. IBOV, IFIX, SMLL), day/YTD change, open/closed state | P1 |
| `FX` | Currencies | Majors plus your currencies (USDBRL alongside the BCB PTAX fixing): matrix and movers | P1 |
| `CRYP` | Crypto | Top coins and your holdings, real-time | P1 |
| `GC` | Yield curves | US Treasury curve; Brazil DI (nominal) and IPCA+ (real) curves. Today vs 1W/1M/1Y ago | P1 |
| `TD` | Tesouro Direto | Current rate and price of each Tesouro title, with history | P1 |
| `CMDT` | Commodities | Energy, metals, ags front-months | P1 |
| `MOST` | Most active / movers | Gainers, losers, and volume leaders, filterable by index | P1 |
| `ECO` | Economic calendar | US and Brazil releases (BLS/BEA/Fed, IBGE/BCB/Copom) with time, consensus, prior, actual, and surprise | P1 |
| `ECFC` | Economic forecasts | BCB Focus survey (Selic, IPCA, GDP, FX expectations by horizon) and its week-over-week changes | P1 |
| `EVTS` | Corporate events | Earnings dates (with your holdings highlighted), dividends and JCP, splits | P1 |
| `CB` | Central banks | Fed and Copom: policy rates, next meetings, market-implied path (if available) | P2 |
| `ECST` | Macro series | Any FRED/BLS/BCB SGS/IBGE SIDRA series, chartable and comparable (`ECST CPIAUCSL`, `ECST SGS:433`) | P1 |

### Security-level

| Mnemonic | Name | What it shows | Phase |
|---|---|---|---|
| `OV` | Overview (default) | Quote, mini chart, key stats, latest 5 news items, next event | P0 |
| `GP` | Price graph | Candles/line, volume, overlays (SMA/EMA/BB/RSI/MACD), compare (`GP vs SPX`). 1D is the latest session in 5-minute bars; scrolling back past the range loads older daily bars | P0 |
| `GIP` | Intraday graph | 1m/5m bars, N days (GP 1D covers today in 5m) | P1 |
| `DES` | Description | Business summary, sector, HQ, management, identifiers (FIGI/ISIN/CIK) | P1 |
| `FA` | Financial analysis | Income statement, balance sheet, cash flow, ratios, by quarter and year. From SEC XBRL (US) or CVM DFP/ITR (Brazil) | P1 |
| `ERN` | Earnings history | EPS/revenue actual vs estimate, surprise %, price reaction | P1 |
| `EE` | Estimates | Consensus EPS/revenue, revisions, price targets | P2 |
| `DVD` | Dividends & splits | History (incl. JCP and FII monthly distributions), yield, ex-dates | P2 |
| `CF` | Filings | SEC filings (US); CVM filings and fatos relevantes (Brazil). Full-text links and an AI summary on open | P1 |
| `CN` | Company news | News for this security (tagged), plus filings and press releases | P1 |
| `HDS` | Holders | Institutional holders (13F), changes QoQ | P2 |
| `INS` | Insiders | Form 4 transactions | P2 |
| `RV` | Relative value | Peer table: valuation, growth, margins | P2 |
| `OMON` | Options monitor | Chain by expiry, IV, greeks, OI | P2 |
| `NOTE` | Notes | Your markdown notes and thesis for this security, timestamped | P1 |

### Personal

| Mnemonic | Name | What it shows | Phase |
|---|---|---|---|
| `W` | Monitors (watchlists) | Named lists with configurable columns, real-time | P0 |
| `PORT` | Portfolio | Positions across all accounts, grouped by account, asset class, currency, or fixed-income indexer (CDI, IPCA+, pre). P&L in USD or BRL with the FX effect split out (§7.6). Fixed-income maturity ladder. `PORT NW`: net worth, counting bank cash and subtracting card balances | P1 |
| `TXN` | Transactions | Activity across accounts (trades, dividends, transfers), searchable | P2 |
| `ALRT` | Alerts | Create, list, and inspect alerts (§9) | P1 |
| `BRIEF` | Daily brief | AI morning summary (§10.3) | P1 |
| `ASK` | Ask | Natural-language Q&A over your data (§10.2) | P1 |
| `EQS` | Equity screener | Filter the universe by fundamentals and technicals, save screens | P2 |

### System

| Mnemonic | What it does | Phase |
|---|---|---|
| `SRC` | Health of each source: session state, last success, error streak, rate-limit headroom, AI spend | P0 |
| `LOGIN <source>` | Opens the sign-in window for a browser source (§6.4) | P0 |
| `JOBS` | Scheduler: upcoming, running, and failed jobs; rerun on demand | P0 |
| `WATCH` | Defines a no-code browser source: URL plus "what to extract" plus schedule (§6.10) | P2 |
| `LP` | Launchpad layouts | P1 |
| `SET` | Settings | P0 |
| `HELP` / `F1` | Help | P0 |

---

## 6. Browser data layer

This layer answers "no API? use the browser." It is the most fragile part of the system, so it carries
the most design.

### 6.1 Concepts

- **Profile.** A Chrome user-data directory owned by bloomterm. It holds cookies, local storage, and
  (if you choose) Chrome's own saved passwords for autofill. There are two by default:
  - `finance`: brokerages, banks, retirement accounts.
  - `web`: news subscriptions, data sites, calendars.

  Keeping financial sessions apart from general browsing limits how far a misbehaving adapter or a
  hostile page can reach. You can add more profiles, for example one per bank.
- **Browser host.** A long-running component of the daemon. Each profile has exactly one live Chrome
  instance. Playwright's `launchPersistentContext` allows one process per user-data dir, so the host
  owns that lock.
- **Browser adapter.** Code that knows one site: how to tell whether you're signed in, how to fetch each
  dataset, and how to parse it.
- **Job.** One run of an adapter dataset, such as `brokerageA.positions`. Jobs are queued per profile
  and per site.

### 6.2 Browser runtime

- Uses the **installed Google Chrome**, not bundled Chromium, so sites see an ordinary, current
  Chrome. Chrome for Testing is a config option. bloomterm looks for it (`packages/browser/src/chrome.ts`):
  1. at `[browser] chrome` in config.toml (the app or its binary), and only there when it's set;
  2. otherwise in `/Applications`, then `~/Applications`;
  3. then wherever Spotlight knows it is (`mdfind` by bundle id), e.g. a subfolder or another disk.

  It tries stable Chrome first, then Beta, Dev and Canary. Copies in the Trash or on the installer's
  disk image don't count. With no Chrome, accounts wait (`ChromeNotFoundError`) and Setup (§8.8)
  says so; market data and news don't need Chrome.
- **Dedicated profile dirs only.** Since Chrome 136, remote debugging is disabled on the *default* Chrome
  profile, and Playwright doesn't support automating it. bloomterm therefore keeps its own profiles under
  `~/.bloomterm/profiles/<name>` and never touches your everyday Chrome profile.
- **Parked-headed mode (default).** Each profile's Chrome runs as a real, headed window parked off-screen
  (`--window-position` off-screen). When something needs you (sign-in, 2FA, a CAPTCHA), the host moves
  that window on-screen via CDP `Browser.setWindowBounds` and focuses it. Afterwards it parks it again.
  - This avoids relaunching to switch between headless and headed, which would lose page state midway
    through a challenge.
  - Pages behave as they do for a normal user.
  - **Headless mode** is a per-profile option for lighter footprint, used where sites tolerate it. On a
    challenge, the host relaunches headed at the same URL.
- **Measured on macOS (P0, Chrome 155):**
  - macOS won't keep a window fully off-screen; it leaves a ~40px strip. Parking therefore *minimizes*
    the window at that strip.
  - A new tab un-minimizes the window, so the host re-parks it after creating each job tab.
  - Launching Chrome makes it the frontmost app, so the runtime hands focus back to the app you were
    in, both after a launch and after a sign-in window closes.
  - The first launch briefly shows the window before it parks.
- **Session cookies across restarts.** They survive only with `--restore-last-session` plus the
  "continue where you left off" pref. Both are set by default.
- **Keychain.** Profiles use the real macOS Keychain to encrypt cookies, not Playwright's mock
  keychain, whose key is a public constant.
- No stealth plugins or fingerprint spoofing. Pages are fetched at human-scale rates (§6.9). If a site
  puts up a bot wall, the adapter is marked `blocked` and you are asked to step in. bloomterm never tries
  to defeat the wall.
- **Concurrency.** Default limits are 2 tabs per profile and 1 concurrent job per site.

### 6.3 Session state machine

The host tracks each browser source separately:

```
           probe ok                       probe fails / redirected to login
 unknown ─────────────▶ ok ───────────────────────────────────────────────▶ needs_login
    │                    │  ▲                                                    │
    │                    │  └──────────── login detected ◀── interactive ◀───────┘
    │                    │ 2FA/CAPTCHA/interstitial mid-job                     (LOGIN <source>)
    │                    ▼
    │                challenge ── user resolves in window ──▶ ok (job resumes)
    │                    │
    └──────────▶ blocked (bot wall, 403/429 streak) ── user clears it, or `SRC <source> retry` ──▶ unknown
```

- **Probe.** Each adapter defines a cheap `session.check()`, for example "load the account summary URL;
  are we redirected to the login page?". Probes run on a schedule (default every 60 min per source,
  adapter-overridable) and before each job.
- **Keepalive (opt-in per adapter).** For sites that time out idle sessions, a keepalive can load a
  harmless page on an interval. It is off by default; you enable it per source.
- **While a source is in `needs_login`, `challenge`, or `blocked`:**
  - Its jobs stop and its data is served stale.
  - The status bar alerts and a macOS notification goes out, with optional push (§9.3).
  - `SRC` shows the last good data timestamp.

### 6.4 Sign-in flow (`LOGIN <source>` / `bt login <source>`)

1. The host pauses that profile's job queue, opens a new tab at the adapter's `login.url`, and moves the
   window on-screen.
2. A small bloomterm banner is injected at the top of the page: *"bloomterm: sign in to brokerageA. This
   window closes itself when you're in."*
3. **You type your credentials and 2FA.** Chrome may offer to save the password in that profile, which
   is your choice. bloomterm never reads password fields (§6.8).
4. The host polls `session.check()` every 2s. Once it passes, the session is `ok`, the window parks, and
   queued jobs resume, with that source's overdue jobs running first.
5. The flow times out after 10 min and returns the source to `needs_login`.

You can also run `LOGIN` with no argument: the window opens on a blank tab and you can sign in anywhere
by hand. This is useful for the `WATCH` sources in §6.10.

Some sign-ins refuse any browser under automation: Google says "This browser or app may not be secure",
and bot checks never finish. For those, `bt profile open <profile>` (or **open** in Settings → Browser)
closes bloomterm's Chrome for the profile and opens the same profile dir in plain Chrome, with nothing
attached. You sign in, quit it (⌘Q), and bloomd probes that profile's sources. Jobs on the profile wait
meanwhile. Jobs still run in the automated Chrome afterwards, so a site that checks every visit may
still turn them away, and bloomterm doesn't disguise that (§6.8).

### 6.5 Integrations

Every data source is an **integration**: a folder `packages/integrations/src/<id>/` whose `index.ts`
default-exports `defineIntegration(...)` (`src/sdk.ts`), plus a `README.md` with Access, Provides,
Limits and Verified sections. The registry (`src/index.ts`) lists them, and a contract test checks
each one.

```ts
export default defineIntegration({
  id: 'brokerage-a',                  // kebab-case; the folder name
  name: 'Brokerage A',
  covers: 'your Brokerage A positions and cash',
  access: 'browser',                  // 'api': an API (with keys or none) · 'browser': your signed-in Chrome
  status: 'draft',                    // 'ready' once it has passed try_dataset against the live site (§6.11)
  secrets: [],                        // API keys it reads (entered in SET); it can read only these
  // market: (ctx) => MarketFeed,     // quotes and bars
  browser: adapter,                   // defineBrowserAdapter(...): account datasets
});
```

`defineIntegration` and `checkRegistry` enforce the contract:
- ids are unique and kebab-case;
- `access: 'browser'` comes with a browser adapter of the same id and status, and `access: 'api'` comes without one;
- secret names are unique across the registry, and an integration that asks for a secret it didn't declare gets an error.

Drafts are never scheduled.

**API integrations** provide `market`, a `MarketFeed` (`supports`, `quote`, `bars`, `quoteTtlMs`),
and read their keys through `ctx.secret(name)`. Account data over an API (a broker's positions
endpoint) isn't in the contract yet. It would add API datasets that bloomd schedules like browser ones.

**Browser adapters** describe sign-in and datasets. The example below is illustrative; its URLs
and selectors are placeholders.

```ts
import { defineBrowserAdapter, z } from '@bloomterm/browser';
import { Position } from '@bloomterm/core';

const adapter = defineBrowserAdapter({
  id: 'brokerage-a',
  name: 'Brokerage A',
  profile: 'finance',                     // the profile sets parked or headless (§6.2)
  origins: ['https://*.brokerage-a.example'],

  login: {
    url: 'https://www.brokerage-a.example/login',
    // Cheapest signed-in check: shares the profile's cookies, touches no tab.
    check: async ({ request }) => (await request.get('https://api.brokerage-a.example/me')).ok(),
    probeEveryMinutes: 60,
  },

  // Non-GET requests to `origins` are blocked unless they match one of these (§6.8).
  allowWrites: [{ url: /\/api\/graphql$/, graphql: 'queries-only' }],

  datasets: {
    positions: {
      schema: z.array(Position),
      persist: 'positions',
      schedule: { cron: '0 7,13,19 * * 1-5', tz: 'America/New_York' },
      freshness: '8h',
      // Strategies are tried in order; the first output that passes validation wins (§6.6).
      strategies: [
        { kind: 'request', run: async (ctx) => mapPositions(await ctx.fetchJson('https://api.brokerage-a.example/positions')) },
        { kind: 'intercept', run: async (ctx) => {
            const [json] = await ctx.capture(/\/api\/positions/, () => ctx.page.goto('https://www.brokerage-a.example/positions'));
            return mapPositions(json);
        }},
        { kind: 'download', run: async (ctx) => {
            await ctx.page.goto('https://www.brokerage-a.example/positions');
            return parsePositionsCsv(await (await ctx.download(ctx.page.getByRole('button', { name: /download/i }))).text());
        }},
        { kind: 'llm', prompt: 'The positions table: symbol, quantity, price, market value, cost basis' },
      ],
      checks: [sumMatchesAccountTotal({ tolerance: 0.005 })],
    },
  },
});
```

**The strategy context gives you:**
- `page`: a Playwright Page in the adapter's profile, behind the mutation guard and credential firewall.
- `request`: shares the profile's cookies; writes go through the guard.
- `fetchJson(url)`: GET with the profile's cookies. It saves the body to raw, and a 401 becomes `NeedsLoginError`.
- `capture(urlPattern, action)`: collects JSON responses while `action` runs.
- `download(locator)`: clicks and returns the saved file.
- `snapshot()`: page text, HTML and a screenshot.
- `log`.
- `raw.save(name, data)`.

### 6.6 Extraction strategies, most to least reliable

| Kind | How | When |
|---|---|---|
| `request` | Call the site's internal JSON endpoints directly with the profile's cookies (`context.request`). No rendering. | Best whenever the site's app talks to a JSON API. Found by recording traffic (§6.11). |
| `download` | Click "Export / Download CSV / OFX / PDF" and parse the file. | Brokerages and banks. Very stable formats. |
| `intercept` | Navigate and capture the JSON XHR/fetch responses the page loads. | SPAs. Not affected by DOM changes. |
| `dom` | Role- and text-based locators, then table parsing. Avoid CSS chains. | Server-rendered pages. |
| `llm` | `snapshot()` goes to Claude with the dataset's JSON schema; the reply is validated against it. | The last-resort fallback, and the primary route for rare, unstructured pages (statements, research notes). |

- Output from every strategy must pass the dataset's **zod schema** and the adapter's **sanity checks**,
  for example: positions sum to the account total within 0.5%; prices fall within ±50% of the last known
  value unless a split occurred; the date is in a plausible range.
- If a strategy fails validation, the next one runs. When the result comes from a fallback, `SRC` shows
  a "degraded" note, such as "brokerageA.positions served by `llm` (download parser failed 3×)".
- **LLM-extracted values** carry `confidence: 'llm'` and are marked `↯` in the UI. Portfolio values from
  `llm` must pass the sum check, or they are held for review rather than stored.

### 6.7 Raw capture

Each browser job writes what it fetched to `raw/<source>/<yyyy-mm-dd>/<job-id>/`: JSON responses,
downloaded files, an HTML snapshot, and, on failure, a screenshot plus a Playwright trace.

- **Re-parse without re-scraping.** When a parser is fixed, `bt reparse <source> --since 7d` rebuilds the
  data from stored captures.
- **Retention.** 30 days by default. Statements and other downloaded documents are kept indefinitely.
- These files are sensitive: the directory is `0700`, never synced, and excluded from logs.

### 6.8 Safety rails

- **Mutation guard.** On every browser job, a `page.route` interceptor blocks any non-GET/HEAD request to
  the adapter's origins unless it matches `allowWrites`.
  - **GraphQL endpoints.** Many apps send their *reads* as GraphQL POSTs (some banks' web apps do). An
    `allowWrites` entry can be marked `graphql: 'queries-only'`; the guard then parses each request body
    and blocks any `mutation` operation.
  - Blocked attempts fail the job and are logged with the URL.
  - Other origins (analytics, CDNs) pass through untouched.
  - The guard is off only while you have the window during `LOGIN` or a challenge.
- **Credential firewall.**
  - Adapter code can't `fill`, `type`, or read `.value` on `input[type=password]` or on fields
    autocompleted as one-time codes; the runtime wrapper throws if it tries.
  - Banners and logs never include form field contents.
  - Account numbers are masked to their last 4 digits in logs.
- **Deny-listed actions.** A runtime lint fails any adapter click whose target's accessible name matches
  `/buy|sell|trade|transfer|withdraw|submit order|confirm|place order|pay/i`. This backs up the
  mutation guard.
- **Only integrations you can read run.** They load from bloomterm's own `packages/integrations` and
  from `~/.bloomterm/integrations`, and only as you approved them there (§6.11); nothing is
  downloaded remotely. `try_dataset` is the one exception: it runs an EVOLVE run's copy once, guard
  on.
- **Untrusted page content.** Text taken from pages (news, research) is treated as data.
  - The LLM calls that read it have no tools (`llm.extract`) or only read-only tools (`ASK`).
  - No tool anywhere can change an account or send data off the machine, apart from the notification
    channels you configure.

### 6.9 Politeness and scheduling

- Each site has a minimum interval between navigations (default 5s, ± 30% jitter) and a cap on jobs per
  hour (default 12).
- Scheduled jobs are jittered by ±10 min so they don't run at the same minute every day.
- **Back-off.** After 2 consecutive errors, back off exponentially. After 3 bot walls or 429s within an
  hour, mark the source `blocked`.
- This is a single-user, personal tool working at human request rates. It accesses only content your
  accounts and subscriptions already grant. Site terms vary, so each adapter's README records the site's
  automation stance and the cadence chosen.

### 6.10 No-code browser sources (`WATCH`, P2)

These cover the long tail of pages that don't merit a hand-written adapter. Example:

```
WATCH https://some-site.example/fund/123/holdings "top 10 holdings: name, weight %" every 1d profile:web
```

This creates a generated adapter whose only strategy is `llm`. You give it a name and a schema (inferred
from the description, which you then confirm), and it gets a dataset key you can use in `W`, `NOTE`, or
`ASK`. You can "promote" it into a real adapter later (§6.11).

### 6.11 EVOLVE: integrations that build and fix themselves

bloomterm's integrations are code your agent writes and maintains, inside rules it can't break.
`EVOLVE <id> [goal]` in the terminal (or `bt evolve <id> [goal]`) starts a run. A run never
changes bloomterm itself, so it works the same from a checkout and in the desktop app (§8.7).

1. **A folder of its own.** bloomd makes `<home>/evolve/<id>-<yyyymmddhhmmss>/`, holding:
   - `<id>/`: a copy of the integration, the one the agent edits. It starts from your version in
     `<home>/integrations/<id>/` if there is one, else from the built-in's source (its imports
     pointed at `@bloomterm/sdk`), else empty;
   - `CLAUDE.md` and `AGENTS.md`: the routine, `packages/integrations/EVOLVE.md`;
   - `sdk/` (the SDK's sources) and `examples/` (the built-ins), to read.
2. **The routine.** Your agent CLI (§10.1) runs there in `evolve` mode and follows it:
   1. Read what's there and why it last failed.
   2. Look for an official API first.
   3. Otherwise, find the JSON calls the site's own pages make, through your signed-in profile.
   4. Write strategies, steadiest first: `request`, then `download`, then `intercept`, then `dom`.
   5. Add scrubbed fixtures and unit tests (`node:test`).
   6. Verify against the live site.
   7. Update the README.
3. **Its tools** (`bt mcp --evolve`). All are read-only, and all are scoped to the run's integration.
   ASK's tools come too.

   | Tool | What it does |
   |---|---|
   | `list_recordings`, `har_summary`, `har_entry` | Reads the HARs you recorded with `bt record <profile> <url>` |
   | `browser_capture` | Opens a URL in your signed-in profile and returns the page's text, its links, and every XHR/fetch call with its body |
   | `browser_fetch` | Makes a GET with the profile's cookies, exactly as a `request` strategy would |
   | `try_dataset` | Loads the run's copy as it is now (a fresh module graph each call) and runs one dataset in the profile, guard on. Saves nothing, but counts against the site's rate limit |

4. **bloomd checks.** When the run ends, bloomd runs the checks itself, in a process of its own
   (`bt check-integration`), and records them with a hash of the copy's files:
   - **loads**: Node imports `index.ts` the way bloomd will (below), and it default-exports a valid
     integration whose id is the folder's name;
   - **typecheck**: `tsc`, with bloomterm's strict options, against `@bloomterm/sdk`; and every
     `.ts` file is TypeScript Node can strip (no enums, namespaces or parameter properties);
   - **tests**: its `*.test.ts` files pass under `node:test`;
   - **README**: `# <id>`, `## Access`, `## Provides`, `## Limits`, `## Verified`.
5. **You review and approve.** The run shows in the ASK panel, tagged EVOLVE, with the checks,
   **Review diff** (against your approved version, or the built-in, or nothing) and, once you've
   looked, **Approve**. The approval carries the hash of the files the diff showed, so a later edit
   isn't approved with them, and the checks must pass on exactly those files. bloomd copies them to
   `<home>/integrations/<id>/`, and they run from the next restart (**Restart bloomd** when launchd
   or the desktop app supervises bloomd). Follow-ups in the same chat resume the run in its folder.
   The CLI does the same: `bt integrations diff|approve <id> --run <chat>`.

**Your integrations** (`<home>/integrations/`). One folder per integration, from EVOLVE or edited by
hand. At start, bloomd loads each folder whose files hash to what you approved
(`state/integrations.json`, 0600), in place of the built-in with the same id; a new id joins after
the built-ins. A folder that changed since, or that you never approved, stays off, and the built-in,
if any, runs instead. Settings lists them with their state; there you review and approve a folder you
edited (`bt integrations approve <id>`), or remove one (the built-in comes back). Every version you
approved is kept in `integrations/.history/<id>/<hash>/`, and unapproved edits an approval replaces
are kept as `before-<time>/`.

**How they load.** They run on Node's own TypeScript support, which strips types and runs what's
left, through a loader hook. The hook:
- answers `import … from '@bloomterm/sdk'` with bloomd's own SDK object
  (`packages/integrations/src/sdk-surface.ts`), so error classes and schemas are the ones bloomd checks
  against;
- allows only that, `node:` modules and the integration's own files (relative imports, with their
  extension), and refuses anything outside the folder;
- gives each load its own module graph, so a reload sees the files as they are now.

Built-ins import from bloomterm's packages instead, and use only names the SDK exports, so a copy of
any of them passes the checks (a test checks this).

**What the agent sees.** Credentials, never. These are replaced by their length:
- cookie, authorization, token, session and CSRF header values;
- `Set-Cookie`;
- body fields named like passwords, tokens or tax ids.

Bodies come as samples. With `share_portfolio = false` they come as shapes (keys and types), and
long digit runs in URLs and text are masked.

**What the agent can do.**
- Claude may:
  - read anything in the run's folder;
  - edit only `<id>/`;
  - use WebSearch and WebFetch while `[agent] web` is on, to read API docs.
- Claude has no shell. Codex gets a `workspace-write` sandbox on the run's folder.
- Both run bloomd's checks with the `check` tool, on every system: a shell script wouldn't run on
  Windows.
- Neither can approve its work, and nothing it writes outside `<id>/` is kept.

**Trust.** bloomd's checks and `try_dataset` run the agent's code as you, the same trust
you give a coding agent's tests. The approval gate stops mistakes from running on a schedule, not a
hostile agent: code that runs as you could call bloomd's API itself. The mutation guard, credential
firewall and rate limits still apply to everything that touches a site.

**Fixtures and tests.** Each integration keeps `fixtures/` (scrubbed: no names, ids, emails or real
balances) and unit tests in its folder. They run with no network.

**Later.**
- SRC proposes an EVOLVE run when a dataset keeps failing its schema.
- BRIEF flags integrations whose sites changed.
- Account data over APIs joins the contract (§6.5).

---

## 7. Data sources and routing

### 7.1 Source tiers

| Tier | Meaning | Examples |
|---|---|---|
| `official` | Documented API, with a key or free | SEC EDGAR, FRED, Treasury, Alpaca, Massive (formerly Polygon.io), Finnhub, Coinbase, SnapTrade, IBKR, Schwab |
| `unofficial` | Undocumented JSON endpoints, used without a browser | Yahoo chart/quote endpoints, Nasdaq calendar JSON, CBOE delayed quotes. Tried in P0: Yahoo answers 429 to scripts and Nasdaq turns away non-browser clients, so neither is in the default map; use them through the browser tier if needed |
| `browser` | Through the browser layer, signed in or public | Brokerages and banks without APIs, paywalled news, Investing.com/ForexFactory calendars, broker research pages |
| `manual` | CSV/OFX import that you drop in a folder | Any account, as a last resort |

### 7.2 Default source map: US and global

Free sources come first, and paid ones are opt-in. "Browser fallback" means the browser layer is the
route when no configured API covers the request.

| Dataset | Preferred (API) | Fallback | Browser fallback |
|---|---|---|---|
| US equity real-time quotes | Alpaca websocket (IEX feed free; full SIP paid) · Massive (paid) | Finnhub websocket (free tier) | Broker quote pages (signed in) |
| Delayed / EOD bars | Massive (free tier: EOD, ~2y) · Tiingo | Stooq CSV · Yahoo (unofficial) | Yahoo history page |
| Non-US equities | Massive / EODHD (paid) | Yahoo (unofficial) | Local broker sites |
| FX | Massive / Finnhub | ECB reference rates (daily) | Broker FX page |
| Crypto | Coinbase / Kraken public websockets (free) | CoinGecko | — |
| Rates & yield curve | US Treasury daily par curve (CSV/XML) · FRED (`DGS*`) | — | Intraday rates via broker/quote pages |
| Commodities / futures | Massive futures (paid) | FRED daily spot series | CME/Barchart delayed pages |
| Fundamentals | SEC EDGAR `companyfacts` (XBRL, free) | FMP (paid) | Yahoo/broker pages for non-US |
| Filings | EDGAR submissions API + RSS + full-text search | — | Local regulators |
| Insiders / 13F | EDGAR Form 4 / 13F | — | — |
| Estimates / targets | Finnhub (partial free) · FMP (paid) | — | Broker research pages (signed in) · Yahoo analysis |
| Earnings calendar | Finnhub · FMP | Nasdaq JSON (unofficial) | Yahoo / Earnings Whispers |
| Economic calendar | FRED releases API (dates + actuals) | TradingEconomics (paid) | Investing.com / ForexFactory (consensus) |
| Macro series | FRED · BLS · BEA · ECB · World Bank · BCB SGS | — | — |
| News (open) | RSS/Atom feeds · EDGAR 8-K · press wires · Finnhub/Massive news | — | — |
| News (paywalled) | Publisher RSS for headlines | — | Full text via `web` profile with your subscriptions (WSJ, FT, Barron's, The Information, ...) |
| Options chains | Schwab / IBKR / Tradier (with account) · Massive (paid) | CBOE delayed (unofficial) | Broker options page |
| Holdings / balances / activity | SnapTrade Personal (free, ≤20 connections) · IBKR Flex/Client Portal · Schwab Trader API · Coinbase API | `manual` CSV/OFX | **Brokerages, banks, 401k/IRA providers without APIs** (CSV export preferred) |
| Symbology | OpenFIGI (free) · EDGAR ticker↔CIK map | — | — |

Exact accounts and subscriptions are open question #1 (§15). They decide which browser adapters get
built first.

### 7.3 Default source map: Brazil (B3)

Brazil has strong free official data for macro, rates, and company filings (BCB, IBGE, CVM, Tesouro).
Free real-time quotes are weaker, and portfolio data has no consumer API. That makes the browser layer
the main route for holdings.

| Dataset | Preferred (API / official data) | Fallback | Browser fallback |
|---|---|---|---|
| Quotes (stocks, FIIs, ETFs, BDRs) | brapi (free: ~30-min delay, 15k req/month, 1 ticker per call; paid plans: 15- or 5-min delay) | Yahoo `.SA` (unofficial) | Your broker's home-broker page, signed in (real-time) |
| Daily history | B3 COTAHIST files (official, free; daily and yearly) | brapi (paid for more than 3 months) · Yahoo | — |
| Indices (IBOV, IFIX, SMLL) | brapi · Yahoo (`^BVSP`) | B3 index pages (unofficial JSON) | — |
| USDBRL | Live: same FX sources as §7.2 | BCB PTAX (Olinda API, official daily fixing) | — |
| Policy and reference rates | BCB SGS (Selic, CDI, IPCA, IGP-M, …) | — | — |
| Curves (DI, IPCA+) | ANBIMA ETTJ (published daily) · B3 DI1 settlement prices | — | ANBIMA/B3 pages, if there's no stable file |
| Tesouro Direto | Tesouro Transparente open data (rates and prices, CSV) | — | tesourodireto.com.br |
| Fundamentals | CVM open data: DFP (annual), ITR (quarterly), FRE | brapi (paid modules) | Status Invest / Fundamentus pages (ratios) |
| Filings, fatos relevantes | CVM IPE open dataset (daily) | — | RAD CVM / B3 company pages (near real time) |
| Dividends, JCP, FII distributions | brapi (paid) | B3 company pages (unofficial JSON) | Status Invest |
| Macro series | BCB SGS · IBGE SIDRA · BCB Focus expectations (Olinda) | — | — |
| Econ calendar | IBGE release calendar · BCB Copom calendar | — | Investing.com BR (consensus) |
| Earnings calendar | — | — | Company IR pages · Status Invest |
| News | RSS where available (InfoMoney, Valor, Brazil Journal, Exame) · CVM fatos relevantes | — | Full text via the `web` profile and your subscriptions (Valor, Folha, Estadão) |
| **Holdings** | — | `manual` CSV/XLSX | **B3 Área do Investidor** (primary): **one sign-in covers every broker's B3-custodied positions**, with an Excel export. **Broker sites** (XP, BTG, Rico, NuInvest, Inter, Itaú, …) cover cash, funds, and anything B3 doesn't show |

Notes:
- **Área do Investidor coverage.** It consolidates stocks, FIIs, ETFs, BDRs, Tesouro Direto, and CDBs
  registered at B3 across all brokers. It doesn't show broker cash, automatic-investment "caixinhas", or
  most investment funds; those come from the broker adapters.
  - Plain HTTP to the site returns 403 (a WAF), so it's reachable only through the browser.
  - Its positions lag the market by about a business day, so `PORT` revalues them with live quotes and
    shows "positions as of D-1".
  - Sign-in is through gov.br or a B3 account, usually with 2FA. Expect to run `LOGIN` here more often
    than for other sources.
- **Open Finance aggregators** (Pluggy, Belvo) offer investment APIs. I couldn't confirm whether
  they can be used for personal accounts, so evaluate them before building broker adapters for
  institutions they cover.
- **Symbology.** The B3 instrument list and COTAHIST give tickers, ISINs (`BR…`), and the class of each
  instrument (ON/PN/units/FII/ETF/BDR). Each BDR is linked to its underlying security.

### 7.4 Router

Every data request is `{ dataset, key, params, maxAge }`, for example
`{ dataset: 'bars', key: 'AAPL US Equity', params: { interval: '1d', from, to }, maxAge: '1d' }`.

1. **Cache.** If the stored data covers the request and is younger than `maxAge`, return it and stop.
2. **Candidates.** Collect the adapters that declare the dataset and support the key's market, and drop
   any that are disabled, have no rate budget left, or whose session isn't `ok`.
3. **Order.** Sort by `tier`, then by user priority overrides (`config.toml`), then by quality (real-time
   ahead of delayed).
4. **Fetch.** Try candidates in order. Each result is validated, stored with provenance, and pushed to
   subscribers. On failure, move to the next candidate.
5. **All failed.** Return the stale cache with `stale: true` and the reason, and record a `SRC` event.

Requests that could hit a browser source are always **async**: the API returns the cached data at once
plus a `refreshing` flag, and the fresh value arrives over the websocket.

**Account binding.** Each financial account has exactly one source of truth, chosen when the account is
first linked. bloomterm does not merge an account's positions across sources in v1. Quotes can come from
several sources, and the freshest valid quote wins.

### 7.5 Freshness defaults

| Dataset | Default `maxAge` | Refresh cadence |
|---|---|---|
| Quotes (streaming source) | live | websocket |
| Quotes (polled) | 15s market hours / 1h closed | poll for visible + watchlist securities only |
| Intraday bars (5m, 1D chart) | 1m | on demand plus visible charts |
| Daily bars | 1d | after close + 30 min |
| News | 2m | RSS every 2–5 min; paywalled full text on open |
| Filings | 10m | EDGAR every 10 min |
| Fundamentals | 1d | daily, plus on new 10-Q/10-K |
| Econ calendar | 1h | daily, plus every 1 min around scheduled releases |
| Quotes (B3, delayed source) | the source's delay (~30m on free brapi) | poll visible + watchlist securities, within the monthly request budget |
| Brazil macro (BCB, IBGE) | 1d | daily, plus at scheduled release times |
| Holdings (API) | 15m | per provider limits |
| Holdings (browser) | 8h | ~3×/day on weekdays (configurable) |
| Holdings (B3 Área do Investidor) | 1d | once per B3 business day (its data lags about a day) |

### 7.6 Currency

- Every position, price, and cash balance keeps its native currency. `PORT` converts to the display
  currency: **USD by default**, with BRL available via `PORT ccy:BRL` or a change in `config.toml`.
- **Conversion rates.** Intraday values use the live USDBRL rate. End-of-day history and daily P&L use
  the official BCB PTAX rate for each date, so past values don't move when the live rate does.
- **P&L split.** Each position's P&L is split into the asset's move in its own currency and the FX
  effect. For example, an S&P ETF held in BRL shows "SPX +1.2%, FX −0.8%".

### 7.7 Accounts: routes and build order

The kinds of accounts v1 targets, and the route for each. Specific institutions get their own
integration, built with EVOLVE (§6.11) in your data folder, not in this repo.

| # | Account | What bloomterm needs from it | Route | Sign-in | Risk |
|---|---|---|---|---|---|
| 1 | **B3 Área do Investidor** | Every B3-custodied position at every Brazilian broker and bank: stocks, FIIs, ETFs, BDRs, Tesouro Direto, CDBs registered at B3 | Browser, `download` (Excel export) | gov.br or B3 account, 2FA | Low–medium · **P0** |
| 2 | **US brokerage** | Stocks, options, crypto, IRA positions; cash; activity | **SnapTrade Personal**, for brokerages it supports (covers IRAs and crypto). Fallback: browser `intercept` of the web app's JSON | Through SnapTrade's connect flow | Low · P1 |
| 3 | **US bank** | Checking and savings balances; credit card balance, statement, and due date; transactions | Browser, with `intercept` for balances and `download` (CSV/QFX) for transactions. A self-directed investment account at the bank may be on SnapTrade | Username/password plus device verification (SMS/push) | Medium–high: strict device checks, so expect re-verification · P1 |
| 4 | **Brazilian digital bank** | Account balance; credit card bill and limit; savings products if the web shows them | Browser, `intercept` (GraphQL, queries only) | CPF and password, often then **scanning a QR code with the bank's app**. The `LOGIN` window shows the QR | Medium · P1 |
| 5 | **Brazilian broker** | What B3 doesn't show: cash, investment funds, previdência, COE, the broker's own products | Browser, `intercept` (SPA JSON), or `download` for the consolidated position report | Account + password + an app token | Medium · P1 |
| 6 | **Brazilian incumbent bank** | Account balance, card, the bank's funds, LCA/CDB not shown at B3, transactions | Browser: `download` for the statement (OFX/CSV where offered) and `dom` for balances. Fallback: `manual` statement import | Agência/conta + password + device approval in the bank's app | **High.** Some require a security module and per-device approval, which may block automated Chrome · P1, built last |

**Notes:**
- **Positions vs everything else.** The Área do Investidor covers positions at every Brazilian
  broker and bank. Their own adapters only need cash, funds, cards, and other items B3 doesn't
  show. That's why it's built first.
- **Known gap: app-only products.** Some digital banks show savings products only in their app
  (and they're not in the Área do Investidor either). Until there's a route (an Open Finance
  aggregator, or a web view that shows them), their balance is a `manual` entry and `PORT` shows
  its age.
- **Some banks may not be automatable.** If a bank's security module or device binding blocks
  automated Chrome, bloomterm won't try to get around it. You drop a monthly OFX/CSV statement into
  `~/.bloomterm/inbox/<source>/` and it's parsed as a `manual` source.
- **No paid news.** Without subscriptions, P1 news is free RSS plus SEC/CVM filings. The `web` profile
  is still used for public pages: econ consensus calendars and Status Invest.
- **SnapTrade first where it works.** For the brokerages it covers, SnapTrade is an API, not a
  scraper, so the browser layer isn't needed there.

---

## 8. Architecture

### 8.1 Components

```
                 ┌───────────────── bloomd (daemon, Node 22 / TypeScript) ──────────────────┐
  Web UI ◀──WS──▶│  API (HTTP + WS)   Function registry   Router   Scheduler   Alert engine │
  (React)        │        │                  │               │          │            │       │
  bt CLI ◀─HTTP─▶│        └────────┬─────────┴───────────────┴──────────┴────────────┘       │
  MCP server ◀──▶│                 │                                                        │
                 │         ┌───────┴────────┐        ┌──────────────────────────────┐        │
                 │         │  Storage       │        │  Integrations                 │        │
                 │         │  SQLite (WAL)  │◀──────▶│  api/*   (HTTP, websockets)  │◀──▶ internet
                 │         │  raw/ captures │        │  browser/* ─▶ Browser host   │        │
                 │         └────────────────┘        │               (Playwright,   │        │
                 │                                   │                Chrome per    │        │
                 │  Agent CLI (claude | codex) ◀────▶│                profile)      │        │
                 │                                   └──────────────────────────────┘        │
                 └────────────────────────────────────────────────────────────────────────────┘
```

- **bloomd** is the single long-running process, run by the desktop app (§8.7), a launchd agent or a
  terminal. It binds to `127.0.0.1:4320` only.
- The **web UI** is served by bloomd and opened in the desktop app's window (§8.7) or your browser.
- **bt** is the CLI. It is a thin client of the bloomd API: `bt q aapl`, `bt fn AAPL FA`, `bt login
  brokerageA`, `bt src`, `bt jobs`, `bt doctor`.
- **MCP server** (`bt mcp`, stdio). It exposes read-only tools over bloomd's API: quotes, price history,
  the watchlist, the portfolio, sources and jobs. `--evolve` adds EVOLVE's tools (§6.11). ASK and EVOLVE
  give it to the agent, and you can add it to your own Claude Code or Codex.
- **Agent CLI.** bloomd needs Claude Code or Codex for its AI (§10.1). It runs the CLI headless, as a
  child process, for each ASK question and EVOLVE run. Without one it still starts, and Setup (§8.8)
  says what to install.
- **Browser host** runs in-process at first. If Chrome crashes become a problem, it moves to a
  supervised child process.

### 8.2 Function registry

Each function is declared once:

```ts
defineFunction({
  mnemonic: 'FA',
  title: 'Financial analysis',
  scope: 'security',                          // 'global' | 'security' | 'account'
  args: z.object({ period: z.enum(['Q', 'A']).default('Q'), statement: z.enum(['IS','BS','CF','RATIOS']).default('IS') }),
  datasets: ['fundamentals'],
  resolve: async (ctx, sec, args) => view.table(/* ... */),   // returns a typed ViewModel
  ask: { description: 'Financial statements for a company by quarter or year' },
});
```

- `resolve` returns a **ViewModel**, made of typed blocks: `table`, `timeseries`, `quote`, `text`,
  `news-list`, `kv`, `curve`, `chain`.
- Each surface renders the ViewModel in its own way: the UI draws panels, the CLI prints tables or
  sparklines, and ASK and MCP return JSON.
- Supporting a new surface therefore means writing a renderer, not new data code.

### 8.3 Scheduler

- Cron-style schedules with time zones, aware of **exchange calendars**: sessions and holidays for
  NYSE/Nasdaq and B3. B3 includes Carnival and other local holidays.
  - B3 changes its session hours when US daylight saving time starts and ends, while Brazil itself has
    no DST. Session times therefore come from calendar data, not a fixed UTC offset.
- **Catch-up on wake.** When the machine wakes, overdue jobs run once each, not once per missed slot.
  They run in priority order: session probes, holdings, then everything else.
- **Durable queue.** Jobs are persisted in SQLite and survive restarts. Each run records its duration,
  outcome, the strategy used, and links to its raw captures.

### 8.4 Storage

```
~/.bloomterm/
  config.toml                 # sources, priorities, schedules, layouts, alert channels
  bloomterm.db                # SQLite (WAL): all structured data
  raw/<source>/<date>/<job>/  # raw captures (§6.7), 0700
  inbox/<source>/             # drop OFX/CSV/XLSX here for `manual` sources; parsed on arrival
  profiles/finance/           # Chrome user-data dirs, 0700
  profiles/web/
  integrations/<id>/          # yours (§6.11); .history/ keeps every version you approved
  evolve/<id>-<time>/         # EVOLVE runs' folders
  state/integrations.json     # what you approved: each folder's hash, 0600
  logs/
  token                       # local API bearer token, 0600
```

- **SQLite**, via `better-sqlite3`. At personal scale, about 25M daily bars (5k securities × 20 years)
  plus a year of 1-minute bars for watchlists fits comfortably.
- **Parquet/DuckDB** export (`bt export`) for heavy analysis. This is outside the hot path.
- **Secrets.** API keys live in the macOS Keychain or Windows Credential Manager (service `bloomterm`),
  and `config.toml` refers to them as `keychain:massive`.

### 8.5 Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript throughout (pnpm workspace) | One language for daemon, UI, adapters; Playwright is first-class in Node |
| Runtime | Node 22 LTS | Playwright support; Bun isn't a safe bet for Playwright yet |
| Server | Fastify + `ws` | Small, fast, typed |
| DB | SQLite (`better-sqlite3`, WAL), plain SQL migrations tracked with `PRAGMA user_version` | Zero-ops, fast, single file |
| Validation | zod | Shared schemas across adapters, API, ASK tools |
| Browser | Playwright + installed Chrome | Persistent contexts, network interception, downloads, traces |
| UI | React + Vite, TanStack Table + virtualization | Dense tables, fast |
| Charts | TradingView Lightweight Charts (Apache-2.0) for price; uPlot for macro/curves | Purpose-built, small |
| AI | Your Claude Code or Codex CLI, headless (`@bloomterm/agent`) | ASK and EVOLVE now; BRIEF, extraction and tagging later. Runs on your plan, with no API keys |
| Notifications | macOS notifications or Windows toasts; optional ntfy / Pushover / Telegram | Phone alerts |

### 8.6 Repo layout

```
bloomterm/
  apps/
    daemon/        # bloomd: API, router, scheduler, alerts, storage
    web/           # UI
    cli/           # bt (incl. `bt mcp`)
    desktop/       # the Mac app (Tauri, §8.7): shell/ (its own page), src-tauri/ (Rust)
  packages/
    core/          # data model, zod schemas, symbology, ViewModel, function registry
    browser/       # browser host, session machine, guards, adapter SDK, recorder
    agent/         # runs Claude Code / Codex headless: detection, flags, event stream
    integrations/
      EVOLVE.md    # the EVOLVE routine, each run's CLAUDE.md and AGENTS.md
      CLAUDE.md    # how the built-ins are written (AGENTS.md points to it)
      src/sdk.ts   # defineIntegration, the registry checks
      src/sdk-surface.ts  # what `@bloomterm/sdk` gives your integrations
      src/<id>/    # index.ts, README.md, fixtures/, <id>.test.ts: alpaca/ brapi/ coinbase/ bcb/ b3/ ...
  scripts/
    bundle.mjs     # bloomd as one folder, for the app (§8.7)
    fetch-node.sh  # the app's Node, pinned by sha256
  SPEC.md
```

### 8.7 Desktop app

`bloomterm.app` (`apps/desktop`, Tauri 2) is bloomd and the web app as one Mac app. In v0 it's built on
the Mac that runs it, with `make app`: Apple silicon, ad-hoc signed, no updater.

**What's inside.**
- `Contents/MacOS/bloomterm`, the shell (Rust), and `Contents/MacOS/node`: Node 22.22.3, the official
  build, checked against its pinned sha256 (`scripts/fetch-node.sh`).
- `Contents/Resources/bundle/`, made by `scripts/bundle.mjs`:
  - `bt.mjs` and `mcp.mjs`: bt and `bt mcp`, bundled with esbuild;
  - `node_modules/`: better-sqlite3 (only its prebuilt addon for this Mac) and playwright-core, which
    don't bundle;
  - `web/`; `integrations-src/`, the built-ins' sources, which EVOLVE starts from; `EVOLVE.md`;
  - `kit/`: the SDK's sources, zod, @types/node and `tsc`, which your integrations are typechecked
    against (§6.11);
  - `bt`, a launcher to link onto your PATH.
- bloomd finds all of these through `layout()` (`apps/daemon/src/layout.ts`). From a checkout it runs
  the TypeScript sources through tsx; from the bundle, the bundled files on the app's Node.

**bloomd.**
- At launch the app looks for a bloomd for your data folder. `state/bloomd.json` names its port, and
  `/api/health` must answer with the name `bloomd`, since something else can take a port bloomd left.
  If one is running (the LaunchAgent, a terminal), the app uses it, and Quit leaves it running.
- Otherwise it starts its own: the bundle on its Node, with `BLOOMTERM_SUPERVISED=1` and your login
  shell's PATH (so it finds `claude` or `codex`), and the output appended to `logs/bloomd.log`.
- When bloomd exits, the app starts it again: right away on exit code 75, bloomd asking for a restart
  (Restart bloomd, after you approve an EVOLVE run); after a second otherwise. After three crashes in
  a minute it stops, and the window shows why, with the end of the log, until you choose Restart bloomd.
- Quit stops the bloomd it started: SIGTERM (on Windows, which has none, `POST /api/shutdown`), then
  a kill after 8 s.

**The window.**
- It opens on the app's own page ("Starting bloomd…", or what went wrong), then on bloomd's web app
  with a one-time sign-in code, as `bt ui` does. The page keeps its token in the web view's storage.
- It shows only bloomd (127.0.0.1) and that page. Other links open in your browser, `target=_blank`
  ones too.
- The page gets no Tauri API: the app grants no capabilities, so nothing served on 127.0.0.1 can call
  into it.
- The app sets `window.__BLOOMTERM_DESKTOP__` before the page loads. The web app then:
  - saves downloads through bloomd (`POST /api/files/:id/save`, into `~/Downloads`, never over a
    file), since the web view saves nothing itself;
  - points you to the menu bar when it's signed out, instead of `bt ui`;
  - takes `bloomterm:desktop` events from the menu bar: `{ go: '/sources' }`, `{ ask: true }`.
- Files you drop go to the page (Ask's attachments), not to Tauri.
- Closing it hides it. bloomd keeps running, and the app stays in the menu bar and the Dock.

**The menu bar.** Open bloomterm, Ask…, Sources, bloomd's state, Restart bloomd, Open at Login (a
LaunchAgent that starts the app without its window), Quit bloomterm. It runs once: opening it again
shows the window, and `bloomterm --quit` quits the one that's running. On Windows this is the tray
icon's menu, on a right click; a click opens the window.

**Signing.** `make app` signs ad-hoc (`signingIdentity: "-"`), without the hardened runtime, so that
app runs only on the Mac that built it. `NSAppleEventsUsageDescription` is set because bloomd asks
System Events which app is in front, to give focus back after a sign-in window.

**Windows.** The same app in a per-user NSIS installer, unsigned for now, with WebView2 in place of
WebKit and `%LOCALAPPDATA%\bloomterm` as its folder. An installer run over the running app, or the
uninstaller, closes it through Windows' Restart Manager, and that stops its bloomd as Quit does.
GitHub builds the installer on each change to the app (`windows-app.yml`) and
`scripts/windows-smoke.ps1` installs and uses it there.

**Releases, for other Macs** (`make release`, `scripts/release.sh`). Apple silicon only; Intel waits
until someone asks.
- **Signed** with the Developer ID Application certificate in the keychain, under the hardened
  runtime (`tauri.release.conf.json`). `Entitlements.plist` lets Node JIT (`allow-jit`,
  `allow-unsigned-executable-memory`) and send Apple Events. The SQLite addon is signed with the
  same Developer ID before Tauri bundles it, so library validation needs no exception. The script
  checks every native file's team, runtime flag and timestamp, and runs Node with SQLite, before
  sending anything to Apple.
- **Notarized** with `notarytool` (a keychain profile, `bloomterm-notary`), and stapled: the app,
  then the DMG with the app inside (`hdiutil`, plain, with an Applications link).
- **Updates.** Release builds have the `updater` feature (`src/updates.rs`, tauri-plugin-updater).
  30 s after launch and every six hours the app reads `latest.json` from the latest release, downloads
  a newer version in the background, and the menu bar offers Restart to Update (with a notification
  when it was found on its own). The update is a tarball of the stapled app, signed with the
  updater's key (`~/.tauri/bloomterm-updater.key`, its password in the keychain); the app checks it
  against the public key in `tauri.release.conf.json`, and `requireSignedVersion` makes the signature
  name the version, so an old release can't be served as a new one. Restarting stops the bloomd the
  app started (RunEvent::Exit). Losing the private key means installed apps can't update anymore.
- **Published** as a release of this repo (`herval/bloomterm`, or `BLOOMTERM_RELEASES_REPO` for
  your own), tagged `v<version>`: a draft release with `bloomterm.dmg`, `bloomterm.app.tar.gz` and `latest.json`, then
  made public at once. People download `…/releases/latest/download/bloomterm.dmg`.
- A release is the version in `tauri.conf.json`; publishing needs a clean tree, and a version not
  released yet. `--no-publish` stops before the upload, `--no-notarize` after the signature checks.

**Tests.** The UI tests run in headless WebKit too (`pnpm test:webkit`), the engine of the app's web
view, with a block for what changes in the app. The shell's own logic has Rust unit tests
(`cargo test` in `apps/desktop/src-tauri`).

### 8.8 Setup (first run)

On a friend's Mac, the app has to work before the two things bloomterm doesn't ship are there: an
agent CLI (§10.1) and Google Chrome (§6.2). So bloomd **starts without them** and says what's
missing, instead of failing to start.

- **The check** (`apps/daemon/src/setup.ts`) looks at:
  - **The agent CLI.** Is one installed, and which one does bloomd use? bloomd picks it when it
    starts.
  - **Sign-in.** Is that CLI signed in? `claude auth status --json` reports `loggedIn`;
    `codex login status` uses its exit code. bloomd keeps only the yes or no, not the account
    details.
  - **Chrome.** Where it is, found as §6.2 describes.

  It runs when bloomd starts, then again on `POST /api/setup/check`. `GET /api/setup` returns the
  last result.
- **Ready** means:
  - an agent CLI is in use;
  - that CLI isn't known to be signed out (a version that can't say counts as signed in; Ask
    reports it if it isn't);
  - Chrome is found.

  Not ready is a warning in bloomd's log, not an error.
- **An agent CLI installed after bloomd started** needs a restart, since bloomd picks its CLI at
  startup:
  - Supervised (the desktop app, or the LaunchAgent): the check restarts bloomd itself.
  - Otherwise: the page says to restart `bt daemon`.
- **The Setup page** (`/setup`) lists the two steps. Each is done (✓) or shows what to do next:
  - install commands, each with a Copy button;
  - the sign-in command;
  - a Get Chrome link;
  - or, when the config.toml path is wrong, that path.

  The page has **Check again**. The web app opens it by itself **once**, on the first visit while
  setup isn't ready (remembered in the browser). After that, a **Finish setup** chip in the top bar
  links to it until setup is ready. Ask's "no agent" state links to it too.
- **What works meanwhile:** market data, news, watchlists and boards. Ask, the brief, AI news and
  EVOLVE wait for the agent; accounts wait for Chrome.

---

## 9. Alerts

### 9.1 Rule types

| Type | Example command |
|---|---|
| Price level / cross | `ALRT AAPL > 250` · `ALRT EURUSD crosses 1.10` |
| Move | `ALRT NVDA move 5% 1d` · `ALRT PORT move -2% 1d` |
| Volume | `ALRT TSLA vol > 2x avg20` |
| News | `ALRT news "guidance" tickers:PORT` · `ALRT CN AAPL` (any company news) |
| Filings | `ALRT filings 8-K tickers:PORT` |
| Econ | `ALRT ECO CPI surprise > 0.2` |
| Earnings | `ALRT EVTS PORT 1d before` |
| Source health | Built-in: browser source `needs_login` / `blocked`, adapter degraded > 24h |

### 9.2 Engine

- Rules are evaluated on every relevant data event (tick, news item, filing, job completion), with a
  per-rule cooldown.
- Each firing stores a snapshot of the data that triggered it, so `ALRT` history shows *why* it fired.

### 9.3 Delivery

| Channel | When |
|---|---|
| In-terminal alert panel and status bar, with optional sound | Always |
| macOS notification, or a Windows toast | Default on |
| ntfy / Pushover / Telegram push | Opt-in per rule severity |
| Daily digest folded into `BRIEF` | Optional |

---

## 10. AI layer

### 10.1 Your agent CLI

bloomterm needs Claude Code (`claude`) or Codex (`codex`), installed and signed in. It runs them
headless on your own subscription, so there are no model API keys to manage. Without one, bloomd
starts anyway, and Ask, the brief, AI news and EVOLVE wait for it (Setup, §8.8). `bt agent` shows what
it found.

- **Detection.** It looks on PATH and in the usual install dirs. `[agent] cli = "auto" | "claude" |
  "codex"` picks one; `auto` prefers Claude.
- **Isolation.** Runs don't load your own setup, so none of your plugins, hooks or MCP servers come along.
  - Claude: `--setting-sources project,local --strict-mcp-config`, plus `--permission-mode dontAsk`
    with an allowlist.
  - Codex: `--ignore-user-config`, plus a sandbox.
- **Nothing on the command line.** The prompt goes on stdin. Claude's instructions and MCP config go in
  a private folder that lasts as long as the run. Any program can read a command line, and Windows caps
  one at 32,767 characters.
- **Modes.**
  - `chat` (ASK): only bloomterm's MCP tools, plus web search while `[agent] web = true`. Codex runs
    read-only.
  - `evolve` (§6.11): the run's folder, with the limits listed there.
- **Config.** These live under `[agent]` in config.toml:
  - `cli`;
  - `model` (the CLI's default if unset);
  - `web` (default true);
  - `share_portfolio` (default true). When it's false, `get_portfolio` is refused and EVOLVE sees
    bodies as shapes only.
- **Cost.** Usage counts against your Claude or ChatGPT plan. Each answer stores the cost the CLI
  reports, when it reports one.
- **One-shot jobs.** The brief (§10.3), "why it moved", and news grouping and tagging (§10.4) also run
  through the same CLI. They use chat mode, with bloomd putting the data in the prompt. Text from
  pages and news always goes in as data, never as instructions.
- **Later.** The `llm` strategy (§6.6) will too.

### 10.2 ASK

- **One agent run per question.** Follow-ups resume the CLI's own session. Answers stream into the
  ASK panel (or `bt ask`) and are stored in SQLite (`chat`, `chat_message`).
- **Tools.** All read-only:
  - `resolve_security`, `get_quotes`;
  - `get_price_history`: a summary with SMA 50/200 and sampled closes;
  - `get_watchlist`, `get_portfolio`;
  - `get_news`: by security, "what I follow", or a search;
  - `get_sources`, `get_jobs`.

  In a conversation, also the chat tools of §10.5: `list_files`, `read_sheet`, `query_sheet` and
  `write_file` for spreadsheets you attach, and `propose_import` and `connect_account`, which only
  propose a card you click.
- **Context-scoped.** `PETR4 ASK why down?` binds the security. A question asked from a page or panel
  carries what that page or panel shows. Anything that isn't a command is a question, and `?` forces
  one.
- **Answers.**
  - Short Markdown. Small tables render as tables.
  - Commands in backticks (`PETR4 GP 1Y`) are clickable. They open the page, or in the terminal,
    another panel.
  - Securities an answer names show as live tiles (quote, change, sparkline). A `GP` command shows a
    small chart.
  - Any answer can be pinned to Today, and re-asked from there.
- **Never guesses numbers.** Every figure must come from a tool result or a named web search. When data
  is missing, ASK says so and names the source that would have it.

### 10.3 BRIEF and "why it moved"

**The brief** is written by your agent CLI on a schedule (`[brief] cron`, default `0 7 * * 1-5`, local
time or `tz`) and whenever you ask. A failed scheduled run is retried after 30 minutes.

- **Its input.** bloomd assembles the data:
  - the markets strip;
  - your movers;
  - your portfolio, only if `share_portfolio`;
  - the last day's stories on what you follow;
  - what needs attention (sign-ins, failing feeds).
- **Its output.** Short Markdown, with no numbers that aren't in the data. Tickers you follow become
  links.
- **Storage.** It's kept in `insight` (kind `brief`, one per day). Today shows the latest one, along
  with whether it's being rewritten.
- Later: today's econ and earnings calendar; pushing it to your phone or email.

**"Why it moved"** answers per security per day, on demand, from Movers or a security's page.
- The agent gets the move, the benchmark's move (IBOV for B3, SPY for the US), and that day's tagged
  news.
- It answers in a sentence or two and cites the news items it used. Citations that weren't in its
  input are dropped.
- It's kept in `insight` (kind `why`, key `<day>|<security>`).

### 10.4 News intelligence

- **Sources are integrations** (§6.5) that provide `news`. Each is polled on its own interval, and a
  failing one backs off up to an hour.
  - `rss`: Valor, InfoMoney, Brazil Journal, Exame, Money Times, CNBC, MarketWatch.
  - `cvm`: B3 companies' material facts and notices, from RAD.
  - `sec-edgar`: 8-K/10-Q/10-K and more for what you follow. It needs your contact email in Settings
    (`sec-contact`), which SEC requires in the User-Agent.
  - `alpaca`: Benzinga news, when you have Alpaca keys.
- **Ticker tagging,** in three layers:
  - The source's own tags (Alpaca, SEC, CVM).
  - Rules: B3 tickers, `(NYSE: X)`, `$cashtags`, and company names in headlines, in Portuguese or
    English. A company maps to all its share classes ("Petrobras" → PETR3 and PETR4). Summaries are
    tagged by ticker only, to keep teasers from adding false tags.
  - The agent: in batches, after polls that brought new items. Its tags replace the rule tags. Tags
    that aren't real securities are dropped.
- **Stories.** Items about the same event, from several outlets, are grouped by headline similarity
  within 36 hours. The agent then regroups them and writes each story's title and a one-sentence
  summary. News, Today and security pages show stories; the News page also searches single items.
- **On charts.** News and filings tagged with a security show as markers on its chart. Clicking one
  highlights the item.
- Kept 45 days. Not built yet: paywalled full text through the `web` profile.

### 10.5 Files and cards in Ask

**Files.** Attach spreadsheets in Ask (the clip, drag and drop, or paste): `.xlsx .xlsm .xls .ods .csv
.tsv`, up to 25 MB each, up to 10 per question.

- bloomd keeps the bytes under `<home>/files` and reads them once with SheetJS (cached as JSON). The
  agent has no shell or file access in a chat, so it reads files only through `bt mcp`'s chat tools,
  scoped to the conversation the file was sent in, and only while it's answering there.
- CSV and TSV stay text, so Brazilian numbers (`1.234,56`) aren't misread; UTF-8 or Windows-1252 is
  detected. Workbooks keep their numbers and dates.
- Tools:
  - `list_files`: each sheet's size and first rows, as `[row number, A, B, …]`;
  - `read_sheet`: pages of rows, with a text filter;
  - `query_sheet`: picks, renames and types columns (`number` reads `R$ -1.234,56` and `(12.50)`;
    `date` gives `YYYY-MM-DD`, day first by default), filters, sorts, and groups with exact sums and
    counts. The agent is told to use it for every total;
  - `write_file`: a `.csv` (UTF-8 with BOM) or `.xlsx`, from rows or from a query. It shows as a
    download under the answer.
- Cells are your data, never instructions; the prompt says so.
- Uploads never sent with a question are deleted after a day. Deleting a conversation deletes its
  files.

**Cards.** Some tools don't act; they propose. A card shows under the answer, and nothing happens until
you click.

- `propose_import`: positions or balances, validated against the core schemas, with accounts. The card
  previews the rows and totals, and says what it replaces. **Import** saves them as their own snapshot
  (`method: manual`, `confidence: manual`) under the source the agent names, like `itau`. A later fetch
  by that integration replaces it. Account ids that look like account numbers (6+ digits) are refused.
- `connect_account`: connecting a bank, broker or exchange.
  - If bloomterm has a browser integration for it, the card offers **Sign in** (LOGIN) and **Fetch
    now**.
  - If it connects with an API key, the card points to Settings.
  - Otherwise the agent gives the institution's https sign-in page. The card shows its host, and
    **Open sign-in window** opens it in the finance profile, on screen, without recording. You type
    your password and codes there. **Map it with EVOLVE** starts an EVOLVE run (§6.11) for the new
    integration. You review and approve its work; nothing of it runs until you do.
- The agent never asks for, sees or repeats passwords, codes, or card or full account numbers.

---

## 11. Data model (core tables)

All market and account rows carry the provenance columns `source`, `method`
(`api|unofficial|request|download|intercept|dom|llm|manual`), `fetched_at`, `as_of`, `confidence`, and
`raw_ref`.

| Table | Key fields |
|---|---|
| `security` | `id`, `key` (`AAPL US Equity`), `type` (stock/etf/fii/bdr/index/fx/crypto/future/govt/cdb/fund), `name`, `exchange`, `currency`, `figi`, `isin`, `cik` / `cvm_code`, `country`, `sector`, `underlying_id` (BDRs) |
| `symbol_map` | `security_id`, `provider`, `provider_symbol` (e.g. Yahoo `^GSPC`, Massive `I:SPX`) |
| `quote` | `security_id`, `last`, `bid`, `ask`, `chg`, `chg_pct`, `volume`, `ts`, `delay_s` |
| `bar` | `security_id`, `interval`, `ts`, `o`, `h`, `l`, `c`, `v` (PK: security, interval, ts) |
| `fundamental` | `security_id`, `period_end`, `fiscal_period`, `statement`, `item`, `value`, `unit` |
| `filing` | `security_id`, `form`, `filed_at`, `url`, `accession`, `summary` |
| `news_item` | `id` (`source:source_id`), `source`, `ts`, `headline`, `outlet`, `url`, `kind` (news/filing), `lang`, `summary`, `story_id`, `fetched_at`, `ai_at` (when the agent last saw it) |
| `news_tag` | `news_id`, `security` (key), `by` (source/rule/agent) |
| `news_story` | `id`, `title`, `summary`, `by` (rule/agent), `first_ts`, `last_ts` |
| `insight` | `kind` (brief/why), `key` (day, or `day\|security`), `status`, `text`, `data` (JSON: inputs and citations), `error`, `agent`, timestamps |
| `chat_file` | `id`, `chat_id` (null until sent), `seq`, `origin` (upload/agent), `name`, `mime`, `size`, `sheets` (JSON), `error`; bytes in `<home>/files/<id>` |
| `chat_action` | `id`, `chat_id`, `seq`, `kind` (import/connect), `status` (pending/done/dismissed/failed), `data`, `result` (JSON), `error`, timestamps |
| `econ_event` | `country`, `name`, `ts`, `importance`, `consensus`, `prior`, `actual`, `unit` |
| `corp_event` | `security_id`, `type` (earnings/dividend/jcp/split/amortization), `ts`, `details` |
| `macro_obs` | `series_id`, `date`, `value`, `vintage` |
| `account` | `id`, `institution`, `name`, `type` (brokerage/retirement/checking/savings/credit_card/crypto), `currency`, `source` (bound source), `mask` |
| `position` | `account_id`, `security_id` (nullable for unmapped), `raw_symbol`, `qty`, `price`, `value`, `currency`, `cost_basis`, `as_of`; for fixed income: `indexer` (CDI/SELIC/IPCA/PRE), `rate`, `maturity`, `issuer` |
| `balance` | `account_id`, `cash`, `total`, `as_of`; for cards: `statement_balance`, `credit_limit`, `due_date` |
| `txn` | `account_id`, `ts`, `type`, `security_id`, `qty`, `amount`, `description` |
| `alert_rule`, `alert_fire` | rule definition / firing with data snapshot |
| `source_state` | `source`, `session_state`, `last_ok`, `last_error`, `error_streak`, `degraded_strategy` |
| `job` | one row per run, probe or sign-in: `trigger` (manual/schedule/catchup), cron `slot`, `status`, `priority`, duration, strategy used, `error`, `raw_dir` |
| `schedule_state` | `source`, `dataset`, `last_slot` (the last cron slot handled, so missed slots are caught up once) |
| `snapshot` | one per successful fetch: `job_id`, `source`, `kind`, `method`, `confidence`, `fetched_at`, `raw_ref`; `position`/`balance` rows point at it, and the current views read each source's latest snapshot |
| `note` | `security_id`, `body`, `created_at` |
| `layout`, `watchlist` | UI state |

**Unmapped positions.** Holdings the symbology can't resolve (private funds, 401k collective trusts,
most CDBs, LCIs, and LCAs) are stored with `raw_symbol` and counted in `PORT` totals.
- They're valued at what the source reports, and price history isn't shown for them.
- Fixed-income items still get their indexer, rate, and maturity, so the maturity ladder and the
  indexer breakdown in `PORT` work.

---

## 12. Security and privacy

- **Local-only access.**
  - bloomd listens on `127.0.0.1` only.
  - Every request (UI, CLI, MCP) needs a bearer token from `token` (0600).
  - CORS is limited to bloomd's own origin.
  - Remote/phone access (e.g. via Tailscale with an auth proxy) comes in P2.
- **Browser profiles are credentials.** Their directories are `0700`. FileVault is recommended. They are
  excluded from any sync tool. Windows ignores those modes: `~/.bloomterm` is private there because
  your user folder lets in only you, the system and administrators, so a `BLOOMTERM_HOME` outside it
  isn't. `bt profile wipe <name>` signs you out of everything in a profile.
- **API keys** are kept in the Keychain or Credential Manager and never in config or logs. `SET` writes
  them through bloomd (on a Mac with `security -i`, on Windows with a native call, so the value never
  shows in the process list); the API only reports whether each key is set, never its value.
- **UI sign-in.** `bt ui` asks bloomd for a one-time code (60s, single use) and opens
  `http://127.0.0.1:<port>/#code=…`; the page trades it for the token and keeps it in localStorage.
  No cookies, since cookies on 127.0.0.1 are shared by every port. bloomd refuses cross-origin
  requests and serves the UI with a strict CSP and `frame-ancestors 'none'`.
- **Logs** mask account numbers and never contain cookies, headers, or form values.
- **Outbound data.** Market requests go to their sources. Agent runs go to Anthropic or OpenAI through
  your own CLI, under the switches in §10.1. There is no telemetry.
- **Agents.**
  - ASK's tools only read, and ASK has web search but no web fetch, so a prompt injected into a page it
    reads can't carry your data back out through it.
  - EVOLVE never sees credentials (§6.11). Its code runs in bloomd only once you approve exactly its
    files.
- **Read-only.** See the safety rails in §6.8. Nothing in v1 can move money or place orders.

---

## 13. Phasing and acceptance criteria

### P0 — Skeleton

- bloomd with SQLite, the function registry, the router, the scheduler, and the WS API.
- Web UI: command line, 2×2 panels, link groups, `W`, `OV`, `GP`, `SRC`, `JOBS`, `SET`, `HELP`.
- Symbology:
  - US equities, ETFs, and major indices (EDGAR ticker map + OpenFIGI).
  - B3 stocks, FIIs, ETFs, and BDRs (B3 instrument list + COTAHIST).
  - IBOV and IFIX, FX majors plus USDBRL, top crypto.
- Adapters: Alpaca or Massive (US quotes and bars), brapi + COTAHIST (B3), BCB (PTAX, SGS), Coinbase
  (crypto stream), Treasury (curve).
- **Browser layer:** browser host, the `finance` and `web` profiles, the session state machine, `LOGIN`,
  the mutation guard, the credential firewall, raw capture, the adapter SDK (`request`, `download`,
  `intercept`, `dom`), and **one real browser adapter** end to end.
  - **First adapter: B3 Área do Investidor.** One gov.br sign-in and an Excel export cover the B3
    positions at every broker, so it tests the whole browser layer and pays off right away.
- **AI layer:** the agent CLI requirement (§10.1), ASK with `bt mcp`, and EVOLVE (§6.11). EVOLVE is how the
  browser integrations get mapped: `EVOLVE b3` first.

**Done when:**
- `AAPL GP 1Y <GO>` renders from cold in under 1.5s and from cache in under 150ms (p95).
- A streamed quote reaches the screen within 500ms of the provider event.
- One browser source can be signed into via `LOGIN`. Its session survives a daemon restart, and its
  expiry is detected within one probe interval.

### P1 — Daily driver

- `TOP`/`CN`: free RSS, EDGAR, CVM fatos relevantes.
- `DES`, `FA`, `ERN`, `CF`: EDGAR for US, CVM for Brazil.
- `ECO` (FRED/IBGE/BCB plus browser consensus), `ECFC` (Focus), `EVTS`.
- `WEI`/`FX`/`CRYP`/`GC` (incl. DI and IPCA+ curves)/`TD`/`CMDT`/`MOST`, `ECST`.
- `PORT` and `PORT NW` across all your accounts (§7.7), in USD by default:
  - SnapTrade, for the US brokerages it covers.
  - B3 Área do Investidor.
  - Browser adapters for banks and brokers without APIs, easiest sign-in first.
  - Manual import for whatever can't be automated.
- `ALRT` with macOS and push delivery, `NOTE`, `LP`.
- AI: `ASK`, `BRIEF`, news tagging and clustering, and `llm` extraction as fallback.
- MCP server.

**Done when:**
- Every connected account appears in `PORT`. The automated ones are under 8h old on weekdays (the Área do
  Investidor, under 1 business day). Anything on manual import shows its import date.
- Browser jobs succeed at least 95% of the time over a week, excluding sign-in expiries.
- BRIEF arrives by 07:05 on weekdays.
- Every number in ASK answers is traceable to a cited tool result.

### P2 — Depth

- `EQS`, `OMON`, `RV`, `HDS`, `INS`, `EE`, `DVD`, `TXN`, `CB`, `GIP` polish.
- `WATCH` no-code sources.
- EVOLVE proposes itself when a dataset keeps failing (§6.11).
- A global hotkey for the desktop app (§8.7).
- Remote/phone access.
- BDR ↔ underlying comparison in `RV` and `GP` (premium/discount, FX-adjusted).
- Open Finance aggregator adapter (Pluggy/Belvo), if personal use is allowed.

---

## 14. Testing and operations

- **Unit tests.**
  - Parsers are tested against redacted fixtures, one set per adapter.
  - Router ordering and fallback.
  - Alert rules.
  - The command grammar parser.
- **Contract tests.** Every adapter's output is validated against its dataset's zod schema and sanity
  checks, and this runs in CI with fixtures.
- **Live smoke.** `bt doctor [--live] [source]` probes each source's session and runs one cheap fetch per
  dataset, then prints a health table. It can be scheduled nightly, with results going to `SRC`.
- **UI tests.** Playwright drives the web app, served by a real bloomd with fake data and a fake agent
  CLI, in headless Chrome, and in headless WebKit (`pnpm test:webkit`), the desktop app's engine.
- **Observability.**
  - Structured logs (pino).
  - `SRC` shows a 7-day success-rate sparkline for each source and dataset.
  - On failure, the job's Playwright trace is linked from `JOBS`.

---

## 15. Decisions and open questions

### Decided (2026-10-26)

- **Markets:** US + Brazil (B3).
- **Default display currency:** USD, with a BRL toggle.
- **Accounts:** a US brokerage and bank, and Brazilian brokers and banks. No paid news or data
  subscriptions. Routes and build order are in §7.7.

### Decided (2026-10-28)

- **AI runs through your own Claude Code or Codex**, which bloomterm requires, rather than the Anthropic
  API. There are no model API keys, and you pay through your existing plan.
- **Integrations are agent-maintained code (EVOLVE).** The agent writes them, and you approve them.
  (2026-10-30: approvals replaced merging a git branch, so EVOLVE works without a checkout, in the
  desktop app.)
- **Holdings may go to the model** (`share_portfolio = true`). This answers open question 3.
- **The UI is a modern web app,** not a look-alike of a classic terminal:
  - pages with URLs, a sidebar, ⌘K for everything, and Ask beside every page;
  - a dense design, light by default with a dark theme.
  
  The four-panel terminal stays as one board.
- **News, the brief and "why it moved" run through the agent CLI.** bloomd assembles the data.
- **Light is the default theme,** with dark and system as options.
- **Data lives in `~/.bloomterm`** on every platform, not `~/Library/Application Support`.
- **Ask takes spreadsheets, and proposes instead of acting.** bloomd parses files (SheetJS 0.20.3, from
  its official tarball, since the npm `xlsx` package is stale); imports and connecting accounts are
  cards you click. Approving what EVOLVE writes stays manual.

### Decided (2026-10-30)

- **A desktop app, for one Mac first.** `bloomterm.app` is a Tauri shell around bloomd and the web app
  (§8.7), built with `make app` on the Mac that runs it: ad-hoc signed, no updater. Running from a
  checkout keeps working the same way. This answers open question 1.
- **EVOLVE never changes bloomterm.** Its integrations live in `~/.bloomterm/integrations`, run by
  Node's type stripping, and only as you approved them (§6.11).

### Decided (2026-11-01)

- **A notarized DMG that updates itself.** Official releases are signed with the maintainer's
  Developer ID, notarized, and published as releases of `herval/bloomterm`, which is what
  installed apps update from (§8.7). No Mac App Store: its sandbox would block
  driving Chrome, running the agent CLI, `~/.bloomterm` and the LaunchAgent.

### Decided (2026-11-03)

- **Open source, under the MIT License.** Integrations for specific banks and brokers stay out of
  the repo: each person builds their own with EVOLVE, in their data folder.
- **Releases live in the source repo.** No separate releases-only repo: the DMG and the updater's
  files are attached to `herval/bloomterm`'s releases.

### Still open

1. ~~**Form factor.**~~ Decided 2026-10-30: the web app, in a Tauri desktop app (§8.7) or your
   browser.
2. **Data budget.** Free-only, or paid feeds?
   - Free-only means real-time IEX quotes for US stocks and ~30-minute-delayed B3 quotes.
   - Paid options: Alpaca SIP or a Massive tier for full US real-time, and a brapi paid plan for 15- or
     5-minute B3 delay.
3. ~~**AI and portfolio data.**~~ Decided 2026-10-28: yes, behind `share_portfolio`.
4. **Host.** Is a laptop that sleeps (with scrapes catching up on wake) enough, or should
   bloomd run on an always-on machine?
5. **Phone access.** Do you want BRIEF and alerts on your phone only (push), or the full UI over
   Tailscale in P2?
