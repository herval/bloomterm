import { isUtf8 } from 'node:buffer';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { homePaths } from '@bloomterm/core';
import type { Logger } from '@bloomterm/browser';
import { checkRegistry, folderHash, importIntegration, type Integration } from '@bloomterm/integrations';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { copyBuiltin, INTEGRATION_ID, type EvolveFrom } from './evolve/workspace.ts';
import { layout } from './layout.ts';

// Your integrations (SPEC §6.11): folders in <home>/integrations, from EVOLVE or by hand.
// One runs only if you approved exactly its files: bloomd keeps the hash of the version you
// approved, and a copy of it in .history/<id>/. A folder whose files changed since stays off
// (the built-in runs instead, if there is one) until you approve it again. Yours replaces the
// built-in with the same id; a new id is added after the built-ins.

export interface Approval {
  hash: string;
  at: string;
  /** The EVOLVE run it came from, if any. */
  run?: string;
}

export type LocalState = 'on' | 'changed' | 'unapproved' | 'error';

export interface LocalIntegration {
  id: string;
  /** on: approved as it is. changed: edited since you approved it. unapproved: never approved. error: approved, but it didn't load. */
  state: LocalState;
  /** The files' hash now. */
  hash: string;
  approved: Approval | null;
  /** It replaces a built-in. */
  replaces: boolean;
  /** bloomd runs this version now; an approval takes effect at the next restart. */
  running: boolean;
  error?: string;
}

export class LocalIntegrations {
  readonly root: string;
  private readonly approvalsFile: string;
  /** Load errors from the last `load()`, by id. */
  private errors = new Map<string, string>();
  /** What `load()` loaded from your folder, by id, with the hash it loaded: these run instead of (or besides) the built-ins. */
  readonly loaded = new Map<string, string>();

  constructor(private readonly o: { home: string; builtins: readonly Integration[]; log: Logger }) {
    this.root = join(o.home, 'integrations');
    this.approvalsFile = join(homePaths(o.home).state, 'integrations.json');
  }

  private dir = (id: string) => join(this.root, id);
  private history = (id: string) => join(this.root, '.history', id);
  private isBuiltin = (id: string) => this.o.builtins.some((b) => b.id === id);

  private async approvals(): Promise<Record<string, Approval>> {
    const text = await readFile(this.approvalsFile, 'utf8').catch(() => null);
    return text ? JSON.parse(text) : {};
  }

