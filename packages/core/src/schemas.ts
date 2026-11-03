import { z } from 'zod';

// Shared dataset schemas (SPEC §11). Adapters validate their output against these.

export const Method = z.enum(['api', 'unofficial', 'request', 'download', 'intercept', 'dom', 'llm', 'manual']);
export type Method = z.infer<typeof Method>;

export const Provenance = z.object({
  source: z.string(),
  dataset: z.string(),
  method: Method,
  fetchedAt: z.string(),
  asOf: z.string().optional(),
  confidence: z.enum(['high', 'llm', 'manual']),
  rawRef: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Currency = z.string().regex(/^[A-Z]{3}$/);

export const AccountType = z.enum(['brokerage', 'retirement', 'checking', 'savings', 'credit_card', 'crypto']);

export const Account = z.object({
  externalId: z.string(),
  institution: z.string(),
  name: z.string(),
  type: AccountType,
  currency: Currency,
  /** Last 4 digits only; never the full account number. */
  mask: z.string().max(4).optional(),
});
export type Account = z.infer<typeof Account>;

export const Indexer = z.enum(['CDI', 'SELIC', 'IPCA', 'PRE']);

export const Position = z.object({
  accountExternalId: z.string(),
  rawSymbol: z.string(),
  name: z.string().optional(),
  quantity: z.number(),
  price: z.number().optional(),
  value: z.number(),
  currency: Currency,
  costBasis: z.number().optional(),
  asOf: z.string().optional(),
  // Fixed income (CDB/LCI/LCA/Tesouro)
  indexer: Indexer.optional(),
  rate: z.number().optional(),
  maturity: z.string().optional(),
  issuer: z.string().optional(),
});
export type Position = z.infer<typeof Position>;

export const Balance = z.object({
  accountExternalId: z.string(),
  cash: z.number().optional(),
  total: z.number(),
  currency: Currency,
  asOf: z.string().optional(),
  // Credit cards
  statementBalance: z.number().optional(),
  creditLimit: z.number().optional(),
  dueDate: z.string().optional(),
});
export type Balance = z.infer<typeof Balance>;
