// Draws bloomterm's icons, the candle bloom: five amber candlesticks fanned out like petals on a
// dark tile. No dependencies: it rasterizes with signed distances and writes PNGs, and writes the
// same bloom as an SVG for the web app.
//
//   pnpm --filter @bloomterm/desktop icons   (then commits what it wrote)
//
// src-tauri/icons/app-icon.png  1024px app icon, inset like macOS icons; `tauri icon` makes the rest
// src-tauri/tray/icon.png       the menu bar's template image (alpha only), 18pt at 2x
// apps/web/public/favicon.svg   the mark: the favicon, and the logo by "bloomterm" in the web app
// shell/mark.svg                the same, for the app's own page

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, 'src-tauri');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x + 0.5, y + 0.5).map((v) => Math.round(Math.min(255, Math.max(0, v)))), y * (size * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Signed distance to a rounded box centered at (cx, 0), half-sizes hx and hy, corner radius r. */
const box = (u, v, cx, hx, hy, r) => {
  const qx = Math.abs(u - cx) - hx + r;
  const qy = Math.abs(v) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const STOPS = [
  [0, '#ffc35a'],
  [0.45, '#f5a524'],
  [1, '#ff7a45'],
];
const gradient = (t) => {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++)
    if (t <= STOPS[i][0]) return mix(hex(STOPS[i - 1][1]), hex(STOPS[i][1]), (t - STOPS[i - 1][0]) / (STOPS[i][0] - STOPS[i - 1][0]));
  return hex(STOPS.at(-1)[1]);
};
const TILE = ['#1c2028', '#0b0d10'];
const DEEP = '#d9661f';
const DOT = '#ffd27a';

// The bloom, in units of the icon's size S (the canvas a macOS icon is drawn on). Every wick spans
// the same radii, so the bloom is round; the bodies sit at different places along them, like real
// candles. Five, as most flowers have five petals (six reads as a snowflake).
const BLOOM = {
  hw: 0.056, // half the width of a body
  ww: 0.012, // half the width of a wick
  dot: 0.042, // the radius of the center
  wick: [0.08, 0.335],
  bodies: [
    [0.12, 0.29],
    [0.15, 0.25],
    [0.11, 0.27],
    [0.15, 0.31],
    [0.12, 0.23],
  ],
};
// Small sizes (the menu bar, the favicon) get bolder bodies and wicks, so they hold.
const SMALL = { ...BLOOM, hw: BLOOM.hw * 1.2, ww: BLOOM.ww * 1.8 };
const N = BLOOM.bodies.length;
const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
// Five petals reach further up than down: center the bloom on its extent, not on its middle.
const DROP = (BLOOM.wick[1] * (1 - Math.cos(Math.PI / N))) / 2;

/** Signed distances to the bloom's bodies, wicks and center at size S, centered at c; and whether the
 * nearest body is a darker one (every other candle). */
function bloom(x, y, c, S, g) {
  const dx = x - c;
  const dy = y - c - DROP * S;
  let body = Infinity;
  let deep = false;
  let wick = Infinity;
  g.bodies.forEach(([b0, b1], i) => {
    const a = angle(i);
    const u = dx * Math.cos(a) + dy * Math.sin(a);
    const v = -dx * Math.sin(a) + dy * Math.cos(a);
    const b = box(u, v, ((b0 + b1) / 2) * S, ((b1 - b0) / 2) * S, g.hw * S, 0.016 * S);
    if (b < body) {
      body = b;
      deep = i % 2 === 1;
    }
    const [w0, w1] = g.wick;
    const ww = Math.max(g.ww * S, 0.55);
    wick = Math.min(wick, box(u, v, ((w0 + w1) / 2) * S, ((w1 - w0) / 2) * S, ww, ww));
  });
  return { body, deep, wick, dot: Math.hypot(dx, dy) - g.dot * S };
}

// The app icon: macOS draws icons at 824/1024 of the canvas, corner radius about 185.
const S = 1024;
const tile = { c: S / 2, h: 412, r: 185 };
const app = png(S, (x, y) => {
  const a = coverage(box(x - tile.c, y - tile.c, 0, tile.h, tile.h, tile.r));
  if (a === 0) return [0, 0, 0, 0];
  // The dark tile, a little lighter at the top, with a faint amber glow behind the bloom.
  let rgb = mix(hex(TILE[0]), hex(TILE[1]), (y - (tile.c - tile.h)) / (2 * tile.h));
  rgb = mix(rgb, gradient(0.45), 0.2 * Math.exp(-((Math.hypot(x - tile.c, y - tile.c) / (0.3 * S)) ** 2)));
  const amber = gradient((x + y) / (2 * S));
  const { body, deep, wick, dot } = bloom(x, y, tile.c, S, BLOOM);
  rgb = mix(rgb, amber, 0.9 * coverage(wick));
  rgb = mix(rgb, deep ? mix(amber, hex(DEEP), 0.35) : amber, coverage(body));
  rgb = mix(rgb, hex(DOT), coverage(dot));
  return [...rgb, 255 * a];
});

// The menu bar: the bloom alone, in black; macOS tints it.
const T = 36;
const trayIcon = png(T, (x, y) => {
  const { body, wick, dot } = bloom(x, y, T / 2, (T / 2 - 1) / BLOOM.wick[1], SMALL);
  return [0, 0, 0, 255 * Math.max(coverage(body), coverage(wick), coverage(dot))];
});

// The mark: the app icon with its tile filling the square (no macOS inset), drawn small. Each candle
// is one flat color, the gradient's at its middle: no masks, which WebKit draws blurry.
function mark() {
  const V = 32;
  const s = (V * 1024) / 824;
  const n = (v) => +v.toFixed(2);
  const color = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const [cx, cy] = [V / 2, V / 2 + DROP * s];
  const candles = SMALL.bodies.map(([b0, b1], i) => {
    const a = angle(i);
    const mid = ((b0 + b1) / 2) * s;
    const amber = gradient((cx + mid * Math.cos(a) + cy + mid * Math.sin(a)) / (2 * V));
    const fill = color(i % 2 ? mix(amber, hex(DEEP), 0.35) : amber);
    const [w0, w1] = SMALL.wick;
    const rect = (x0, x1, hw, r, extra = '') => `<rect x="${n(x0 * s)}" y="${n(-hw * s)}" width="${n((x1 - x0) * s)}" height="${n(2 * hw * s)}" rx="${n(r * s)}"${extra}/>`;
    return `<g transform="rotate(${n((a * 180) / Math.PI)})" fill="${fill}">${rect(w0, w1, SMALL.ww, SMALL.ww, ' fill-opacity=".9"')}${rect(b0, b1, SMALL.hw, 0.016)}</g>`;
  });
  const glow = STOPS[1][1];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}">`,
    '<defs>',
    `<linearGradient id="tile" x2="0" y2="1"><stop offset="0" stop-color="${TILE[0]}"/><stop offset="1" stop-color="${TILE[1]}"/></linearGradient>`,
    `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${V / 2}" cy="${V / 2}" r="${n(0.6 * s)}"><stop offset="0" stop-color="${glow}" stop-opacity=".2"/><stop offset=".5" stop-color="${glow}" stop-opacity=".07"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>`,
    '</defs>',
    ...['tile', 'glow'].map((fill) => `<rect width="${V}" height="${V}" rx="${n((V * 185) / 824)}" fill="url(#${fill})"/>`),
    `<g transform="translate(${n(cx)} ${n(cy)})">${candles.join('')}<circle r="${n(SMALL.dot * s)}" fill="${DOT}"/></g>`,
    '</svg>',
    '',
  ].join('');
}

mkdirSync(join(root, 'icons'), { recursive: true });
mkdirSync(join(root, 'tray'), { recursive: true });
writeFileSync(join(root, 'icons/app-icon.png'), app);
writeFileSync(join(root, 'tray/icon.png'), trayIcon);
writeFileSync(join(desktop, '../web/public/favicon.svg'), mark());
writeFileSync(join(desktop, 'shell/mark.svg'), mark());
console.log('icons: wrote src-tauri/icons/app-icon.png, src-tauri/tray/icon.png, apps/web/public/favicon.svg and shell/mark.svg');
