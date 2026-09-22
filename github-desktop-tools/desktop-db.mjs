import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import snappy from 'snappyjs';

// Read-only LevelDB snapshot reader. Never opens the live database with a writer.
// Format references: Google's leveldb/doc/{log_format,table_format}.md and
// Chromium content/browser/indexed_db/docs/leveldb_coding_scheme.md.
const MAX_BYTES = 256 * 1024 * 1024;
export class Cursor {
  constructor(b) { this.b = b; this.o = 0; }
  take(n) { if (!Number.isSafeInteger(n) || n < 0 || this.o + n > this.b.length) throw Error('Truncated database record'); const r = this.b.subarray(this.o, this.o + n); this.o += n; return r; }
  byte() { return this.take(1)[0]; }
  varint() { let n = 0n; for (let i = 0; i < 10; i++) { const b = this.byte(); n |= BigInt(b & 127) << BigInt(i * 7); if (!(b & 128)) { if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Database integer too large'); return Number(n); } } throw Error('Invalid varint'); }
  bytes() { return this.take(this.varint()); }
}
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0x82f63b78 : 0); return c >>> 0; });
export function maskedCrc(b) { let c = 0xffffffff; for (const x of b) c = (c >>> 8) ^ crcTable[(c ^ x) & 255]; c = (~c) >>> 0; return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0; }
export function logRecords(b) {
  const records = []; let parts = null;
  for (let base = 0; base < b.length; base += 32768) {
    const end = Math.min(base + 32768, b.length); let o = base;
    while (o + 7 <= end) {
      const crc = b.readUInt32LE(o), n = b.readUInt16LE(o + 4), type = b[o + 6]; o += 7;
      if (!type && !n && !crc) { if (b.subarray(o, end).some(x => x)) throw Error('Invalid WAL padding'); o = end; break; }
      if (o + n > end) throw Error('Incomplete WAL; retry when GitHub Desktop is idle');
      const data = b.subarray(o, o + n); o += n;
      if (maskedCrc(Buffer.concat([Buffer.from([type]), data])) !== crc) throw Error('WAL checksum mismatch');
      if (type === 1 && parts === null) records.push(data);
      else if (type === 2 && parts === null) parts = [data];
      else if (type === 3 && parts !== null) parts.push(data);
      else if (type === 4 && parts !== null) { records.push(Buffer.concat([...parts, data])); parts = null; }
      else throw Error('Invalid WAL fragment sequence');
    }
    if (b.subarray(o, end).some(x => x)) throw Error('Incomplete WAL header');
  }
  if (parts !== null) throw Error('Incomplete WAL record');
  return records;
}
export function readManifest(b) {
  const files = new Map(); let log, prev = 0;
  for (const rec of logRecords(b)) {
    const c = new Cursor(rec);
    while (c.o < rec.length) {
      const tag = c.varint();
      if (tag === 1) c.bytes();
      else if (tag === 2) log = c.varint();
      else if (tag === 3 || tag === 4) c.varint();
      else if (tag === 9) prev = c.varint();
      else if (tag === 5) { c.varint(); c.bytes(); }
      else if (tag === 6) { const level = c.varint(), num = c.varint(); files.delete(`${level}:${num}`); }
      else if (tag === 7) { const level = c.varint(), num = c.varint(), size = c.varint(); c.bytes(); c.bytes(); files.set(`${level}:${num}`, { num, size }); }
      else throw Error(`Unsupported LevelDB manifest tag ${tag}`);
    }
  }
  if (log === undefined) throw Error('Manifest has no live log number');
  return { files: [...files.values()], log, prev };
}
function handle(b) { const c = new Cursor(b); return [c.varint(), c.varint()]; }
function tableBlock(b, [offset, size]) {
  if (size > MAX_BYTES || offset + size + 5 > b.length) throw Error('Invalid table block size');
  const data = b.subarray(offset, offset + size), type = b[offset + size];
  if (maskedCrc(b.subarray(offset, offset + size + 1)) !== b.readUInt32LE(offset + size + 1)) throw Error('Table checksum mismatch');
  if (type === 0) return data;
  if (type === 1) { const c = new Cursor(data); if (c.varint() > MAX_BYTES) throw Error('Table expands beyond size limit'); return Buffer.from(snappy.uncompress(data)); }
  throw Error(`Unsupported table compression ${type}`);
}
export function blockEntries(b) {
  if (b.length < 4) throw Error('Truncated table block');
  const restarts = b.readUInt32LE(b.length - 4), end = b.length - 4 * (restarts + 1);
  if (end < 0 || !restarts) throw Error('Invalid table restarts');
  const c = new Cursor(b.subarray(0, end)), out = []; let previous = Buffer.alloc(0);
  while (c.o < end) {
    const shared = c.varint(), fresh = c.varint(), size = c.varint();
    if (shared > previous.length) throw Error('Invalid table prefix');
    const key = Buffer.concat([previous.subarray(0, shared), c.take(fresh)]), value = c.take(size);
    out.push({ key, value }); previous = key;
  }
  return out;
}
export function tableRecords(b) {
  if (b.length < 48 || b.readBigUInt64LE(b.length - 8) !== 0xdb4775248b80fb57n) throw Error('Unsupported SST table format');
  const footer = new Cursor(b.subarray(b.length - 48)); footer.varint(); footer.varint();
  const index = [footer.varint(), footer.varint()]; const out = [];
  for (const e of blockEntries(tableBlock(b, index))) {
    for (const r of blockEntries(tableBlock(b, handle(e.value)))) {
      if (r.key.length < 8) throw Error('Invalid internal key');
      const tag = r.key.readBigUInt64LE(r.key.length - 8), type = Number(tag & 255n);
      if (type !== 0 && type !== 1) throw Error('Unsupported table value type');
      out.push({ key: r.key.subarray(0, -8), value: r.value, seq: tag >> 8n, type });
    }
  }
  return out;
}
export function batchRecords(b) {
  if (b.length < 12) throw Error('Invalid write batch');
  const seq = b.readBigUInt64LE(0), count = b.readUInt32LE(8), c = new Cursor(b); c.o = 12;
  const out = [];
  for (let i = 0; i < count; i++) { const type = c.byte(); if (type !== 0 && type !== 1) throw Error('Unsupported WAL value type'); const key = c.bytes(), value = type ? c.bytes() : Buffer.alloc(0); out.push({ key, value, seq: seq + BigInt(i), type }); }
  if (c.o !== b.length) throw Error('Trailing write batch data');
  return out;
}
export function latestRecords(records) {
  const latest = new Map();
  for (const r of records) { const key = r.key.toString('hex'), old = latest.get(key); if (!old || r.seq > old.seq) latest.set(key, r); }
  return [...latest.values()].filter(r => r.type === 1);
}
function signature(file) { const s = fs.statSync(file, { bigint: true }); return `${s.size}:${s.mtimeNs}:${s.ino}`; }
export function snapshotRecords(dir) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const signatures = new Map(); let bytes = 0;
      function read(name) {
        const file = path.join(dir, name), sig = signature(file), size = Number(fs.statSync(file).size);
        bytes += size; if (bytes > MAX_BYTES) throw Error('GitHub Desktop database exceeds 256 MiB read limit');
        const b = fs.readFileSync(file); if (signature(file) !== sig || b.length !== size) throw Error('Database changed while reading'); signatures.set(file, sig); return b;
      }
      const current = read('CURRENT').toString('utf8').trim();
      if (!/^MANIFEST-\d+$/.test(current)) throw Error('Invalid CURRENT manifest');
      const manifest = readManifest(read(current)); const names = fs.readdirSync(dir).sort();
      const records = [];
      for (const f of manifest.files) { const stem = String(f.num).padStart(6, '0'); const name = names.includes(`${stem}.ldb`) ? `${stem}.ldb` : `${stem}.sst`; const b = read(name); if (b.length !== f.size) throw Error('Table size differs from manifest'); records.push(...tableRecords(b)); }
      const logs = names.filter(n => /^\d+\.log$/.test(n) && (+n.split('.')[0] >= manifest.log || +n.split('.')[0] === manifest.prev));
      if (!logs.length && manifest.log) throw Error('Live log file missing');
      for (const log of logs) for (const r of logRecords(read(log))) records.push(...batchRecords(r));
      if (fs.readdirSync(dir).sort().join('\n') !== names.join('\n')) throw Error('Database files changed while reading');
      for (const [file, sig] of signatures) if (signature(file) !== sig) throw Error('Database changed while reading');
      return latestRecords(records);
    } catch (e) { last = e; }
  }
  throw Error(`Cannot read a consistent GitHub Desktop database: ${last.message}`);
}
function little(b) { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('IndexedDB identifier too large'); return Number(n); }
function utf16(b) { if (b.length % 2) throw Error('Invalid UTF-16 metadata'); return Buffer.from(b).swap16().toString('utf16le'); }
export function keyPrefix(key) { const c = new Cursor(key), sizes = c.byte(); const db = little(c.take((sizes >> 5) + 1)), store = little(c.take(((sizes >> 2) & 7) + 1)), index = little(c.take((sizes & 3) + 1)); return { db, store, index, rest: key.subarray(c.o) }; }
export function decodeValue(value) {
  const c = new Cursor(value); c.varint();
  if (c.byte() !== 255) throw Error('Unsupported IndexedDB value envelope');
  const version = c.varint();
  if (version < 16 || version > 21) throw Error(`Unsupported Blink wire version ${version}`);
  if (version >= 21) { if (c.byte() !== 254) throw Error('Invalid Blink trailer'); const offset = c.take(8).readBigUInt64BE(), length = c.take(4).readUInt32BE(); if (offset || length) throw Error('External Blink data is unsupported'); }
  return v8.deserialize(value.subarray(c.o));
}
export function repositoriesFromRecords(records) {
  const decoded = records.map(r => ({ ...r, prefix: keyPrefix(r.key) }));
  const dbs = [];
  for (const r of decoded) {
    const p = r.prefix;
    if (!p.db && !p.store && !p.index && p.rest[0] === 201) { const c = new Cursor(p.rest.subarray(1)); const origin = utf16(c.take(c.varint() * 2)), name = utf16(c.take(c.varint() * 2)); dbs.push({ id: little(r.value), origin, name }); }
  }
  const matching = dbs.filter(d => d.name === 'Database');
  if (matching.length !== 1) throw Error(`Expected one GitHub Desktop Database; found ${matching.length}`);
  const db = matching[0]; let store;
  for (const r of decoded) { const p = r.prefix; if (p.db === db.id && !p.store && !p.index && p.rest[0] === 50) { const c = new Cursor(p.rest.subarray(1)), id = c.varint(), type = c.byte(); if (type === 0 && utf16(r.value) === 'repositories') { if (store !== undefined) throw Error('Ambiguous repository store'); store = id; } } }
  if (store === undefined) throw Error('Repository object store missing');
  const repos = [];
  for (const r of decoded) {
    const p = r.prefix; if (p.db !== db.id || p.store !== store || p.index !== 1) continue;
    if (p.rest.length !== 9 || p.rest[0] !== 3) throw Error('Unsupported repository key');
    const id = p.rest.readDoubleLE(1), obj = decodeValue(r.value);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof obj?.path !== 'string' || !path.isAbsolute(obj.path)) throw Error('Invalid repository record');
    if (obj.id !== undefined && obj.id !== id) throw Error('Repository identity mismatch');
    repos.push({ id: String(id), name: obj.alias || path.basename(obj.path), path: obj.path, desktopMissing: !!obj.missing, exists: fs.existsSync(obj.path), isWorktree: !!obj.mainWorktreePath, mainWorktreePath: obj.mainWorktreePath || null });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function defaultDatabasePath() { if (process.env.GITHUB_DESKTOP_DB_PATH) return path.resolve(process.env.GITHUB_DESKTOP_DB_PATH); if (!process.env.APPDATA) throw Error('APPDATA is unavailable; configure GITHUB_DESKTOP_DB_PATH'); return path.join(process.env.APPDATA, 'GitHub Desktop', 'IndexedDB', 'file__0.indexeddb.leveldb'); }
export function readRepositories(dir = defaultDatabasePath()) { return { source: 'GitHub Desktop registered repositories', databasePath: dir, readAt: new Date().toISOString(), repositories: repositoriesFromRecords(snapshotRecords(dir)) }; }
