import { Account, Balance, Position } from '@bloomterm/core';
import { z } from 'zod';
import type { DB } from './db.ts';

export type PersistKind = 'positions' | 'balances' | 'accounts';

export interface SnapshotMeta {
  jobId: string;
  source: string;
  dataset: string;
  method: string;
  confidence: string;
  fetchedAt: string;
  rawRef?: string;
}

const schemas = {
  positions: z.array(Position),
  balances: z.array(Balance),
  accounts: z.array(Account),
} as const;

export interface CurrentPosition extends Position {
  source: string;
  method: string;
  confidence: string;
  fetchedAt: string;
  rawRef: string | null;
}

export interface CurrentBalance extends Balance {
  source: string;
  method: string;
  confidence: string;
  fetchedAt: string;
  rawRef: string | null;
}

/** Positions, balances and accounts, each tied to the job (and so the provenance) that fetched them. */
export class HoldingsRepo {
  constructor(private readonly db: DB) {}

  /** Stores a fetch as a new snapshot. Validates again, since this is the last stop before the DB. */
  save(kind: PersistKind, meta: SnapshotMeta, data: unknown): number {
    const rows = schemas[kind].parse(data);
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO snapshot (job_id, source, kind, dataset, method, confidence, fetched_at, raw_ref, rows)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(meta.jobId, meta.source, kind, meta.dataset, meta.method, meta.confidence, meta.fetchedAt, meta.rawRef ?? null, rows.length);

      const touch = this.db.prepare(
        `INSERT INTO account (source, external_id, first_seen, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source, external_id) DO NOTHING`,
      );
      if (kind === 'positions') {
        const ins = this.db.prepare(
          `INSERT INTO position (job_id, account_external_id, raw_symbol, name, quantity, price, value, currency, cost_basis,
             as_of, indexer, rate, maturity, issuer)
           VALUES (@jobId, @accountExternalId, @rawSymbol, @name, @quantity, @price, @value, @currency, @costBasis,
             @asOf, @indexer, @rate, @maturity, @issuer)`,
        );
        for (const p of rows as Position[]) {
          touch.run(meta.source, p.accountExternalId, meta.fetchedAt, meta.fetchedAt);
          ins.run({
            jobId: meta.jobId,
            name: null,
            price: null,
            costBasis: null,
            asOf: null,
            indexer: null,
            rate: null,
            maturity: null,
            issuer: null,
            ...p,
          });
        }
      } else if (kind === 'balances') {
        const ins = this.db.prepare(
          `INSERT INTO balance (job_id, account_external_id, cash, total, currency, as_of, statement_balance, credit_limit, due_date)
           VALUES (@jobId, @accountExternalId, @cash, @total, @currency, @asOf, @statementBalance, @creditLimit, @dueDate)`,
        );
        for (const b of rows as Balance[]) {
          touch.run(meta.source, b.accountExternalId, meta.fetchedAt, meta.fetchedAt);
          ins.run({ jobId: meta.jobId, cash: null, asOf: null, statementBalance: null, creditLimit: null, dueDate: null, ...b });
        }
      } else {
        const up = this.db.prepare(
          `INSERT INTO account (source, external_id, institution, name, type, currency, mask, first_seen, updated_at)
           VALUES (@source, @externalId, @institution, @name, @type, @currency, @mask, @at, @at)
           ON CONFLICT (source, external_id) DO UPDATE SET institution = excluded.institution, name = excluded.name,
             type = excluded.type, currency = excluded.currency, mask = excluded.mask, updated_at = excluded.updated_at`,
        );
        for (const a of rows as Account[]) up.run({ source: meta.source, at: meta.fetchedAt, mask: null, ...a });
      }
      return rows.length;
    })();
  }

  currentPositions(source?: string): CurrentPosition[] {
    const rows = this.db
      .prepare(`SELECT * FROM current_position ${source ? 'WHERE source = ?' : ''} ORDER BY source, account_external_id, raw_symbol`)
      .all(...(source ? [source] : [])) as any[];
    return rows.map((r) =>
      clean({
        source: r.source,
        accountExternalId: r.account_external_id,
        rawSymbol: r.raw_symbol,
        name: r.name,
        quantity: r.quantity,
        price: r.price,
        value: r.value,
        currency: r.currency,
        costBasis: r.cost_basis,
        asOf: r.as_of,
        indexer: r.indexer,
        rate: r.rate,
        maturity: r.maturity,
        issuer: r.issuer,
        method: r.method,
        confidence: r.confidence,
        fetchedAt: r.fetched_at,
        rawRef: r.raw_ref,
      }),
    );
  }

  currentBalances(source?: string): CurrentBalance[] {
    const rows = this.db
      .prepare(`SELECT * FROM current_balance ${source ? 'WHERE source = ?' : ''} ORDER BY source, account_external_id`)
      .all(...(source ? [source] : [])) as any[];
    return rows.map((r) =>
      clean({
        source: r.source,
        accountExternalId: r.account_external_id,
        cash: r.cash,
        total: r.total,
        currency: r.currency,
        asOf: r.as_of,
        statementBalance: r.statement_balance,
        creditLimit: r.credit_limit,
        dueDate: r.due_date,
        method: r.method,
        confidence: r.confidence,
        fetchedAt: r.fetched_at,
        rawRef: r.raw_ref,
      }),
    );
  }

  accounts(): (Partial<Account> & { source: string; externalId: string; firstSeen: string; updatedAt: string })[] {
    return (this.db.prepare('SELECT * FROM account ORDER BY source, external_id').all() as any[]).map((r) =>
      clean({
        source: r.source,
        externalId: r.external_id,
        institution: r.institution,
        name: r.name,
        type: r.type,
        currency: r.currency,
        mask: r.mask,
        firstSeen: r.first_seen,
        updatedAt: r.updated_at,
      }),
    );
  }
}

/** Drops SQL NULLs so rows match the optional fields of the core schemas. */
function clean<T extends Record<string, unknown>>(o: T): any {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}
