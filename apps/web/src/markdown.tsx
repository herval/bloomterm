import { parseCommand } from '@bloomterm/core/web';
import type { ReactNode } from 'react';
import { FN_SET } from './functions.ts';

// Just enough Markdown for ASK answers: paragraphs, lists, pipe tables, **bold**, `code`,
// [links](https://…). No HTML is ever injected. A code span that is a terminal command
// (`PETR4 GP 1Y`) becomes a button that runs it.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, run: (cmd: string) => void): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = part.slice(1, -1);
      const c = parseCommand(code, FN_SET);
      if (c.kind === 'go') {
        return (
          <button key={i} className="cmdlink" onClick={() => run(code)} title="Open it">
            {code}
          </button>
        );
      }
      return <code key={i}>{code}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener">
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ text, run }: { text: string; run: (cmd: string) => void }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split('\n').filter((l) => l.trim());
        if (lines.length === 0) return null;
        if (lines.every((l) => l.trim().startsWith('|'))) {
          const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map(cells);
          const [head, ...body] = rows;
          // Cells wrap to fit the panel; a table that still can't fit scrolls inside its own box.
          return (
            <div key={bi} className="md-wrap">
              <table className="md-table">
                <thead>
                  <tr>{head?.map((c, i) => <th key={i}>{inline(c, run)}</th>)}</tr>
                </thead>
                <tbody>
                  {body.map((r, ri) => (
                    <tr key={ri}>{r.map((c, i) => <td key={i}>{inline(c, run)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]!);
          const items = lines.map((l, i) => <li key={i}>{inline(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''), run)}</li>);
          return ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
        }
        return (
          <p key={bi}>
            {lines.map((l, i) => {
              const h = /^#{1,6}\s+(.*)$/.exec(l);
              return (
                <span key={i}>
                  {i > 0 && <br />}
                  {h ? <b>{inline(h[1]!, run)}</b> : inline(l, run)}
                </span>
              );
            })}
          </p>
        );
      })}
    </>
  );
}
