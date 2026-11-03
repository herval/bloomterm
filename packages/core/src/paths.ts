import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root of everything bloomterm keeps on disk (SPEC §8.4): ~/.bloomterm.
 * `BLOOMTERM_HOME` overrides it, which tests use to stay out of the real one.
 */
export function bloomtermHome(): string {
  return process.env.BLOOMTERM_HOME || join(homedir(), '.bloomterm');
}

export const homePaths = (home: string) => ({
  profiles: join(home, 'profiles'),
  profile: (name: string) => join(home, 'profiles', name),
  raw: join(home, 'raw'),
  state: join(home, 'state'),
  inbox: (source: string) => join(home, 'inbox', source),
  records: join(home, 'raw', '_records'),
  /** What you attach in ASK, and what the agent writes back (SPEC §10.5). */
  files: join(home, 'files'),
});
