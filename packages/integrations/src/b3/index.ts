import { defineBrowserAdapter, z } from '@bloomterm/browser';
import { Position } from '@bloomterm/core';
import { defineIntegration } from '../sdk.ts';

// B3 Área do Investidor (SPEC §7.7, first adapter).
//
// DRAFT: written without access to a signed-in session. The sign-in flow works
// (you confirm with the banner button); the logged-out heuristic and the positions
// export still need a recording: `pnpm bt record finance https://www.investidor.b3.com.br/`.
// Plain HTTP to the site gets a 403 (WAF), so everything goes through the browser.

const LOGGED_OUT_URL = /login|signin|b2clogin|sso\.acesso\.gov\.br|autenticacao/i;

const adapter = defineBrowserAdapter({
  id: 'b3',
  name: 'B3 Área do Investidor',
  profile: 'finance',
  status: 'draft',
  origins: ['https://*.b3.com.br'],
  minIntervalMs: 10_000,
  maxJobsPerHour: 6,
  login: {
    url: 'https://www.investidor.b3.com.br/',
    async check({ openPage }) {
      // While you're signing in there's no background tab; the banner button confirms instead.
      if (!openPage) return false;
      const page = await openPage();
      await page.goto('https://www.investidor.b3.com.br/', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return new URL(page.url()).hostname === 'www.investidor.b3.com.br' && !LOGGED_OUT_URL.test(page.url());
    },
  },
  datasets: {
    positions: {
      schema: z.array(Position),
      persist: 'positions',
      freshness: '1d',
      // B3 publishes D-1 positions; once each business morning is plenty. Inactive while the adapter is a draft.
      schedule: { cron: '0 9 * * 1-5', tz: 'America/Sao_Paulo' },
      strategies: [
        {
          kind: 'download',
          async run() {
            throw new Error('b3.positions is not built yet: record a signed-in session first (pnpm bt record finance https://www.investidor.b3.com.br/)');
          },
        },
      ],
    },
  },
});

export default defineIntegration({
  id: 'b3',
  name: 'B3 Área do Investidor',
  covers: 'your B3 positions at every broker (D-1), through your gov.br sign-in',
  access: 'browser',
  status: 'draft',
  docs: 'https://www.investidor.b3.com.br/',
  browser: adapter,
});
