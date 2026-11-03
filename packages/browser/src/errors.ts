export class BrowserLayerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The site wants a fresh sign-in. Moves the source to `needs_login`. */
export class NeedsLoginError extends BrowserLayerError {}

/** 2FA, CAPTCHA or an interstitial appeared mid-job. Moves the source to `challenge`. */
export class ChallengeError extends BrowserLayerError {}

/** A bot wall or a 403/429 streak. Moves the source to `blocked`; bloomterm never tries to get past it. */
export class BlockedError extends BrowserLayerError {}

/** A job tried a request that could change account state (SPEC §6.8). */
export class MutationBlockedError extends BrowserLayerError {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly reason: string,
  ) {
    super(`blocked ${method} ${url}: ${reason}`);
  }
}

/** Adapter code touched a password or one-time-code field. */
export class CredentialFirewallError extends BrowserLayerError {}

/** Adapter code clicked something named like buy/sell/transfer/pay. */
export class DeniedActionError extends BrowserLayerError {}

export class ValidationError extends BrowserLayerError {
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
  }
}

export interface StrategyAttempt {
  kind: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export class AllStrategiesFailedError extends BrowserLayerError {
  constructor(readonly attempts: StrategyAttempt[]) {
    super(`all strategies failed: ${attempts.map((a) => `${a.kind}: ${a.error}`).join('; ')}`);
  }
}

export class RateLimitedError extends BrowserLayerError {}

/** There's no Google Chrome to drive (chrome.ts says where bloomterm looks). */
export class ChromeNotFoundError extends BrowserLayerError {
  constructor(readonly configured?: string) {
    super(
      configured
        ? `Google Chrome isn't at ${configured} ([browser] chrome in config.toml)`
        : "Google Chrome isn't installed: bloomterm signs in to your accounts in it. Get it at https://www.google.com/chrome/",
    );
  }
}

/**
 * Errors that stop a job outright. Falling back to another strategy can't fix them,
 * and some (guard violations) mean the adapter itself is wrong.
 */
export function isTerminal(err: unknown): boolean {
  return (
    err instanceof NeedsLoginError ||
    err instanceof ChallengeError ||
    err instanceof BlockedError ||
    err instanceof MutationBlockedError ||
    err instanceof CredentialFirewallError ||
    err instanceof DeniedActionError ||
    err instanceof ChromeNotFoundError
  );
}
