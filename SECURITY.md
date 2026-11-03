# Security

bloomterm holds live sessions for your bank and brokerage accounts, so security reports matter
more here than in most side projects.

## Reporting a vulnerability

Please report it privately: on GitHub, **Security → Report a vulnerability** on this repo. Don't
open a public issue, and don't post details anywhere public until a fix is out.

Include what you found, how to reproduce it, and what an attacker gets. bloomterm has one
maintainer: expect an answer within a week, and a fix as soon as one is ready.

## Supported versions

The latest release, and `main`. Older releases update themselves; fixes aren't backported.

## In scope

Anything that breaks what bloomterm promises (README, "Safety rails"; SPEC §6.8 and §8):

- A web page, another app or another user on the Mac reaching bloomd's API without its token
  (DNS rebinding, CORS, a leaked token).
- Reading browser sessions, cookies, API keys from the Keychain, or anything in `~/.bloomterm`
  from outside your user account.
- An integration, an EVOLVE run or an agent writing to an account (getting past the mutation
  guard, the click deny-list or the credential firewall), or seeing credentials that should be
  redacted.
- Code running that you didn't approve: an EVOLVE change that runs before you approve it, or an
  approved integration whose files changed and still runs.
- Prompt injection through news, filings, spreadsheets or site data that makes Ask or EVOLVE act
  outside its tools.
- The desktop app's updater accepting a build that isn't signed with the release key.

## Out of scope

- Attacks that need your user account or admin rights already: they can read your Chrome profile
  anyway.
- An integration you approved doing what its code says.
- Security problems in the sites bloomterm reads, in Chrome, or in Claude Code or Codex: report
  those to their owners.
