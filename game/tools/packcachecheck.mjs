// FEAT-375 packcachecheck: the pack servers' validators (pack_routes.mjs notModified, packFiles) on a throwaway pack
// in a temp folder, over real HTTP: a pack file comes with an ETag and Last-Modified and no-cache, a request that
// names them gets 304 and no body, and a pack rebuilt on disk is never served stale: a file whose size changed, and a
// file swapped for other bytes of the same size with its old mtime put back (an archive's mtimes carried over) under
// a new meta.build, both answer 200 with the new bytes. The launcher's built-asset rule (tools/launcher.mjs) is read
// from its source. Node only (no pack, no browser, no network); exits 1 on a failure.
//   node tools/packcachecheck.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { packFiles } from './pack_routes.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

const packs = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
const dir = path.join(packs, 'test');
fs.mkdirSync(path.join(dir, 'fine'), { recursive: true });
const tile = path.join(dir, 'fine', '0_0.png'), meta = path.join(dir, 'meta.json');
fs.writeFileSync(meta, JSON.stringify({ slug: 'test', build: 'b1' }));
fs.writeFileSync(tile, 'AAAA');
fs.writeFileSync(path.join(packs, 'index.json'), '[]');

const handler = packFiles(packs);
const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/packs`;
const get = async (p, headers = {}) => { const r = await fetch(`${base}/${p}`, { headers }); return { r, body: await r.text() }; };

try {
  let { r, body } = await get('test/fine/0_0.png');
  const etag = r.headers.get('etag'), lm = r.headers.get('last-modified');
  ok(r.status === 200 && body === 'AAAA', 'first load: 200 with the bytes');
  ok(r.headers.get('cache-control') === 'no-cache', 'cache-control stays no-cache (revalidate every load)');
  ok(!!etag && etag.includes('b1'), `ETag carries the pack's meta.build (${etag})`);
  ok(!!lm && !Number.isNaN(Date.parse(lm)), `Last-Modified set (${lm})`);

  ({ r, body } = await get('test/fine/0_0.png', { 'if-none-match': etag }));
  ok(r.status === 304 && body === '', 'If-None-Match with the ETag: 304, no body');
  ({ r } = await get('test/fine/0_0.png', { 'if-none-match': `W/${etag}, "other"` }));
  ok(r.status === 304, 'a weak or listed ETag matches too');
  ({ r } = await get('test/fine/0_0.png', { 'if-modified-since': lm }));
  ok(r.status === 200, 'If-Modified-Since alone is not trusted for a pack file (blind to a new build)');
  ({ r } = await get('index.json', { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() }));
  ok(r.status === 304, 'If-Modified-Since answers a file outside any pack (packs/index.json)');
  ({ r } = await get('test/fine/0_0.png', { 'if-none-match': '"stale"', 'if-modified-since': lm }));
  ok(r.status === 200, 'If-None-Match wins over If-Modified-Since');

  // a file of a new size (an `npm run get` or Download over the pack): a new ETag, the new bytes
  const T = new Date('2026-01-01T00:00:00Z'); // a whole-second mtime, so utimes can put it back exactly
  fs.writeFileSync(tile, 'BBBBBB');
  fs.utimesSync(tile, T, T);
  ({ r, body } = await get('test/fine/0_0.png', { 'if-none-match': etag }));
  ok(r.status === 200 && body === 'BBBBBB', 'a file whose size changed: 200 with the new bytes');
  const etag2 = r.headers.get('etag');

  // the worry: other bytes of the same size with the old mtime put back, under a new build
  fs.writeFileSync(tile, 'CCCCCC');
  fs.utimesSync(tile, T, T);
  ({ r } = await get('test/fine/0_0.png', { 'if-none-match': etag2 }));
  ok(r.status === 304, 'same size and mtime, same build: 304 (what the ETag cannot see without a new build)');
  fs.writeFileSync(meta, JSON.stringify({ slug: 'test', build: 'b2' }));
  ({ r, body } = await get('test/fine/0_0.png', { 'if-none-match': etag2 }));
  ok(r.status === 200 && body === 'CCCCCC', 'same size and mtime under a new meta.build: 200 with the new bytes');
  ok(r.headers.get('etag')?.includes('b2'), `the new ETag names the new build (${r.headers.get('etag')})`);

  ({ r } = await get('test/fine/nope.png'));
  ok(r.status === 404, 'a missing file is still a 404');
} finally {
  server.close();
  fs.rmSync(packs, { recursive: true, force: true });
}

const launcher = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
ok(/startsWith\('\/assets\/'\) \? 'public, max-age=31536000, immutable' : 'no-cache'/.test(launcher), 'launcher: hashed assets/ immutable, the rest no-cache');
ok(/TYPES\['\.html'\]\); res\.setHeader\('cache-control', 'no-cache'\)/.test(launcher), 'launcher: index.html no-cache');

if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log('packcachecheck: all passed');
