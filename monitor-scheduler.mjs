import { configIdentity, createAsyncLimiter } from './collector-cache.mjs';
import { classifySqlEndpoint } from './sql-endpoint.js';

const number = value => value != null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
const TREND_LIMIT = 30;
function compactMetrics(data) {
  const i = data?.instance || {};
  return {
    cpuPct: number(i.avg_cpu_percent), memPct: number(i.avg_memory_percent),
    ple: number(i.page_life_expectancy), memMb: number(i.memory_in_use_mb),
    sessions: number(i.user_sessions), active: number(i.active_requests), blocked: number(i.blocked_requests),
    ioPct: number(i.avg_data_io_percent), logPct: number(i.avg_log_write_percent),
  };
}

export function createMonitorScheduler({
  loadServers, collect, health = () => ({ level: 'unknown', label: 'Unknown', critical: [], warning: [] }),
  now = Date.now, intervalSeconds = 60, maxConcurrent = 2, onSample, onError,
  setTimer = setTimeout, clearTimer = clearTimeout, redactError = () => 'Collection failed; see server details',
  canCollect = () => true,
} = {}) {
  const samples = new Map(), pending = new Map(), generations = new Map(), trends = new Map();
  const limited = createAsyncLimiter(maxConcurrent);
  let servers = [], enabled = false, timer, viewingUntil = 0, lastCycleAt = null, refreshing = null;
  let lastSchedulerError = null, completed = 0, failed = 0;
  const durations = [];
  const callbacks = new Set();
  let interval = validInterval(intervalSeconds);
  let stopped = false;
  function validInterval(value) {
    if (!Number.isInteger(value) || value < 30 || value > 3600) throw new Error('Monitor interval must be 30–3600 seconds');
    return value;
  }
  function currentJob(job) {
    return generations.get(job.server.id) === job.generation &&
      servers.some(server => server.id === job.server.id && configIdentity(server) === job.identity);
  }
  function notify(callback, ...args) {
    if (!callback) return;
    const pending = Promise.resolve().then(() => callback(...args)).catch(error => {
      lastSchedulerError = redactError(error);
      console.error('Monitor sample processing failed:', lastSchedulerError);
    }).finally(() => callbacks.delete(pending));
    callbacks.add(pending);
  }
  function acceptSample(server, data) {
    if (!canCollect()) return;
    const identity = configIdentity(server), previous = samples.get(server.id);
    if (previous?.identity === identity && previous.data === data && !previous.error) return;
    if (previous?.identity === identity && data?.generated_at &&
        previous.data?.generated_at === data.generated_at && !previous.error) return;
    const t = Number.isFinite(Date.parse(data?.generated_at)) ? Date.parse(data.generated_at) : now();
    samples.set(server.id, { identity, data, at: t, attemptedAt: now() });
    const ring = trends.get(server.id)?.identity === identity ? trends.get(server.id).points : [];
    if (!ring.some(point => point.t === t)) ring.push({ t, ...compactMetrics(data) });
    ring.sort((a, b) => a.t - b.t);
    if (ring.length > TREND_LIMIT) ring.splice(0, ring.length - TREND_LIMIT);
    trends.set(server.id, { identity, points: ring });
    const current = servers.find(item => item.id === server.id) || server;
    if (!server.monitoringPaused && !current.monitoringPaused) notify(onSample, current, data);
  }
  function invalidate(id) {
    generations.set(id, (generations.get(id) || 0) + 1);
    samples.delete(id);
    trends.delete(id);
  }
  function enqueue(server, force) {
    if (server.monitoringPaused || !canCollect()) return;
    const identity = configIdentity(server), sample = samples.get(server.id);
    const age = now() - (sample?.attemptedAt ?? -Infinity);
    if (pending.has(server.id) || (sample?.identity === identity && age < (force ? 15000 : 30000))) return;
    if (!generations.has(server.id)) generations.set(server.id, 0);
    const job = { server, identity, generation: generations.get(server.id) };
    pending.set(server.id, job);
    job.promise = limited(async () => {
      if (stopped || !canCollect() || !currentJob(job) || servers.find(item => item.id === server.id)?.monitoringPaused) return;
      job.started = true;
      job.startedAt = now();
      try {
        const data = await collect(server, force ? 15000 : 30000);
        completed++;
        if (currentJob(job)) acceptSample(server, data);
      } catch (error) {
        if (!canCollect() || !currentJob(job) || servers.find(item => item.id === server.id)?.monitoringPaused || error.monitoringPaused || error.azureRequired) return;
        failed++;
        const old = samples.get(server.id);
        samples.set(server.id, {
          identity, data: old?.identity === identity ? old.data : undefined,
          at: old?.identity === identity ? old.at : undefined, attemptedAt: now(),
          error: redactError(error, server),
        });
        const ring = trends.get(server.id)?.identity === identity ? trends.get(server.id).points : [];
        ring.push({ t: now(), ...compactMetrics(null) });
        if (ring.length > TREND_LIMIT) ring.splice(0, ring.length - TREND_LIMIT);
        trends.set(server.id, { identity, points: ring });
        notify(onError, server, error);
      } finally {
        durations.push(Math.max(0, now() - job.startedAt));
        if (durations.length > 100) durations.shift();
        lastCycleAt = new Date(now()).toISOString();
      }
    }).finally(() => {
      if (pending.get(server.id) === job) pending.delete(server.id);
      arm();
    });
    job.promise.catch(error => {
      lastSchedulerError = redactError(error);
      console.error('Monitor queued collection failed:', lastSchedulerError);
    });
  }
  async function reconcile() {
    servers = await loadServers();
    const ids = new Set(servers.map(server => server.id));
    for (const id of samples.keys()) if (!ids.has(id)) invalidate(id);
    for (const server of servers) {
      if (samples.has(server.id) && samples.get(server.id).identity !== configIdentity(server)) invalidate(server.id);
    }
    return servers;
  }
  function requestRefresh(ids, { force = false, viewing = false } = {}) {
    if (viewing) viewingUntil = now() + 60000;
    stopped = false;
    if (refreshing) return refreshing;
    refreshing = reconcile().then(list => {
      lastSchedulerError = null;
      const selected = ids ? new Set(ids) : null;
      for (const server of list) if (!selected || selected.has(server.id)) enqueue(server, force);
    }).finally(() => { refreshing = null; arm(); });
    // A bad registry must not produce an unhandled background rejection.
    refreshing.catch(error => {
      lastSchedulerError = redactError(error);
      console.error('Monitor registry refresh failed:', lastSchedulerError);
    });
    return refreshing;
  }
  function arm() {
    if (timer) clearTimer(timer);
    timer = undefined;
    if (stopped || !canCollect() || (!enabled && now() >= viewingUntil)) return;
    const delay = (enabled ? interval : 30) * 1000;
    timer = setTimer(() => {
      timer = undefined;
      if (enabled || now() < viewingUntil) requestRefresh();
    }, delay);
    timer?.unref?.();
  }
  function configure(settings = {}) {
    if (settings.intervalSeconds !== undefined) interval = validInterval(settings.intervalSeconds);
    if (settings.maxConcurrent !== undefined) limited.configure(settings.maxConcurrent);
    if (settings.enabled !== undefined) {
      if (typeof settings.enabled !== 'boolean') throw new Error('Monitor enabled must be a boolean');
      enabled = settings.enabled;
    }
    stopped = false;
    if (enabled) requestRefresh();
    arm();
    return { enabled, intervalSeconds: interval };
  }
  function stop() {
    stopped = true;
    enabled = false;
    viewingUntil = 0;
    if (timer) clearTimer(timer);
    timer = undefined;
  }
  async function snapshot() {
    const list = await reconcile();
    return {
      servers: list.map(server => {
        const sample = samples.get(server.id);
        const valid = sample?.identity === configIdentity(server), data = valid ? sample.data : undefined;
        const endpoint = classifySqlEndpoint(server.server, server.connectionType, data?.engine_edition ?? server.engineEdition);
        const result = data ? health(data) : { level: 'unknown', label: 'Unknown', critical: [], warning: [] };
        const healthSummary = {
          level: result.level, label: result.label,
          critical: Array.isArray(result.critical) ? result.critical.length : number(result.critical) ?? 0,
          warning: Array.isArray(result.warning) ? result.warning.length : number(result.warning) ?? 0,
        };
        const status = !canCollect() ? 'registration-required' : server.monitoringPaused ? 'paused' : valid && sample.error ? (data ? 'stale' : 'error')
          : !data ? 'loading' : now() - sample.at >= (enabled ? interval : 30) * 2000 ? 'stale' : 'ok';
        return {
          id: server.id, name: server.name, group: server.group || null, server: server.server,
          connectionType: server.connectionType || 'auto', engine: data?.engine || endpoint.kind,
          engineEdition: number(data?.engine_edition ?? server.engineEdition),
          service: endpoint.kind, status, health: healthSummary,
          monitoringPaused: server.monitoringPaused === true,
          collecting: pending.get(server.id)?.started === true,
          metrics: compactMetrics(data),
          trends: trends.get(server.id)?.identity === configIdentity(server) ? trends.get(server.id).points.map(point => ({ ...point })) : [],
          trendIntervalSeconds: enabled ? interval : 30,
          sampledAt: data?.generated_at || (data ? new Date(sample.at).toISOString() : null),
          collectMs: number(data?.collect_ms),
          ...(valid && sample.error ? { error: sample.error } : {}),
        };
      }),
      monitor: { enabled, intervalSeconds: interval, lastCycleAt, collecting: pending.size > 0, ...stats() },
    };
  }
  function stats() {
    const ordered = [...durations].sort((a, b) => a - b);
    return {
      enabled, intervalSeconds: interval, ...limited.stats(), pending: pending.size, processingSamples: callbacks.size, completed, failed,
      p95CollectionMs: ordered.length ? ordered[Math.ceil(ordered.length * .95) - 1] : null,
      oldestActiveMs: Math.max(0, ...[...pending.values()].filter(job => job.started).map(job => now() - job.startedAt)),
      lastError: lastSchedulerError,
    };
  }
  async function idle() {
    await Promise.allSettled([...pending.values()].map(job => job.promise));
    await Promise.allSettled([...callbacks]);
  }
  return { snapshot, requestRefresh, configure, start: configure, stop, invalidate, acceptSample, stats, idle };
}
