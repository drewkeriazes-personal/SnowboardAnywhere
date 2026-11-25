/** FEAT-377: tools/source_hashes.mjs, a hash per source file (path under src/) over it and its relative imports */
declare module 'virtual:source-hashes' {
  const hashes: Record<string, string>;
  export default hashes;
}
