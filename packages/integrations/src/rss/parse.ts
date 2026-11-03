// A small RSS 2.0 / Atom reader: enough for news feeds, no dependencies. It reads titles,
// links, dates, authors and descriptions, and turns HTML in them into plain text.

import { decodeEntities, plain } from '../text.ts';

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  /** ISO, when the feed gives a date it can parse. */
  published?: string;
  author?: string;
  summary?: string;
}

function tag(block: string, names: string[]): string | undefined {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(block);
    if (m) return m[1];
  }
  return undefined;
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]!);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  return pick ? /href=["']([^"']+)["']/i.exec(pick)?.[1] : undefined;
}

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(plain(s));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Reads every <item> (RSS) or <entry> (Atom). Entries without a title or a link are skipped. */
export function parseFeed(xml: string): FeedEntry[] {
  const atom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const out: FeedEntry[] = [];
  for (const b of blocks) {
    const title = plain(tag(b, ['title']) ?? '');
    const rawLink = atom ? atomLink(b) : (tag(b, ['link']) ?? undefined);
    const link = rawLink ? decodeEntities(plain(rawLink)) : '';
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const guid = tag(b, ['guid', 'id']);
    const summary = plain(tag(b, ['description', 'summary', 'content', 'atom:subtitle']) ?? '');
    const author = tag(b, ['dc:creator', 'author']);
    out.push({
      id: guid ? plain(guid) : link,
      title,
      link,
      published: isoDate(tag(b, ['pubDate', 'published', 'updated', 'dc:date'])),
      author: author ? plain(tag(author, ['name']) ?? author) || undefined : undefined,
      summary: summary ? summary.slice(0, 400) : undefined,
    });
  }
  return out;
}
