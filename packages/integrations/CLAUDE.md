# Integrations: the built-ins

This package holds bloomterm's built-in integrations, one folder each under `src/`, and the
SDK every integration is written against. SPEC.md §6.11 has the design.

The contract, the hard rules and the routine for building or fixing an integration are in
[EVOLVE.md](./EVOLVE.md). EVOLVE runs get it as their CLAUDE.md, in a folder of their own
under `~/.bloomterm/evolve`, and their work lands in `~/.bloomterm/integrations` once the
owner approves it. Nothing EVOLVE does changes this repo.

Working on a built-in here, by hand or with an agent, follows EVOLVE.md too, with these
differences:

- **Imports.** Built-ins import from the packages (`../sdk.ts`, `../http.ts`, `../text.ts`,
  `@bloomterm/core`, `@bloomterm/browser`) rather than `@bloomterm/sdk`. EVOLVE copies them
  into your data folder with those imports pointed at `@bloomterm/sdk`, so use only names
  `src/sdk-surface.ts` exports (a test checks), and only erasable TypeScript.
- **Tests** go in `test/`, with vitest. Run `pnpm vitest run packages/integrations` and
  `pnpm typecheck`.
- **Registry.** A new integration gets one import and one entry in `src/index.ts`, in the
  `checkRegistry([...])` list. For market data the order matters: the first feed that
  supports a security serves it.
- **Nothing personal in git** (hard rule 4): fixtures are scrubbed, and no HAR, cookie, raw
  capture or screenshot is ever committed.
- **SDK changes.** Anything an integration may import goes through `src/sdk-surface.ts`
  (`@bloomterm/sdk`). Adding a name there is fine; renaming or removing one breaks the
  owner's integrations in `~/.bloomterm/integrations`.
