// FEAT-377: the virtual module `virtual:source-hashes`, a hash per game source file (src/**/*.ts) over its own text and
// that of every file it imports with a relative path, so what the game keeps between loads (src/core/builtData.ts)
// is thrown away when the code that made it changes. Build and dev server both; in dev an edited file invalidates the
// module, so the next page load gets the new hashes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID = 'virtual:source-hashes', RESOLVED = '\0' + ID;
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** { 'world/Clouds.ts': 'hash', ... } for every .ts under srcDir, each over its relative-import closure */
export function sourceHashes(srcDir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(p); } };
  walk(srcDir);
  const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const deps = new Map();
  for (const [f, t] of text) {
    const out = [];
    for (const m of t.matchAll(IMPORT)) {
      const base = path.resolve(path.dirname(f), m[1] ?? m[2]);
      const hit = [base, `${base}.ts`, path.join(base, 'index.ts')].find((c) => text.has(c));
      if (hit) out.push(hit);
    }
    deps.set(f, out);
  }
  const hashes = {};
  for (const f of files) {
    const seen = new Set([f]), queue = [f];
    for (let i = 0; i < queue.length; i++) for (const d of deps.get(queue[i])) if (!seen.has(d)) { seen.add(d); queue.push(d); }
    const h = crypto.createHash('sha256');
    for (const d of [...seen].sort()) h.update(path.relative(srcDir, d)).update('\0').update(text.get(d)).update('\0');
    hashes[path.relative(srcDir, f).split(path.sep).join('/')] = h.digest('hex').slice(0, 16);
  }
  return hashes;
}

/** the Vite plugin serving it */
export function sourceHashesPlugin(srcDir) {
  return {
    name: 'source-hashes',
    resolveId(id) { return id === ID ? RESOLVED : null; },
    load(id) { return id === RESOLVED ? `export default ${JSON.stringify(sourceHashes(srcDir))};` : null; },
    configureServer(server) {
      const stale = (f) => {
        if (!path.resolve(f).startsWith(srcDir + path.sep)) return;
        const m = server.moduleGraph.getModuleById(RESOLVED);
        if (m) server.moduleGraph.invalidateModule(m);
      };
      for (const ev of ['change', 'add', 'unlink']) server.watcher.on(ev, stale);
    },
  };
}
