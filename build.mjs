// Builds the Chrome Web Store package from the sources in this folder.
//   ai-elit-extension/      unpacked, minified build (for "Load unpacked")
//   ai-elit-extension.zip   the same files, ready to upload to the Chrome Web Store
// Run: build.bat  (or: npm run build)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, 'ai-elit-extension');
const OUT_ZIP = path.join(ROOT, 'ai-elit-extension.zip');

const MINIFY_JS = ['models.js', 'content.js', 'popup.js', 'background.js'];
const COPY_AS_IS = ['manifest.json', 'popup.html', 'popup.css', ...fs.readdirSync(path.join(ROOT, 'fonts')).map(f => `fonts/${f}`)];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// Icons referenced by the manifest (no screenshots / store media in the package)
const icons = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
]);

// ── Clean output ─────────────────────────────────────────────────────────────
// Empty the folder instead of deleting it: on Windows removing a folder that is
// open in Explorer / a terminal fails with EBUSY.
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const entry of fs.readdirSync(OUT_DIR)) {
  fs.rmSync(path.join(OUT_DIR, entry), { recursive: true, force: true });
}
fs.rmSync(OUT_ZIP, { force: true });

const files = []; // relative paths inside the package, forward slashes

function write(rel, data) {
  const dest = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  files.push(rel);
}

// ── Minify JS ────────────────────────────────────────────────────────────────
for (const rel of MINIFY_JS) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const result = await minify(src, {
    ecma: 2020,
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false, ascii_only: false },
  });
  if (!result.code) throw new Error(`terser returned no code for ${rel}`);
  write(rel, result.code);
  console.log(`  minified  ${rel.padEnd(22)} ${kb(src.length)} -> ${kb(Buffer.byteLength(result.code))}`);
}

// ── Copy static files ────────────────────────────────────────────────────────
for (const rel of [...COPY_AS_IS, ...icons]) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`Missing file referenced by build/manifest: ${rel}`);
  write(rel, fs.readFileSync(src));
  console.log(`  copied    ${rel}`);
}

// ── Sanity check: everything the manifest points to is in the package ────────
const referenced = [
  ...(manifest.content_scripts || []).flatMap(cs => [...(cs.js || []), ...(cs.css || [])]),
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...icons,
].filter(Boolean);
const missing = referenced.filter(rel => !files.includes(rel));
if (missing.length) throw new Error(`Manifest references files not in the package: ${missing.join(', ')}`);

// ── Zip (manifest.json at the root, as the Chrome Web Store expects) ─────────
fs.writeFileSync(OUT_ZIP, makeZip(files.map(rel => ({
  name: rel,
  data: fs.readFileSync(path.join(OUT_DIR, rel)),
}))));

console.log(`\nBuilt ${manifest.name} v${manifest.version}`);
console.log(`  folder: ${path.relative(ROOT, OUT_DIR)}${path.sep}`);
console.log(`  zip:    ${path.relative(ROOT, OUT_ZIP)} (${kb(fs.statSync(OUT_ZIP).size)})`);
console.log('Remember to bump "version" in manifest.json before uploading a new release.');

// ── Helpers ──────────────────────────────────────────────────────────────────
function kb(n) { return `${(n / 1024).toFixed(1)} KB`; }

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// Minimal ZIP writer (deflate, no external dependencies)
function makeZip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);   // local header offset (other fields stay 0)
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}
