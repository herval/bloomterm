import { extname } from 'node:path';
import { fold } from '@bloomterm/core';
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full';
import { z } from 'zod';
import { HttpError } from '../server.ts';

// Spreadsheets in ASK (SPEC §10.5): bloomd reads them, since the agent has no shell in a chat.
// The agent pages through the cells (read_sheet) and asks bloomd for exact sums and
// groupings (query_sheet) instead of adding up hundreds of rows itself. Cells are data from
// your file, never instructions.

XLSX.set_cptable(cptable); // old .xls files in a Windows codepage

export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  /** The spreadsheet's own row number of rows[0], and column index of rows[*][0] (A = 0). */
  firstRow: number;
  firstCol: number;
  rows: Cell[][];
  truncated?: boolean;
}

export const SHEET_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
};

const MAX_ROWS = 100_000;
const MAX_CELL = 2_000;

const isEmpty = (v: Cell) => v === null || v === '';

/** Every sheet's cells. CSV stays text, so "1.234,56" isn't misread; workbooks keep their numbers and dates. */
export function parseSpreadsheet(name: string, bytes: Buffer): Sheet[] {
  const ext = extname(name).toLowerCase();
  if (!SHEET_TYPES[ext]) throw new HttpError(415, `bloomterm reads ${Object.keys(SHEET_TYPES).join(' ')} files`);
  const opts: XLSX.ParsingOptions = { dense: true, sheetRows: MAX_ROWS + 1, cellFormula: false, cellHTML: false, cellStyles: false };
  let wb: XLSX.WorkBook;
  try {
    wb =
      ext === '.csv' || ext === '.tsv'
        ? XLSX.read(decodeText(bytes), { ...opts, type: 'string', raw: true, ...(ext === '.tsv' ? { FS: '\t' } : {}) })
        : XLSX.read(bytes, { ...opts, type: 'buffer', cellDates: true });
  } catch (err) {
    throw new HttpError(422, `couldn't read ${name}: ${(err as Error).message}`);
  }
  return wb.SheetNames.slice(0, 50).map((sheetName) => {
    const ws = wb.Sheets[sheetName]!;
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 } };
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const rows = raw.slice(0, MAX_ROWS).map((r) => trimEnd(r.map(cell)));
    while (rows.length && rows.at(-1)!.length === 0) rows.pop();
    return { name: sheetName, firstRow: range.s.r + 1, firstCol: range.s.c, rows, ...(raw.length > MAX_ROWS ? { truncated: true } : {}) };
  });
}

/** UTF-8 if it is (minus a BOM); otherwise what Excel on Windows writes. */
function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function cell(v: unknown): Cell {
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'string') return v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return v === null || v === undefined ? null : String(v);
}

