# bloomterm

Downloads of bloomterm for Mac. The source is at [herval/bloomterm](https://github.com/herval/bloomterm), under the MIT License.

**[Download bloomterm.dmg](https://github.com/herval/bloomterm-releases/releases/latest/download/bloomterm.dmg)** · [All releases](https://github.com/herval/bloomterm-releases/releases)

bloomterm is a personal, keyboard-first market app: quotes, charts, news and your own accounts in
one place, with Ask, a chat over all of it that runs on your own Claude Code or Codex.

## What your Mac needs

- Apple silicon (M1 or later) and macOS 13 or later
- Google Chrome
- Claude Code or Codex, installed and signed in:
  `npm i -g @anthropic-ai/claude-code && claude` (or `npm i -g @openai/codex && codex login`)

If something's missing, bloomterm opens Setup the first time, shows what to do, and checks again
when you've done it.

## Installing

Open the DMG and drag bloomterm to Applications. It lives in the menu bar: closing the window
keeps it running. It updates itself: when a new version is ready, the menu bar offers Restart to
Update.

Your data stays on your Mac, in `~/.bloomterm`. bloomterm only reads your accounts: it can't place
orders or move money. Nothing in it is financial advice.
