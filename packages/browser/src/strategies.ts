import { z } from 'zod';
import { AllStrategiesFailedError, isTerminal, MutationBlockedError, ValidationError, type StrategyAttempt } from './errors.ts';
import type { Violation } from './guard.ts';
import type { DatasetDef, LlmExtractor, StrategyContext, StrategyKind } from './types.ts';

export interface StrategyRun<T> {
  data: T;
  method: StrategyKind;
  attempts: StrategyAttempt[];
}

/**
 * Tries a dataset's strategies in order (SPEC §6.6). The first output that passes the
 * schema and the checks wins. Terminal errors (sign-in, challenge, guard violations)
 * stop the run, since another strategy can't fix them.
 */
export async function runStrategies<T>(
  name: string,
  ds: DatasetDef<T>,
  ctx: StrategyContext,
  deps: { llm?: LlmExtractor; violations: () => Violation[] },
): Promise<StrategyRun<T>> {
  const attempts: StrategyAttempt[] = [];
  for (const s of ds.strategies) {
    const t0 = Date.now();
    try {
      let out: unknown;
      if (s.kind === 'llm') {
        if (!deps.llm) throw new Error('no LLM extractor configured');
        await s.prepare?.(ctx);
        const snapshot = await ctx.snapshot();
        out = await deps.llm.extract({ prompt: s.prompt, jsonSchema: z.toJSONSchema(ds.schema as z.ZodType), snapshot });
      } else {
        out = await s.run(ctx);
      }
      throwIfViolated(deps.violations());
      const parsed = ds.schema.safeParse(out);
      if (!parsed.success) throw new ValidationError(`output doesn't match the ${name} schema: ${parsed.error.message}`, parsed.error.issues);
      for (const check of ds.checks ?? []) {
        const r = check(parsed.data);
        if (r !== true) throw new ValidationError(`check failed: ${r}`, r);
      }
      attempts.push({ kind: s.kind, ok: true, durationMs: Date.now() - t0 });
      return { data: parsed.data, method: s.kind, attempts };
    } catch (err) {
      // An aborted request usually surfaces as a network error; report the violation instead.
      const violations = deps.violations();
      const e = violations.length ? violationError(violations) : err;
      attempts.push({ kind: s.kind, ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 });
      if (isTerminal(e)) throw Object.assign(e as Error, { attempts });
    }
  }
  throw new AllStrategiesFailedError(attempts);
}

function violationError(v: Violation[]): MutationBlockedError {
  const first = v[0]!;
  return new MutationBlockedError(first.method, first.url, first.reason);
}

function throwIfViolated(v: Violation[]): void {
  if (v.length) throw violationError(v);
}