/** SheetJS makes dates in local time (whatever `UTC` says), so read them back the same way. */
function isoDate(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = d.getHours() || d.getMinutes() || d.getSeconds() ? `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : '';
  return day + time;
}

function trimEnd(r: Cell[]): Cell[] {
  let n = r.length;
  while (n > 0 && isEmpty(r[n - 1]!)) n--;
  return r.slice(0, n);
}

export const colName = (i: number) => XLSX.utils.encode_col(i);

export function pickSheet(sheets: Sheet[], name?: string): Sheet {
  if (!sheets.length) throw new HttpError(422, 'this file has no sheets');
  if (!name) return sheets[0]!;
  const s = sheets.find((x) => x.name === name) ?? sheets.find((x) => fold(x.name) === fold(name));
  if (!s) throw new HttpError(404, `no sheet "${name}"; sheets: ${sheets.map((x) => x.name).join(', ')}`);
  return s;
}

/** What list_files shows: each sheet's size and its first rows, enough to find the header. */
export function preview(sheets: Sheet[]) {
  return sheets.map((s) => ({
    name: s.name,
    rows: s.rows.length,
    cols: Math.max(0, ...s.rows.map((r) => r.length)),
    ...(s.truncated ? { truncated: `only the first ${MAX_ROWS} rows were read` } : {}),
    firstRows: numbered(s).filter((r) => r.length > 1).slice(0, 8),
  }));
}

/** Rows as [spreadsheet row number, A, B, …], blank rows left out. */
const numbered = (s: Sheet) => s.rows.map((r, i) => [s.firstRow + i, ...pad(s, r)]).filter((r) => r.slice(1).some((v) => !isEmpty(v as Cell)));
const pad = (s: Sheet, r: Cell[]): Cell[] => (s.firstCol ? [...Array<Cell>(s.firstCol).fill(null), ...r] : r);

export const ReadArgs = z.object({
  file: z.string(),
  sheet: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  match: z.string().max(200).optional(),
});

/** A page of rows; `match` keeps rows with that text in any cell (accents and case ignored). */
export function readRows(sheets: Sheet[], a: z.infer<typeof ReadArgs>) {
  const s = pickSheet(sheets, a.sheet);
  const m = a.match ? fold(a.match) : null;
  const all = numbered(s).filter((r) => !m || r.slice(1).some((v) => v !== null && fold(String(v)).includes(m)));
  const rows: Cell[][] = [];
  let bytes = 0;
  for (const r of all.slice(a.offset, a.offset + a.limit)) {
    bytes += JSON.stringify(r).length;
    if (rows.length && bytes > 60_000) break;
    rows.push(r as Cell[]);
  }
  const width = Math.max(0, ...rows.map((r) => r.length - 1));
  return {
    sheet: s.name,
    columns: ['row', ...Array.from({ length: width }, (_, i) => colName(i))],
    rows,
    total: all.length,
    next: a.offset + rows.length < all.length ? a.offset + rows.length : null,
  };
}

const Column = z.object({
  from: z.string().describe('the header text, or a column letter like "C"'),
  as: z.string().max(60).optional(),
  type: z.enum(['text', 'number', 'date']).optional(),
});

export const Query = z.object({
  file: z.string(),
  sheet: z.string().optional(),
  headerRow: z.number().int().min(1).optional(),
  columns: z.array(Column).max(60).optional(),
  where: z
    .array(
      z.object({
        column: z.string(),
        op: z.enum(['contains', 'equals', 'not_empty', 'empty', 'gt', 'gte', 'lt', 'lte']),
        value: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .max(20)
    .optional(),
  groupBy: z.array(z.string()).max(5).optional(),
  sum: z.array(z.string()).max(20).optional(),
  sort: z.object({ column: z.string(), desc: z.boolean().optional() }).optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
  decimal: z.enum([',', '.']).optional(),
  dayFirst: z.boolean().optional(),
});
export type Query = z.infer<typeof Query>;

export interface Table {
  columns: string[];
  rows: Cell[][];
  total: number;
  headerRow: number;
  /** Cells a number or date conversion couldn't read (left empty), a few for example. */
  unreadable?: { count: number; examples: string[] };
}

/**
 * Rows under a header row, with columns picked, renamed and typed ("1.234,56" → 1234.56,
 * "05/10/2026" → 2026-10-05), filtered, and optionally grouped with exact sums.
 */
export function runQuery(sheets: Sheet[], q: Query): Table {
  const s = pickSheet(sheets, q.sheet);
  const rows = s.rows.map((r) => pad(s, r));
  const h = q.headerRow ? q.headerRow - s.firstRow : detectHeader(rows);
  if (h < 0 || h >= rows.length) throw new HttpError(400, `row ${q.headerRow} is outside the sheet (rows ${s.firstRow}–${s.firstRow + rows.length - 1})`);
  const header = rows[h]!.map((v, i) => (isEmpty(v) ? colName(i) : String(v).trim()));
  const index = (ref: string): number => {
    const f = fold(ref.trim());
    const i = header.findIndex((x) => fold(x) === f);
    if (i >= 0) return i;
    if (/^[A-Z]{1,3}$/.test(ref.trim())) return XLSX.utils.decode_col(ref.trim());
    throw new HttpError(400, `no column "${ref}" in header row ${s.firstRow + h}; columns: ${header.filter(Boolean).join(' | ')}`);
  };
  const cols: z.infer<typeof Column>[] = q.columns?.length ? q.columns : header.flatMap((name, i) => (isEmpty(rows[h]![i] ?? null) ? [] : [{ from: name }]));
  const picked = cols.map((c) => ({ i: index(c.from), name: c.as ?? header[index(c.from)]!, type: c.type }));

  const bad: string[] = [];
  let badCount = 0;
  const convert = (v: Cell, type?: string): Cell => {
    if (!type || type === 'text' || isEmpty(v)) return type === 'text' && v !== null ? String(v) : v;
    const out = type === 'number' ? parseNumber(v, q.decimal) : parseDate(v, q.dayFirst ?? true);
    if (out === null) {
      badCount++;
      if (bad.length < 5) bad.push(String(v));
    }
    return out;
  };
  let data = rows
    .slice(h + 1)
    .filter((r) => picked.some((p) => !isEmpty(r[p.i] ?? null)))
    .map((r) => picked.map((p) => convert(r[p.i] ?? null, p.type)));

  const names = picked.map((p) => p.name);
  const at = (ref: string) => {
    const i = names.findIndex((n) => fold(n) === fold(ref));
    if (i < 0) throw new HttpError(400, `no column "${ref}" in the result; columns: ${names.join(' | ')}`);
    return i;
  };
  for (const w of q.where ?? []) {
    const i = at(w.column);
    const want = w.value;
    data = data.filter((r) => {
      const v = r[i] ?? null;
      switch (w.op) {
        case 'not_empty':
          return !isEmpty(v);
        case 'empty':
          return isEmpty(v);
        case 'contains':
          return v !== null && fold(String(v)).includes(fold(String(want ?? '')));
        case 'equals':
          return v !== null && (typeof v === 'number' && typeof want === 'number' ? v === want : fold(String(v)) === fold(String(want ?? '')));
        default: {
          const a = typeof v === 'number' ? v : typeof v === 'string' ? (parseNumber(v, q.decimal) ?? v) : null;
          const b = typeof want === 'number' ? want : typeof a === 'number' ? parseNumber(String(want), q.decimal) : String(want ?? '');
          if (a === null || b === null) return false;
          return w.op === 'gt' ? a > b : w.op === 'gte' ? a >= b : w.op === 'lt' ? a < b : a <= b;
        }
      }
    });
  }

  let columns = names;
  if (q.groupBy?.length || q.sum?.length) {
    const g = (q.groupBy ?? []).map(at);
    const sums = (q.sum ?? []).map(at);
    const groups = new Map<string, { key: Cell[]; sums: number[]; count: number }>();
    for (const r of data) {
      const key = g.map((i) => r[i] ?? null);
      const k = JSON.stringify(key);
      const cur = groups.get(k) ?? { key, sums: sums.map(() => 0), count: 0 };
      sums.forEach((i, j) => {
        const v = r[i];
        const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v, q.decimal) : null;
        if (n !== null) cur.sums[j]! += n;
      });
      cur.count++;
      groups.set(k, cur);
    }
    columns = [...g.map((i) => names[i]!), ...sums.map((i) => `sum of ${names[i]}`), 'count'];
    data = [...groups.values()].map((x) => [...x.key, ...x.sums.map((n) => Math.round(n * 1e6) / 1e6), x.count]);
  }
  if (q.sort) {
    const i = columns.findIndex((n) => fold(n) === fold(q.sort!.column));
    if (i < 0) throw new HttpError(400, `can't sort by "${q.sort.column}"; columns: ${columns.join(' | ')}`);
    const dir = q.sort.desc ? -1 : 1;
    data.sort((a, b) => dir * compare(a[i] ?? null, b[i] ?? null));
  }
  const total = data.length;
  return {
    columns,
    rows: q.limit ? data.slice(0, q.limit) : data,
    total,
    headerRow: s.firstRow + h,
    ...(badCount ? { unreadable: { count: badCount, examples: bad } } : {}),
  };
}

