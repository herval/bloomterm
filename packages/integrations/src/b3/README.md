# b3

B3 Área do Investidor: your B3 positions at every broker, through one gov.br sign-in.

## Access

`browser`, profile `finance`. Plain HTTP to the site gets a 403 from its WAF, so everything goes
through your signed-in browser. You sign in with `LOGIN b3` (gov.br, usually with 2FA);
bloomterm never sees the password.

Endpoints: not mapped yet. Run the EVOLVE routine (`bt evolve b3`, see ../../EVOLVE.md) with a
signed-in session to find the JSON calls the site makes, and replace the placeholder strategy.

## Provides

- browser dataset `positions` (D-1), persisted to the positions table. Placeholder until mapped.

## Limits

- Nothing is mapped yet, so it's a draft and never scheduled.
- B3 publishes positions D-1: today's trades show tomorrow.
- The site's security check can stop a browser it thinks is automated; bloomterm doesn't get
  around it. Sign in with `bt profile open finance` (plain Chrome) if it does.

## Verified

Not yet: draft. The sign-in flow works; the data calls need a signed-in session to map.
