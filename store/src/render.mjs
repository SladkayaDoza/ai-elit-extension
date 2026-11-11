// Renders the Chrome Web Store images into store/ with headless Chrome (or Edge).
//   1. the real popup.html with demo settings  -> .build/popup-*.png
//   2. the image templates (*.html in this folder) -> store/*.png at exact store sizes
// Run: node store/src/render.mjs   (or: npm run store)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '..', '..');
const OUT = path.resolve(SRC, '..');
const BUILD = path.join(SRC, '.build');

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const BROWSER = BROWSERS.find(p => fs.existsSync(p));
if (!BROWSER) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-store-'));

function screenshot(htmlFile, outFile, width, height, scale = 1) {
  execFileSync(BROWSER, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files',
    `--user-data-dir=${PROFILE_DIR}`,
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=4000',
    `--screenshot=${outFile}`,
    pathToFileURL(htmlFile).href,
  ], { stdio: 'ignore' });
  if (!fs.existsSync(outFile)) throw new Error(`Screenshot failed: ${outFile}`);
}

// ── 1. Popup screenshots with demo data ─────────────────────────────────────
const ANSWER = '1, 3, 4: "Сортування злиттям", "Швидке сортування", "Пірамідальне сортування"';
const base = { apiKey: 'sk-or-v1-' + 'x'.repeat(48) };
const POPUPS = {
  main: { tab: 'main', data: { ...base, lastStatus: { state: 'success', text: `✅ Selected ${ANSWER}` } } },
  stealth: {
    tab: 'main',
    data: { ...base, hideButton: true, autoFill: false, lastStatus: { state: 'success', text: `💡 Answer ${ANSWER}` } },
  },
  profiles: { tab: 'profiles', profile: 'Pro', data: base },
  fallback: { tab: 'fallback', data: base },
  models: { tab: 'models', data: base },
};

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const rel = path.relative(BUILD, ROOT).split(path.sep).join('/');

for (const [name, cfg] of Object.entries(POPUPS)) {
  const data = { ...cfg.data };
  if (data.lastStatus) data.lastStatus = { ...data.lastStatus, time: Date.now() };
  // No transitions: the screenshot must show the final tab highlight, not a mid-animation frame
  const mock = `<style>html{background:#101012}body{max-height:none!important;overflow:hidden!important}*,*::before,*::after{transition:none!important}</style>
<script>
const DATA = ${JSON.stringify(data)};
const copy = o => JSON.parse(JSON.stringify(o));
window.chrome = {
  runtime: { lastError: null, sendMessage() {} },
  storage: {
    local: {
      get(keys, cb) {
        const d = copy(DATA);
        const out = keys === null ? d : Object.fromEntries([].concat(keys).filter(k => k in d).map(k => [k, d[k]]));
        setTimeout(() => cb(out), 0);
      },
      set(o, cb) { Object.assign(DATA, copy(o)); cb && setTimeout(cb, 0); },
      remove(k, cb) { cb && setTimeout(cb, 0); },
      clear(cb) { cb && cb(); },
    },
    onChanged: { addListener() {} },
  },
};
</script>`;
  const after = `<script>
setTimeout(() => {
  document.querySelector('.tab-btn[data-tab="${cfg.tab}"]').click();
  ${cfg.profile ? `[...document.querySelectorAll('.profile-chip')].find(c => c.textContent.includes(${JSON.stringify(cfg.profile)}))?.click();` : ''}
  document.getElementById('status').textContent = '';
}, 400);
</script>`;
  const html = popupHtml
    .replace('<script src="models.js"></script>', `${mock}\n  <script src="${rel}/models.js"></script>`)
    .replace('<script src="popup.js"></script>', `<script src="${rel}/popup.js"></script>\n${after}`);
  const file = path.join(BUILD, `popup-${name}.html`);
  fs.writeFileSync(file, html);
  screenshot(file, path.join(BUILD, `popup-${name}.png`), 400, 760, 2);
  console.log(`  popup     ${name}`);
}

// ── 2. Store images ─────────────────────────────────────────────────────────
const IMAGES = [
  ['screenshot-1-quiz.html', 'screenshot-1-quiz-1280x800.png', 1280, 800],
  ['screenshot-2-stealth.html', 'screenshot-2-stealth-1280x800.png', 1280, 800],
  ['screenshot-3-settings.html', 'screenshot-3-settings-1280x800.png', 1280, 800],
  ['promo-small.html', 'promo-small-440x280.png', 440, 280],
  ['promo-marquee.html', 'promo-marquee-1400x560.png', 1400, 560],
];

for (const [src, out, w, h] of IMAGES) {
  const file = path.join(OUT, out);
  screenshot(path.join(SRC, src), file, w, h, 1);
  fs.writeFileSync(file, toRgbPng(fs.readFileSync(file)));
  const size = readSize(fs.readFileSync(file));
  if (size.w !== w || size.h !== h) throw new Error(`${out}: got ${size.w}x${size.h}, expected ${w}x${h}`);
  console.log(`  image     ${out}`);
}

fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
console.log(`\nDone: ${path.relative(ROOT, OUT)}${path.sep}`);

// ── PNG helpers: the store wants 24-bit PNG without alpha ────────────────────
function readSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

function toRgbPng(buf) {
  const { w, h } = readSize(buf);
  const bitDepth = buf[24], colorType = buf[25];
  if (colorType === 2) return buf;                       // already RGB
  if (colorType !== 6 || bitDepth !== 8) throw new Error(`Unsupported PNG type ${colorType}/${bitDepth}`);

  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const rgba = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {                          // undo PNG row filters
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rgba[y * stride + x - bpp] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      rgba[y * stride + x] = v & 0xff;
    }
  }
  const out = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    out[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = y * stride + x * 4, d = y * (w * 3 + 1) + 1 + x * 3;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    buf.subarray(0, 8), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
