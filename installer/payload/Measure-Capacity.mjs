import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCollectorCache } from './collector-cache.mjs';
import { createMonitorScheduler } from './monitor-scheduler.mjs';
import { renderFleetCard } from './fleet-ui.js';

export async function measureCapacity({ servers = 100, cycles = 3, latencyMs = 2, maxConcurrent = 2 } = {}) {
  for (const [key, value, min, max] of [['servers', servers, 1, 5000], ['cycles', cycles, 1, 20], ['latencyMs', latencyMs, 0, 100], ['maxConcurrent', maxConcurrent, 1, 2]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be ${min}-${max}`);
  }
  let clock = Date.now(), active = 0, peak = 0, collections = 0, observations = 0;
  const fixtures = Array.from({ length: servers }, (_, i) => ({
    id: `synthetic-${i}`, name: `Synthetic ${i}`, server: `fixture-${i}`,
    connectionType: i % 3 === 0 ? 'azure-sqldb' : i % 3 === 1 ? 'azure-mi' : 'sql-server',
    engineEdition: i % 3 === 0 ? 5 : i % 3 === 1 ? 8 : 3,
    monitoringPaused: i % 17 === 0,
  }));
  const cache = createCollectorCache(async cfg => {
    active++; peak = Math.max(peak, active); collections++;
    try {
      if (latencyMs) await delay(latencyMs);
      return { server_id: cfg.id, generated_at: new Date(clock).toISOString(),
        engine_edition: cfg.engineEdition, instance: { user_sessions: 5, active_requests: 1, blocked_requests: 0, avg_cpu_percent: 10 } };
    } finally { active--; }
  }, { now: () => clock, maxConcurrent });
  const monitor = createMonitorScheduler({
    loadServers: async () => fixtures, collect: cfg => cache.get(cfg), now: () => clock, maxConcurrent,
    onSample: () => { observations++; }, health: () => ({ level: 'healthy', warning: [], critical: [] }),
    setTimer: () => null, clearTimer: () => {},
  });
  const cpu = process.cpuUsage(), memoryBefore = process.memoryUsage().rss, started = performance.now();
  let renderMs = 0, snapshot;
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      // Duplicate viewers must share the same queued work and cached snapshot.
      await Promise.all([monitor.requestRefresh(), monitor.requestRefresh(), monitor.requestRefresh()]);
      while (monitor.stats().pending) await delay(1);
      await delay(0);
      snapshot = await monitor.snapshot();
      const renderStart = performance.now();
      snapshot.servers.map(renderFleetCard).join('');
      renderMs += performance.now() - renderStart;
      clock += 60000;
    }
    const expectedCollections = fixtures.filter(cfg => !cfg.monitoringPaused).length * cycles;
    if (peak > maxConcurrent || collections !== expectedCollections) throw new Error('Collection budget or deduplication invariant failed');
    if (snapshot.servers.some(cfg => cfg.trends.length > 30)) throw new Error('Trend retention invariant failed');
    const usedCpu = process.cpuUsage(cpu);
    return {
      fixturesOnly: true, note: 'Synthetic scheduler/cache/HTML workload. Not a live SQL overhead test or production-capacity certification.',
      servers, cycles, latencyMs, maxConcurrent, peakConcurrent: peak, collections, expectedCollections, observations,
      pausedServers: fixtures.filter(cfg => cfg.monitoringPaused).length,
      elapsedMs: Math.round(performance.now() - started), htmlGenerationMs: Math.round(renderMs),
      cpuMs: Math.round((usedCpu.user + usedCpu.system) / 1000),
      rssBeforeMb: Math.round(memoryBefore / 1048576), rssAfterMb: Math.round(process.memoryUsage().rss / 1048576),
      budgetsRespected: true, duplicateViewersDeduplicated: true,
    };
  } finally { monitor.stop(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (const argument of process.argv.slice(2)) {
    const match = /^--(servers|cycles|latencyMs|maxConcurrent)=(\d+)$/.exec(argument);
    if (!match) throw new Error('Use --servers=100 --cycles=3 --latencyMs=2 --maxConcurrent=2');
    args[match[1]] = Number(match[2]);
  }
  console.log(JSON.stringify(await measureCapacity(args), null, 2));
}