  private async saveApprovals(a: Record<string, Approval>): Promise<void> {
    await mkdir(homePaths(this.o.home).state, { recursive: true, mode: 0o700 });
    await writeFile(this.approvalsFile, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 });
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Node reads the .ts files here as ES modules.
    const pkg = join(this.root, 'package.json');
    if (!existsSync(pkg)) await writeFile(pkg, '{ "type": "module", "private": true }\n');
  }

  private async ids(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && INTEGRATION_ID.test(e.name)).map((e) => e.name).sort();
  }

  /** Every folder in <home>/integrations and whether it runs. */
  async list(): Promise<LocalIntegration[]> {
    const approvals = await this.approvals();
    return Promise.all(
      (await this.ids()).map(async (id) => {
        const hash = await folderHash(this.dir(id));
        const approved = approvals[id] ?? null;
        const error = this.errors.get(id);
        const state: LocalState = !approved ? 'unapproved' : approved.hash !== hash ? 'changed' : error ? 'error' : 'on';
        return { id, state, hash, approved, replaces: this.isBuiltin(id), running: this.loaded.get(id) === hash, ...(state === 'error' ? { error } : {}) };
      }),
    );
  }

  /** The built-ins with your approved integrations in place: what bloomd runs. */
  async load(): Promise<Integration[]> {
    await this.ensureRoot();
    this.errors.clear();
    this.loaded.clear();
    let list: Integration[] = [...this.o.builtins];
    for (const l of await this.list()) {
      if (l.state === 'unapproved' || l.state === 'changed') {
        this.o.log.warn(`not loading your integration ${l.id}: ${l.state === 'changed' ? 'its files changed since you approved them' : "you haven't approved it"}`, { id: l.id });
        continue;
      }
      try {
        const mine = await importIntegration(this.dir(l.id), l.id);
        const next = this.isBuiltin(l.id) ? list.map((i) => (i.id === l.id ? mine : i)) : [...list, mine];
        list = [...checkRegistry(next)];
        this.loaded.set(l.id, l.hash);
        this.o.log.info(`loaded your integration ${l.id}`, { id: l.id, replaces: l.replaces });
      } catch (err) {
        this.errors.set(l.id, (err as Error).message);
        this.o.log.error(`your integration ${l.id} didn't load`, { id: l.id, error: (err as Error).message });
      }
    }
    return list;
  }

  /** Where an EVOLVE run of `id` starts: your folder, the built-in's source, or nothing. */
  source(id: string): EvolveFrom {
    if (existsSync(join(this.dir(id), 'index.ts'))) return { from: 'yours', dir: this.dir(id) };
    const builtin = join(layout().integrationsSrc, id);
    if (this.isBuiltin(id) && existsSync(builtin)) return { from: 'built-in', dir: builtin };
    return { from: 'new' };
  }

  /** The built-in ids whose sources there are, for EVOLVE's examples. */
  builtinSources(): string[] {
    return this.o.builtins.map((b) => b.id).filter((id) => existsSync(join(layout().integrationsSrc, id)));
  }

  /**
   * Approves `src`'s files as `id`: copies them into <home>/integrations/<id> (unless that's
   * `src`), keeps a copy under .history, and records their hash. Files there you edited and
   * never approved are kept in .history as before-<time>. Takes effect when bloomd restarts.
   */
  async approve(id: string, src: string, o: { hash?: string; run?: string } = {}): Promise<Approval> {
    if (!INTEGRATION_ID.test(id)) throw new Error(`bad integration id "${id}"`);
    await this.ensureRoot();
    const hash = await folderHash(src);
    if (o.hash && o.hash !== hash) throw new Error(`${id}'s files changed since you looked at them; review the diff again`);
    const dest = this.dir(id);
    const approvals = await this.approvals();
    if (src !== dest) {
      await this.setAside(id, approvals[id]);
      await cp(src, dest, { recursive: true });
    }
    const snapshot = join(this.history(id), hash.slice(0, 12));
    if (!existsSync(snapshot)) await cp(dest, snapshot, { recursive: true });
    const approval: Approval = { hash, at: new Date().toISOString(), ...(o.run ? { run: o.run } : {}) };
    await this.saveApprovals({ ...approvals, [id]: approval });
    return approval;
  }

  /** Takes your folder out (the built-in, if any, comes back at the next restart). Its versions stay in .history. */
  async remove(id: string): Promise<void> {
    const approvals = await this.approvals();
    if (!existsSync(this.dir(id)) && !approvals[id]) throw new Error(`you have no integration "${id}"`);
    await this.setAside(id, approvals[id]);
    delete approvals[id];
    await this.saveApprovals(approvals);
  }

  /** Moves the folder out of the way: deleted if it's a version you approved (.history has it), kept as before-<time> if not. */
  private async setAside(id: string, approval: Approval | undefined): Promise<void> {
    const dest = this.dir(id);
    if (!existsSync(dest)) return;
    const hash = await folderHash(dest);
    if (approval?.hash === hash || existsSync(join(this.history(id), hash.slice(0, 12)))) {
      await rm(dest, { recursive: true, force: true });
      return;
    }
    await mkdir(this.history(id), { recursive: true });
    await rename(dest, join(this.history(id), `before-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  }

  /**
   * What approving `target` would change: a unified diff against your approved version, or
   * the built-in's source (as it would look in your folder), or nothing.
   */
  async diff(id: string, target: string): Promise<{ base: 'yours' | 'built-in' | 'none'; diff: string; hash: string }> {
    const approved = (await this.approvals())[id];
    const snapshot = approved ? join(this.history(id), approved.hash.slice(0, 12)) : null;
    const builtin = join(layout().integrationsSrc, id);
    const tmp = await mkdtemp(join(tmpdir(), 'bt-diff-'));
    try {
      let base = join(tmp, id);
      let kind: 'yours' | 'built-in' | 'none' = 'none';
      if (snapshot && existsSync(snapshot)) {
        base = snapshot;
        kind = 'yours';
      } else if (this.isBuiltin(id) && existsSync(builtin)) {
        await copyBuiltin(builtin, base);
        kind = 'built-in';
      } else await mkdir(base);
      const diff = await unifiedDiff(base, target);
      return { base: kind, diff, hash: existsSync(target) ? await folderHash(target) : '' };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** A folder as you review it: every file by its /-separated path, and each link as what it points to. */
async function contents(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!existsSync(dir)) return files;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.name === '.DS_Store') continue;
    const path = join(e.parentPath, e.name);
    const name = relative(dir, path).replaceAll(sep, '/');
    if (e.isFile()) files.set(name, await readFile(path));
    else if (e.isSymbolicLink()) files.set(name, Buffer.from(`link to ${await readlink(path)}\n`));
  }
  return files;
}

const isBinary = (b: Buffer) => b.includes(0) || !isUtf8(b);

/** A unified diff of two folders, with a/ and b/ in place of their names. A missing file counts as empty. */
async function unifiedDiff(a: string, b: string): Promise<string> {
  const [before, after] = await Promise.all([contents(a), contents(b)]);
  const out: string[] = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(name);
    const y = after.get(name);
    if (x && y && x.equals(y)) continue;
    const [from, to] = [x ?? Buffer.alloc(0), y ?? Buffer.alloc(0)];
    const patch =
      isBinary(from) || isBinary(to)
        ? `Binary files a/${name} and b/${name} differ\n`
        : createTwoFilesPatch(`a/${name}`, `b/${name}`, from.toString(), to.toString(), undefined, undefined, { context: 3, headerOptions: FILE_HEADERS_ONLY, timeout: 5_000 });
    // You approve what this shows, so a file too changed to compare still says it changed.
    out.push(patch ?? `Files a/${name} and b/${name} differ (too much to compare line by line)\n`);
  }
  return out.join('');
}