function compare(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
}

/** The first of the top rows that's mostly filled, and all text: where the column names usually are. */
export function detectHeader(rows: Cell[][]): number {
  const top = rows.slice(0, 30);
  const filled = top.map((r) => r.filter((v) => !isEmpty(v)).length);
  const most = Math.max(0, ...filled);
  const i = top.findIndex((r, i) => filled[i]! >= Math.max(2, Math.ceil(most * 0.6)) && r.every((v) => isEmpty(v) || typeof v === 'string'));
  return Math.max(i, 0);
}

/**
 * A number from text the way people write money: "R$ -1.234,56", "1,234.56", "(12.50)", "300-".
 * With a single separator followed by exactly three digits ("1.234"), `decimal` decides.
 */
export function parseNumber(v: Cell, decimal: ',' | '.' = '.'): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,+-]/g, '');
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  let dec: string | null;
  if (dot >= 0 && comma >= 0) dec = dot > comma ? '.' : ',';
  else if (dot >= 0 || comma >= 0) {
    const sep = dot >= 0 ? '.' : ',';
    const many = s.split(sep).length > 2;
    const after = s.length - s.lastIndexOf(sep) - 1;
    dec = many ? null : after === 3 ? (decimal === sep ? sep : null) : sep;
  } else dec = null;
  const thousands = dec === '.' ? /,/g : dec === ',' ? /\./g : /[.,]/g;
  s = s.replace(thousands, '');
  if (dec === ',') s = s.replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** A date as YYYY-MM-DD from 2026-10-05, 05/10/2026 (day first unless `dayFirst` is false), 05.10.26, or an Excel serial. */
export function parseDate(v: Cell, dayFirst = true): string | null {
  if (typeof v === 'number') {
    if (v < 1 || v > 2_958_465) return null;
    const d = XLSX.SSF.parse_date_code(v);
    return d ? ymd(d.y, d.m, d.d) : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s);
  if (!m) return null;
  const [a, b, y] = [+m[1]!, +m[2]!, m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!];
  return dayFirst ? ymd(y, b, a) : ymd(y, a, b);
}

function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** A .csv (one sheet; UTF-8 with a BOM, so Excel shows accents) or an .xlsx (dates as real dates). */
export function writeWorkbook(name: string, sheets: { name: string; columns?: string[]; rows: Cell[][] }[]): { bytes: Buffer; mime: string } {
  const ext = extname(name).toLowerCase();
  const aoa = (s: (typeof sheets)[number]) => [...(s.columns ? [s.columns] : []), ...s.rows];
  if (ext === '.csv') {
    if (sheets.length > 1) throw new HttpError(400, 'a .csv holds one sheet; name the file .xlsx for several');
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(aoa(sheets[0]!)));
    return { bytes: Buffer.from(`﻿${csv}\n`, 'utf8'), mime: SHEET_TYPES['.csv']! };
  }
  if (ext !== '.xlsx') throw new HttpError(400, 'write .csv or .xlsx files');
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const s of sheets) {
    const rows = aoa(s).map((r) => r.map((v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) : v)));
    let title = s.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
    while (used.has(title)) title = `${title.slice(0, 28)} ${used.size + 1}`;
    used.add(title);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), title);
  }
  return { bytes: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer, mime: SHEET_TYPES['.xlsx']! };
}
