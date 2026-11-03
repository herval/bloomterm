// Schema (SPEC §11). Each entry runs once, in order; PRAGMA user_version records progress.
// Never edit a shipped migration; add a new one.

export const MIGRATIONS: string[] = [
  /* 1: sessions, jobs, schedules, holdings */ `
  CREATE TABLE source_state (
    source       TEXT PRIMARY KEY,
    state        TEXT NOT NULL CHECK (state IN ('unknown','ok','needs_login','challenge','blocked')),
    since        TEXT NOT NULL,
    last_ok      TEXT,
    last_error   TEXT,
    error_streak INTEGER NOT NULL DEFAULT 0
  );

  -- One row per run of anything: a dataset fetch, a sign-in probe, an interactive sign-in.
  CREATE TABLE job (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('run','probe','login')),
    source      TEXT NOT NULL,
    dataset     TEXT,
    trigger     TEXT NOT NULL CHECK (trigger IN ('manual','schedule','catchup')),
    -- The schedule slot a scheduled run was for (NULL for manual runs and first fetches).
    slot        TEXT,
    status      TEXT NOT NULL CHECK (status IN ('queued','running','ok','failed','cancelled')),
    priority    INTEGER NOT NULL DEFAULT 0,
    force       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    method      TEXT,
    error       TEXT,
    attempts    TEXT,
    raw_dir     TEXT,
    result      TEXT
  );
  CREATE INDEX job_queue ON job (status, priority DESC, created_at);
  CREATE INDEX job_source ON job (source, dataset, created_at);

  -- Last schedule slot handled per (source, dataset). '__probe' tracks session probes.
  CREATE TABLE schedule_state (
    source    TEXT NOT NULL,
    dataset   TEXT NOT NULL,
    last_slot TEXT NOT NULL,
    PRIMARY KEY (source, dataset)
  );

  -- A successful fetch of a persisted dataset. Rows below point at it, so every value
  -- carries its provenance, and an empty fetch still replaces the previous one.
  CREATE TABLE snapshot (
    job_id     TEXT PRIMARY KEY REFERENCES job (id),
    source     TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('positions','balances','accounts')),
    dataset    TEXT NOT NULL,
    method     TEXT NOT NULL,
    confidence TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    raw_ref    TEXT,
    rows       INTEGER NOT NULL
  );
  CREATE INDEX snapshot_latest ON snapshot (source, kind, fetched_at);

  CREATE TABLE account (
    source      TEXT NOT NULL,
    external_id TEXT NOT NULL,
    institution TEXT,
    name        TEXT,
    type        TEXT,
    currency    TEXT,
    mask        TEXT,
    first_seen  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (source, external_id)
  );

  CREATE TABLE position (
    job_id              TEXT NOT NULL REFERENCES snapshot (job_id),
    account_external_id TEXT NOT NULL,
    raw_symbol          TEXT NOT NULL,
    name                TEXT,
    quantity            REAL NOT NULL,
    price               REAL,
    value               REAL NOT NULL,
    currency            TEXT NOT NULL,
    cost_basis          REAL,
    as_of               TEXT,
    indexer             TEXT,
    rate                REAL,
    maturity            TEXT,
    issuer              TEXT
  );
  CREATE INDEX position_job ON position (job_id);

  CREATE TABLE balance (
    job_id              TEXT NOT NULL REFERENCES snapshot (job_id),
    account_external_id TEXT NOT NULL,
    cash                REAL,
    total               REAL NOT NULL,
    currency            TEXT NOT NULL,
    as_of               TEXT,
    statement_balance   REAL,
    credit_limit        REAL,
    due_date            TEXT
  );
  CREATE INDEX balance_job ON balance (job_id);

  CREATE VIEW latest_snapshot AS
    SELECT s.* FROM snapshot s
    WHERE s.fetched_at = (SELECT MAX(fetched_at) FROM snapshot x WHERE x.source = s.source AND x.kind = s.kind);

  CREATE VIEW current_position AS
    SELECT s.source, p.*, s.method, s.confidence, s.fetched_at, s.raw_ref
    FROM position p JOIN latest_snapshot s ON s.job_id = p.job_id;

  CREATE VIEW current_balance AS
    SELECT s.source, b.*, s.method, s.confidence, s.fetched_at, s.raw_ref
    FROM balance b JOIN latest_snapshot s ON s.job_id = b.job_id;
  `,

  /* 2: UI layout and watchlists */ `
  CREATE TABLE ui_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,

  /* 3: ASK conversations, run by your agent CLI (SPEC §10.2) */ `
  CREATE TABLE chat (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    agent      TEXT NOT NULL,           -- claude | codex
    session_id TEXT,                    -- the agent's own session, for --resume
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE chat_message (
    chat_id    TEXT NOT NULL REFERENCES chat (id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text       TEXT NOT NULL,
    tools      TEXT NOT NULL DEFAULT '[]', -- JSON: [{name, input, ok}]
    status     TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
    error      TEXT,
    cost_usd   REAL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, seq)
  );
  `,

  /* 4: EVOLVE runs are chats too: the agent rewriting an integration on a branch (SPEC §6.11) */ `
  ALTER TABLE chat ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask' CHECK (kind IN ('ask', 'evolve'));
  ALTER TABLE chat ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'; -- JSON; evolve: {integration, branch, worktree, base, commit}
  `,

  /* 5: news and filings (SPEC §10.4), grouped into stories; and what the agent writes from
        them (the brief, why a security moved) */ `
  CREATE TABLE news_story (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    summary    TEXT,
    by         TEXT NOT NULL DEFAULT 'rule' CHECK (by IN ('rule', 'agent')),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE news_item (
    id         TEXT PRIMARY KEY,           -- <integration>:<the source's id>
    source     TEXT NOT NULL,              -- the integration
    ts         TEXT NOT NULL,              -- published (or first seen)
    headline   TEXT NOT NULL,
    outlet     TEXT NOT NULL,
    url        TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'filing')),
    lang       TEXT,
    summary    TEXT,
    story_id   TEXT REFERENCES news_story (id) ON DELETE SET NULL,
    ai_at      TEXT,                       -- when the agent last grouped and tagged it
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX news_item_ts ON news_item (ts DESC);
  CREATE INDEX news_item_story ON news_item (story_id);
  CREATE TABLE news_tag (
    news_id  TEXT NOT NULL REFERENCES news_item (id) ON DELETE CASCADE,
    security TEXT NOT NULL,
    by       TEXT NOT NULL CHECK (by IN ('source', 'rule', 'agent')),
    PRIMARY KEY (news_id, security)
  );
  CREATE INDEX news_tag_security ON news_tag (security);
  CREATE TABLE insight (
    kind       TEXT NOT NULL CHECK (kind IN ('brief', 'why')),
    key        TEXT NOT NULL,              -- brief: the day; why: <day>|<security key>
    status     TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
    text       TEXT NOT NULL DEFAULT '',
    data       TEXT NOT NULL DEFAULT '{}', -- JSON: what it was written from, the news it cites
    error      TEXT,
    agent      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  );
  `,

  /* 6: files you attach in ASK and files the agent hands back (SPEC §10.5); and what the agent
        proposes for you to confirm: an import, connecting an account */ `
  CREATE TABLE chat_file (
    id         TEXT PRIMARY KEY,           -- f_<hex>; the bytes are files/<id> under the home
    chat_id    TEXT REFERENCES chat (id) ON DELETE CASCADE, -- NULL until sent with a question
    seq        INTEGER,                    -- the message it came with (yours) or from (the agent's)
    origin     TEXT NOT NULL CHECK (origin IN ('upload', 'agent')),
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    sheets     TEXT NOT NULL DEFAULT '[]', -- JSON: [{name, rows, cols, truncated}] for a spreadsheet
    error      TEXT,                       -- why it couldn't be read
    created_at TEXT NOT NULL
  );
  CREATE INDEX chat_file_chat ON chat_file (chat_id, seq);
  CREATE TABLE chat_action (
    id         TEXT PRIMARY KEY,           -- a_<hex>
    chat_id    TEXT NOT NULL REFERENCES chat (id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,           -- the answer that proposed it
    kind       TEXT NOT NULL CHECK (kind IN ('import', 'connect')),
    status     TEXT NOT NULL CHECK (status IN ('pending', 'done', 'dismissed', 'failed')),
    data       TEXT NOT NULL,              -- JSON: what it proposes
    result     TEXT NOT NULL DEFAULT '{}', -- JSON: what you did with it, step by step
    error      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX chat_action_chat ON chat_action (chat_id, seq);
  `,
];
