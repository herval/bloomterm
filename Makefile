# bloomterm: set up, build and run everything (README.md has the details).
#   make install   check prerequisites, install dependencies
#   make run       build the web app if needed, start bloomd, open the UI
#   make dev       bloomd plus the web app with hot reload
#   make app       the desktop app, bloomterm.app (needs Rust: https://rustup.rs)

SHELL := /bin/bash
.DEFAULT_GOAL := help

BT := node_modules/.bin/tsx apps/cli/src/main.ts
CHROME := /Applications/Google Chrome.app
DEV_URL := http://localhost:5173
APP := apps/desktop/src-tauri/target/release/bundle/macos/bloomterm.app

# pnpm rewrites this on every install, so it stands in for "dependencies are installed".
DEPS := node_modules/.modules.yaml
WEB := apps/web/dist/index.html
WEB_SRC := $(shell find apps/web/src apps/web/public packages/core/src -type f 2>/dev/null) apps/web/index.html apps/web/vite.config.ts

# Waits for bloomd (pid in $bloomd) to answer and puts a one-time sign-in link from `bt ui` in
# $link. Fails if bloomd exits first.
wait_for_bloomd = until link=$$($(BT) ui --print 2>/dev/null); do kill -0 $$bloomd 2>/dev/null || exit 1; sleep 1; done

.PHONY: help check install build run dev daemon ui status logs daemon-install daemon-uninstall \
	app app-install release release-build test test-unit test-webkit test-headed typecheck chrome-stop screenshot clean

help: ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{ printf "  make %-17s %s\n", $$1, $$2 }'

check: ## check prerequisites: Node 22+, pnpm, Google Chrome, Claude Code or Codex
	@ok=1; \
	v=$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); \
	if [ "$$v" -ge 22 ]; then echo "✓ node $$(node -v)"; else echo "✗ Node 22+ is needed"; ok=0; fi; \
	if command -v pnpm >/dev/null; then echo "✓ pnpm $$(pnpm -v)"; else echo "✗ pnpm: corepack enable pnpm"; ok=0; fi; \
	if [ -d "$(CHROME)" ] || [ -d "$$HOME$(CHROME)" ] || \
	  mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" 2>/dev/null | grep -v -e '/.Trash/' -e '^/Volumes/Google Chrome' | grep -q .; \
	then echo "✓ Google Chrome"; else echo "✗ Google Chrome: https://www.google.com/chrome/"; ok=0; fi; \
	agents=$$(for a in claude codex; do command -v $$a >/dev/null && printf ' %s' $$a; done); \
	if [ -n "$$agents" ]; then echo "✓ agent CLI:$$agents"; \
	else echo "✗ no agent CLI: npm i -g @anthropic-ai/claude-code && claude  (or: npm i -g @openai/codex && codex login)"; ok=0; fi; \
	[ $$ok = 1 ]

install: check ## check prerequisites and install dependencies
	pnpm install
	@touch $(DEPS)

$(DEPS): package.json pnpm-lock.yaml pnpm-workspace.yaml $(wildcard apps/*/package.json packages/*/package.json)
	pnpm install
	@touch $@

build: $(WEB) ## build the web app (apps/web/dist), which bloomd serves

$(WEB): $(DEPS) $(WEB_SRC)
	pnpm build:web

run: $(WEB) ## build the web app if needed, start bloomd, open the UI at :4320 (Ctrl-C stops it)
	@bloomd=$$$$; ( $(wait_for_bloomd); echo "bloomterm: opening $$link"; open "$$link" ) & exec $(BT) daemon

# Vite starts once bloomd is up, so its proxy goes to the port bloomd took (config.toml can move it).
dev: $(DEPS) ## bloomd plus the web app with hot reload at localhost:5173 (Ctrl-C stops both)
	@$(BT) daemon & bloomd=$$!; \
	trap 'kill $$bloomd 2>/dev/null; wait $$bloomd' EXIT; \
	$(wait_for_bloomd); \
	port=$$(sed -E 's|^http://[^/]*:([0-9]+)/.*|\1|' <<< "$$link"); \
	url=$$(sed -E 's|^http://[^/]+|$(DEV_URL)|' <<< "$$link"); \
	( until curl -sfo /dev/null $(DEV_URL); do kill -0 $$bloomd 2>/dev/null || exit 0; sleep 0.3; done; \
	  echo "bloomterm: opening $$url"; open "$$url" ) & \
	cd apps/web && BLOOMD_PORT=$$port node_modules/.bin/vite --strictPort

daemon: $(DEPS) ## run bloomd in the foreground without opening the UI
	@exec $(BT) daemon

ui: ## open the UI, signed in (bloomd must be running)
	@$(BT) ui

status: ## is bloomd up, what's running, session states
	@$(BT) status

logs: ## follow the log of the LaunchAgent bloomd
	tail -F "$${BLOOMTERM_HOME:-$$HOME/.bloomterm}/logs/bloomd.log"

daemon-install: $(WEB) ## run bloomd at every login (LaunchAgent); starts it now
	@$(BT) daemon install

daemon-uninstall: ## remove the LaunchAgent
	@$(BT) daemon uninstall

# bloomd bundled (scripts/bundle.mjs), the pinned Node (scripts/fetch-node.sh), then Tauri.
app: $(WEB) ## build the desktop app, ad-hoc signed, for this Mac only
	@command -v cargo >/dev/null || { echo "make app needs Rust: https://rustup.rs"; exit 1; }
	node scripts/bundle.mjs
	scripts/fetch-node.sh
	cd apps/desktop && node_modules/.bin/tauri build --bundles app
	@echo "bloomterm: built $(APP)"

app-install: app ## build the desktop app and put it in /Applications
	rm -rf /Applications/bloomterm.app
	cp -R "$(APP)" /Applications/
	@echo "bloomterm: installed /Applications/bloomterm.app"

# For other Macs: Developer ID, notarized, a DMG and the updater's files (scripts/release.sh).
release: $(DEPS) ## build, sign, notarize and publish v<version in tauri.conf.json>
	scripts/release.sh

release-build: $(DEPS) ## the same, without publishing: dist/release/<version>/
	scripts/release.sh --no-publish

test: $(DEPS) ## all tests: unit plus headless Chrome (shared, left running)
	pnpm test

test-unit: $(DEPS) ## unit tests only
	pnpm test:unit

test-webkit: $(DEPS) ## the UI tests in headless WebKit, the desktop app's engine
	pnpm test:webkit

test-headed: $(DEPS) ## browser tests in real Chrome windows (~20s)
	BLOOMTERM_HEADED_TESTS=1 pnpm vitest run --project headed

typecheck: $(DEPS) ## tsc over everything, web app included
	pnpm typecheck

chrome-stop: ## quit the shared test Chrome
	pnpm test:chrome:stop

screenshot: $(DEPS) ## the README's screenshots, on demo data, in the shared test Chrome → docs/
	node_modules/.bin/tsx apps/web/scripts/screenshot.ts

clean: ## remove the built web app, the bundle and the desktop app's build
	rm -rf apps/web/dist dist apps/desktop/src-tauri/target
