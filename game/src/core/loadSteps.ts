/**
 * FEAT-377: the load's named steps on the performance timeline, as `load: <step>` measures from `start` (a
 * performance.now()) to now. tools/loadperf.mjs reads them back with the long tasks; a DevTools trace shows them
 * under Timings. Free when nothing reads them.
 */
export function loadStep(step: string, start: number): void {
  performance.measure(`load: ${step}`, { start });
}

/** `f()` timed as a load step */
export function timedStep<T>(step: string, f: () => T): T {
  const t0 = performance.now();
  try { return f(); } finally { loadStep(step, t0); }
}
