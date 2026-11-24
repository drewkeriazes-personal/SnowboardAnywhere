import { REVISION } from 'three';
import sourceHashes from 'virtual:source-hashes';

/**
 * FEAT-377: what a resort load builds that is worth keeping for the next load (Settings > Graphics > Keep built
 * resort data), in IndexedDB. An entry is never stale: its key holds the pack's `meta.build`, the settings that change
 * it, three.js's version and a hash of the code that made it (tools/source_hashes.mjs: the producer modules and what
 * they import, so an edit in dev or a new build with changed code throws it away), and the entry stores that key and
 * FORMAT, both checked on read. A mismatch, a read error or a write error (quota, a private window) just builds it.
 * One entry per pack and kind: a new key replaces the old entry, so nothing piles up. An entry not used for
 * BUILT_MAX_AGE_DAYS is deleted (`expireBuilt`, once the game is up): every port is its own origin, so a test server
 * would otherwise leave its 50 MB of Vail behind for good.
 */
const DB = 'built-resort-data';
const STORE = 'entries';
/** when each entry was last saved or read, apart from the entries so a read does not rewrite the data: { id, usedAt } */
const USED = 'used';
/** an entry unused this long is deleted (one without a `usedAt`, from before it was kept, counts as unused) */
export const BUILT_MAX_AGE_DAYS = 14;
const DAY_MS = 86400000;
/** 'change' when entries are deleted (Settings' size readout) */
export const builtDataChanged = new EventTarget();
/** the entry layout; a change here drops every saved entry */
const FORMAT = 1;

export interface BuiltKey {
  /** what it is ('cloud noise'); with `slug` the entry's id */
  what: string;
  /** the pack it belongs to and its meta.build ('' for data that is the same for every pack) */
  slug?: string;
  build?: string;
  /** the settings that change it */
  settings?: Record<string, string | number | boolean | null>;
  /** the modules that make it, as paths under src/ ('world/Clouds.ts'); each one's hash covers its relative imports */
  code: string[];
}

interface Entry { id: string; format: number; key: string; bytes: number; data: unknown }

let keep = true;
/** the setting: off, nothing is read or written (and every load builds everything) */
export function setKeepBuiltData(on: boolean): void { keep = on; }

let db: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('bytes', 'bytes'); // sizes without reading the data
      if (!d.objectStoreNames.contains(USED)) d.createObjectStore(USED, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.catch(() => { db = null; });
  return db;
}
function request<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return both(mode, (tx) => f(tx.objectStore(store))).then((r) => r.result);
}
/** one transaction over the entries and their `usedAt` (readwrite ones run one at a time, so a save and the expiry never interleave) */
function both<T>(mode: IDBTransactionMode, f: (tx: IDBTransaction) => T): Promise<T> {
  return open().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction([STORE, USED], mode), out = f(tx);
    tx.oncomplete = () => resolve(out);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}

/** the key as stored: every part that must match, in a fixed order */
function keyOf(k: BuiltKey): string {
  const code = k.code.map((f) => {
    const h = sourceHashes[f];
    if (!h) throw new Error(`builtData: no source hash for ${f}`); // a renamed module must not silently match nothing
    return `${f}:${h}`;
  });
  return JSON.stringify({ what: k.what, slug: k.slug ?? '', build: k.build ?? '', settings: k.settings ?? {}, code, three: REVISION });
}

/** bytes in the typed arrays of `v` (what an entry costs on disk, near enough) */
function bytesOf(v: unknown): number {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + bytesOf(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n: number, x) => n + bytesOf(x), 0);
  return 8;
}

/**
 * The saved data for this key, or null (none saved, stale, the setting off, or a read error; the log says which). The
 * caller builds it then, and may `saveBuilt` it.
 */
export async function loadBuilt<T>(k: BuiltKey): Promise<T | null> {
  if (!keep) return null;
  const id = idOf(k), key = keyOf(k);
  let why = 'none saved';
  try {
    const e = await (reads.get(id) ?? read(id));
    reads.delete(id);
    if (e && e.format === FORMAT && e.key === key) { console.info(`built data: ${id} from the last load`); touch(id); return e.data as T; }
    if (e) why = e.format !== FORMAT ? 'format changed' : staleReason(e.key, key);
  } catch { why = 'read failed'; }
  console.info(`built data: ${id} to build (${why})`); // tools/loadperf.mjs prints these
  return null;
}

