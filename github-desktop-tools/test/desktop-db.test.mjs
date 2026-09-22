import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import snappy from 'snappyjs';
import { maskedCrc, logRecords, batchRecords, latestRecords, readManifest, tableRecords, snapshotRecords, repositoriesFromRecords, decodeValue } from '../desktop-db.mjs';
const vi = n => { const out = []; do { let x = n % 128; n = Math.floor(n / 128); out.push(x | (n ? 128 : 0)); } while (n); return Buffer.from(out); };
const lp = b => Buffer.concat([vi(b.length), b]);
const buf = (...a) => Buffer.concat(a.map(x => typeof x === 'number' ? vi(x) : x));
function physical(data, type = 1) { const h = Buffer.alloc(7); h.writeUInt32LE(maskedCrc(buf(Buffer.from([type]), data))); h.writeUInt16LE(data.length, 4); h[6] = type; return buf(h, data); }
function batch(seq, entries) { const h = Buffer.alloc(12); h.writeBigUInt64LE(BigInt(seq)); h.writeUInt32LE(entries.length, 8); return buf(h, ...entries.map(e => buf(e.type, lp(e.key), ...(e.type ? [lp(e.value)] : [])))); }
function internal(key, seq, type = 1) { const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(seq) * 256n + BigInt(type)); return buf(key, n); }
function block(entries) { const restarts = Buffer.alloc(8); restarts.writeUInt32LE(1, 4); return buf(...entries.map(e => buf(0, e.key.length, e.value.length, e.key, e.value)), restarts); }
function trailer(data, compressed = false) { if (compressed) data = Buffer.from(snappy.compress(data)); const x = buf(data, Buffer.from([compressed ? 1 : 0])); const crc = Buffer.alloc(4); crc.writeUInt32LE(maskedCrc(x)); return buf(x, crc); }
function table(entries, compressed = true) { const data = trailer(block(entries), compressed), index = trailer(block([{ key: entries.at(-1).key, value: buf(0, data.length - 5) }])); const footer = Buffer.alloc(48); buf(0, 0, data.length, index.length - 5).copy(footer); footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40); return buf(data, index, footer); }
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-db-test-')); t.after(() => { if (path.dirname(dir) !== fs.realpathSync(os.tmpdir()) && path.dirname(dir) !== os.tmpdir()) throw Error('Unsafe test cleanup path'); fs.rmSync(dir, { recursive: true }); }); return dir; }
const key = Buffer.from('key');
test('WAL checksums and fragmented logical records are enforced', () => {
  const data = Buffer.alloc(40000, 42), first = physical(data.subarray(0, 32761), 2), last = physical(data.subarray(32761), 4);
  assert.deepEqual(logRecords(buf(first, last)), [data]);
  const bad = Buffer.from(first); bad[10] ^= 1; assert.throws(() => logRecords(bad), /checksum/);
  assert.throws(() => logRecords(first), /Incomplete/);
  assert.throws(() => logRecords(physical(data.subarray(0, 5), 3)), /fragment/);
  assert.throws(() => logRecords(last.subarray(0, -1)), /Incomplete/);
});
test('Write batch sequences and deletion tombstones select only live records', () => {
  const a = batchRecords(batch(10, [{ type: 1, key, value: Buffer.from('old') }, { type: 0, key }]));
  assert.equal(a[1].seq, 11n); assert.equal(latestRecords(a).length, 0);
  assert.equal(latestRecords([...a, { type: 1, key, value: Buffer.from('new'), seq: 12n }])[0].value.toString(), 'new');
  assert.throws(() => batchRecords(buf(batch(1, []), 0)), /Trailing/);
});
test('Compressed and uncompressed SST blocks preserve sequence and detect corruption', () => {
  for (const compressed of [false, true]) { const b = table([{ key: internal(key, 7), value: Buffer.from('value') }], compressed); const r = tableRecords(b); assert.equal(r[0].seq, 7n); assert.equal(r[0].value.toString(), 'value'); const bad = Buffer.from(b); bad[2] ^= 1; assert.throws(() => tableRecords(bad), /checksum/); }
});
test('Manifest deletion excludes obsolete tables and stale WAL cannot resurrect repositories', t => {
  const dir = temp(t), sst = table([{ key: internal(key, 7), value: Buffer.from('old') }]);
  const newFile = num => buf(7, 0, num, sst.length, lp(internal(key, 7)), lp(internal(key, 7)));
  const manifest = physical(buf(2, 5, newFile(3), newFile(4), 6, 0, 3));
  assert.deepEqual(readManifest(manifest).files.map(f => f.num), [4]);
  fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n'); fs.writeFileSync(path.join(dir, 'MANIFEST-000001'), manifest); fs.writeFileSync(path.join(dir, '000004.ldb'), sst);
  fs.writeFileSync(path.join(dir, '000002.log'), physical(batch(99, [{ type: 1, key, value: Buffer.from('stale') }])));
  fs.writeFileSync(path.join(dir, '000005.log'), physical(batch(8, [{ type: 0, key }])));
  assert.equal(snapshotRecords(dir).length, 0);
  fs.unlinkSync(path.join(dir, '000004.ldb')); assert.throws(() => snapshotRecords(dir), /consistent/);
});
function be(text) { return Buffer.from(text, 'utf16le').swap16(); }
function envelope(obj) { return buf(1, Buffer.from([255, 21, 254]), Buffer.alloc(12), v8.serialize(obj)); }
function fixtures(repoPath) {
  const record = (key, value) => ({ key, value, seq: 1n, type: 1 }); const numeric = Buffer.alloc(9); numeric[0] = 3; numeric.writeDoubleLE(42, 1);
  return [record(buf(Buffer.from([0, 0, 0, 0, 201]), 9, be('file__0@1'), 8, be('Database')), Buffer.from([2])), record(Buffer.from([0, 2, 0, 0, 50, 1, 0]), be('repositories')), record(buf(Buffer.from([0, 2, 1, 1]), numeric), envelope({ id: 42, path: repoPath, missing: true, alias: '中文 repo' }))];
}
test('IndexedDB metadata locates repository store and preserves missing registrations', t => {
  const p = path.join(temp(t), 'missing repo'); const repos = repositoriesFromRecords(fixtures(p));
  assert.equal(repos[0].id, '42'); assert.equal(repos[0].name, '中文 repo'); assert.equal(repos[0].exists, false); assert.equal(repos[0].desktopMissing, true);
  assert.throws(() => repositoriesFromRecords([]), /Expected one/);
});
test('Unsupported Blink envelope and external values fail explicitly', () => {
  assert.deepEqual(decodeValue(envelope({ path: 'test' })), { path: 'test' });
  const b = envelope({}); b[2] = 22; assert.throws(() => decodeValue(b), /version/);
  const c = envelope({}); c[4] = 1; assert.throws(() => decodeValue(c), /External/);
});
