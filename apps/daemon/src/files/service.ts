import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { homePaths } from '@bloomterm/core';
import type { Logger } from '@bloomterm/browser';
import type { ChatFile, Store } from '@bloomterm/store';
import { z } from 'zod';
import { HttpError } from '../server.ts';
import { parseSpreadsheet, preview, Query, readRows, ReadArgs, runQuery, SHEET_TYPES, writeWorkbook, type Cell, type Sheet } from './sheets.ts';

// Files in ASK (SPEC §10.5). You attach a spreadsheet; bloomd keeps the bytes under
// <home>/files, parses it once (cached next to it), and the agent reads it through `bt mcp`,
// scoped to the conversation it was sent in. Files the agent writes land here too, for you to
// download. Uploads never sent with a question are cleared after a day.

export const MAX_UPLOAD = 25 * 1024 * 1024;

const Cells = z.array(z.array(z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()])).max(200));

export const WriteSpec = z.object({
  name: z.string().trim().min(1).max(100),
  sheets: z
    .array(
      z.object({
        name: z.string().max(60).default('Sheet1'),
        columns: z.array(z.string().max(200)).max(200).optional(),
        rows: Cells.max(20_000).optional(),
        query: Query.optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** A file name that can't climb out of a folder or carry control characters. */
export function safeName(name: string): string {
  const clean = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (clean || 'file').slice(0, 100);
}

export class FileService {
  private readonly dir: string;
  private cache = new Map<string, Sheet[]>();

  constructor(
    private readonly o: {
      home: string;
      store: Store;
      log: Logger;
      emit: (ev: { type: 'chat_file'; chatId: string; file: ChatFile }) => void;
      /** Where saveToDownloads() puts files: ~/Downloads unless given. */
      downloads?: string;
    },
  ) {
    this.dir = homePaths(o.home).files;
  }

  private path(id: string, suffix = '') {
    if (!/^f_[0-9a-f]{12}$/.test(id)) throw new HttpError(400, 'bad file id');
    return join(this.dir, id + suffix);
  }

  /** Stores an upload and reads its sheets. One it can't read is kept, with the reason, so the chat can say why. */
  async upload(rawName: string, bytes: Buffer): Promise<ChatFile> {
    const name = safeName(rawName);
    const ext = extname(name).toLowerCase();
    if (!SHEET_TYPES[ext]) throw new HttpError(415, `bloomterm reads spreadsheets: ${Object.keys(SHEET_TYPES).join(' ')}`);
    if (bytes.length > MAX_UPLOAD) throw new HttpError(413, `files can be up to ${MAX_UPLOAD / 1024 / 1024} MB`);
    let sheets: Sheet[] | null = null;
    let error: string | undefined;
    try {
      sheets = parseSpreadsheet(name, bytes);
    } catch (err) {
      if (err instanceof HttpError && err.status === 415) throw err;
      error = (err as Error).message;
    }
    const file = this.o.store.files.create({
      origin: 'upload',
      name,
      mime: SHEET_TYPES[ext]!,
      size: bytes.length,
      sheets: sheets?.map((s) => ({ name: s.name, rows: s.rows.length, cols: Math.max(0, ...s.rows.map((r) => r.length)), ...(s.truncated ? { truncated: true } : {}) })),
      error,
    });
    await this.save(file.id, bytes, sheets);
    this.o.log.info('file uploaded', { id: file.id, size: bytes.length, sheets: sheets?.length ?? 0 });
    return file;
  }

  private async save(id: string, bytes: Buffer, sheets: Sheet[] | null) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.path(id), bytes, { mode: 0o600 });
    if (sheets) {
      await writeFile(this.path(id, '.sheets.json'), JSON.stringify(sheets), { mode: 0o600 });
      this.remember(id, sheets);
    }
  }

  private remember(id: string, sheets: Sheet[]) {
    this.cache.delete(id);
    this.cache.set(id, sheets);
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
  }

  async download(id: string): Promise<{ file: ChatFile; bytes: Buffer }> {
    const file = this.o.store.files.get(id);
    if (!file) throw new HttpError(404, `no file ${id}`);
    return { file, bytes: await readFile(this.path(id)) };
  }

  /**
   * Puts a file in your Downloads folder, next to what's there ("name (2).xlsx" if the name
   * is taken). The desktop app downloads this way: its web view can't save a fetched file.
   */
  async saveToDownloads(id: string): Promise<{ path: string }> {
    const { file, bytes } = await this.download(id);
    const dir = this.o.downloads ?? join(homedir(), 'Downloads');
    await mkdir(dir, { recursive: true });
    const name = safeName(file.name);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const path = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
      try {
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        return { path };
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw new HttpError(409, `${dir} already has too many files named ${name}`);
  }

  /** A file of this conversation; the agent can't reach any other. */
  inChat(chatId: string, id: string): ChatFile {
    const file = this.o.store.files.get(id);
    if (!file || file.chatId !== chatId) throw new HttpError(404, `no file ${id} in this conversation; list_files shows what's here`);
    return file;
  }

  private async sheets(file: ChatFile): Promise<Sheet[]> {
    if (file.error) throw new HttpError(422, `${file.name} couldn't be read: ${file.error}`);
    const hit = this.cache.get(file.id);
    if (hit) return hit;
    const sheets = JSON.parse(await readFile(this.path(file.id, '.sheets.json'), 'utf8')) as Sheet[];
    this.remember(file.id, sheets);
    return sheets;
  }

  /** list_files: every file in the conversation, each sheet's size and first rows. */
  async list(chatId: string) {
    return Promise.all(
      this.o.store.files.list(chatId).map(async (f) => ({
        id: f.id,
        name: f.name,
        from: f.origin === 'upload' ? 'the owner' : 'you',
        size: f.size,
        ...(f.error ? { error: f.error } : { sheets: preview(await this.sheets(f)) }),
      })),
    );
  }

  async read(chatId: string, args: unknown) {
    const a = ReadArgs.parse(args);
    return readRows(await this.sheets(this.inChat(chatId, a.file)), a);
  }

  /** query_sheet: at most `max` rows come back to the agent; `total` says how many matched. */
  async query(chatId: string, args: unknown, max = 500) {
    const q = Query.parse(args);
    const t = runQuery(await this.sheets(this.inChat(chatId, q.file)), q);
    return t.rows.length > max ? { ...t, rows: t.rows.slice(0, max), note: `first ${max} of ${t.total} rows; write_file with this query gets them all` } : t;
  }

  /** write_file: a .csv or .xlsx from rows the agent gives, or from a query of a file here. */
  async write(chatId: string, seq: number, args: unknown): Promise<ChatFile> {
    const spec = WriteSpec.parse(args);
    const name = safeName(spec.name);
    const sheets: { name: string; columns?: string[]; rows: Cell[][] }[] = [];
    for (const s of spec.sheets) {
      if (s.query) {
        const t = runQuery(await this.sheets(this.inChat(chatId, s.query.file)), s.query);
        sheets.push({ name: s.name, columns: s.columns ?? t.columns, rows: t.rows });
      } else sheets.push({ name: s.name, columns: s.columns, rows: s.rows ?? [] });
    }
    const { bytes, mime } = writeWorkbook(name, sheets);
    const file = this.o.store.files.create({
      origin: 'agent',
      name,
      mime,
      size: bytes.length,
      sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length + (s.columns ? 1 : 0), cols: Math.max(s.columns?.length ?? 0, ...s.rows.map((r) => r.length)) })),
      chatId,
      seq,
    });
    await this.save(file.id, bytes, null);
    this.o.emit({ type: 'chat_file', chatId, file });
    return file;
  }

  /** Checks uploads can go with a question: they exist, are uploads, and weren't sent yet. */
  check(ids: string[]): ChatFile[] {
    return ids.map((id) => {
      const f = this.o.store.files.get(id);
      if (!f || f.origin !== 'upload') throw new HttpError(404, `no upload ${id}`);
      if (f.chatId) throw new HttpError(409, `${f.name} was sent already; attach it again`);
      return f;
    });
  }

  /** A conversation is going away: its files on disk go with it (the rows cascade). */
  async removeChat(chatId: string): Promise<void> {
    for (const f of this.o.store.files.list(chatId)) await this.remove(f.id);
  }

  /** Uploads never sent with a question, after a day. */
  async sweep(now = new Date()): Promise<number> {
    const old = this.o.store.files.unsent(new Date(now.getTime() - 86_400_000).toISOString());
    for (const f of old) {
      await this.remove(f.id);
      this.o.store.files.delete(f.id);
    }
    return old.length;
  }

  private async remove(id: string) {
    this.cache.delete(id);
    await rm(this.path(id), { force: true });
    await rm(this.path(id, '.sheets.json'), { force: true });
  }
}
