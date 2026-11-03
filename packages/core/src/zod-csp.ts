import { z } from 'zod';

// The UI runs under a CSP without 'unsafe-eval'. zod's compiled parsers probe for eval, and
// the probe shows up as a CSP violation in the console; the plain parsers are fine there.
// Imported first by web.ts, so it's set before any schema is built.
z.config({ jitless: true });