/** Keep `data` for the next load under this key, replacing what that pack and kind had. It is copied at once. */
export function saveBuilt(k: BuiltKey, data: unknown): void {
  if (!keep) return;
  const entry: Entry = { id: idOf(k), format: FORMAT, key: keyOf(k), bytes: bytesOf(data), data };
  // the entry and its usedAt in one transaction, so the expiry pass can never see one without the other
  try { both('readwrite', (tx) => { tx.objectStore(STORE).put(entry); tx.objectStore(USED).put({ id: entry.id, usedAt: Date.now() }); }).catch(() => { /* quota or no IndexedDB: the next load builds it again */ }); } catch { /* not cloneable */ }
}

/** this entry was used now (a few bytes in USED, so a read does not rewrite the entry) */
function touch(id: string): void {
  request('readwrite', (s) => s.put({ id, usedAt: Date.now() }), USED).catch(() => {});
}

/** Delete the entries unused for BUILT_MAX_AGE_DAYS (after the load: never in its way) */
export async function expireBuilt(): Promise<void> {
  try {
    const ids = (await request('readonly', (s) => s.getAllKeys())) as string[];
    let gone = 0;
    for (const id of ids) {
      // read usedAt and delete in the same transaction: a save or read since the listing has refreshed it, and is kept
      const days = await both('readwrite', (tx) => {
        const out = { days: 0 };
        const r = tx.objectStore(USED).get(id);
        r.onsuccess = () => {
          const at = (r.result as { usedAt?: number } | undefined)?.usedAt;
          out.days = at === undefined ? Infinity : (Date.now() - at) / DAY_MS;
          if (out.days >= BUILT_MAX_AGE_DAYS) { tx.objectStore(STORE).delete(id); tx.objectStore(USED).delete(id); }
        };
        return out;
      }).then((o) => o.days);
      if (days < BUILT_MAX_AGE_DAYS) continue;
      console.info(`built data: expired ${id} (${Number.isFinite(days) ? Math.floor(days) : 'unknown'} days unused)`);
      gone++;
    }
    if (gone) builtDataChanged.dispatchEvent(new Event('change'));
  } catch { /* no IndexedDB */ }
}

/**
 * The saved `make()` for this key, or `make()` built now and saved for next time. Its result must be structured-
 * cloneable (typed arrays, plain objects).
 */
export async function builtData<T>(k: BuiltKey, make: () => T | Promise<T>): Promise<T> {
  const saved = await loadBuilt<T>(k);
  if (saved !== null) return saved;
  const data = await make();
  saveBuilt(k, data);
  return data;
}

const idOf = (k: BuiltKey): string => `${k.slug ?? ''}/${k.what}`;
const read = (id: string): Promise<Entry | undefined> => request<Entry | undefined>('readonly', (s) => s.get(id));
/** reads started before their key is known (`prefetchBuilt`) */
const reads = new Map<string, Promise<Entry | undefined>>();

/** Start reading these entries now (opening the database on a first visit takes a while), for `loadBuilt` later */
export function prefetchBuilt(slug: string, what: string[]): void {
  if (!keep) return;
  for (const w of what) { const id = `${slug}/${w}`, r = read(id); r.catch(() => {}); reads.set(id, r); }
}

/** which part of the key changed (the log only) */
function staleReason(was: string, now: string): string {
  try {
    const a = JSON.parse(was), b = JSON.parse(now);
    const diff = Object.keys(b).filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    return `${diff.join(', ')} changed`;
  } catch { return 'key changed'; }
}

/** Settings' Clear: every saved entry gone (the next load builds everything) */
export async function clearBuiltData(): Promise<void> {
  await both('readwrite', (tx) => { tx.objectStore(STORE).clear(); tx.objectStore(USED).clear(); }).catch(() => {});
}

/** bytes saved, for Settings (0 when none or no IndexedDB): summed over the `bytes` index, so no entry's data is read */
export async function builtDataBytes(): Promise<number> {
  let n = 0;
  try {
    await request('readonly', (s) => {
      const c = s.index('bytes').openKeyCursor();
      c.onsuccess = () => { if (c.result) { n += c.result.key as number; c.result.continue(); } };
      return c;
    });
  } catch { /* none */ }
  return n;
}
