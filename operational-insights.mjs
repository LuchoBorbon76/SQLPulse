import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createJsonStore } from './storage.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bad = message => Object.assign(new Error(message), { status: 400 });
const METRICS = { cpuPct: 'high', ioPct: 'high', logPct: 'high', blocked: 'high',
  active: 'high', sessions: 'high', ple: 'low', bhr: 'low', batchRequestsPerSec: 'high' };
const TYPES = new Set(['blocking', 'deadlock', 'query-summary', 'query-regression']);
function validReportState(state) {
  if (state?.version !== 1 || !Array.isArray(state.reports) || state.reports.length > 30 ||
    typeof state.config?.enabled !== 'boolean' || !['daily', 'weekly'].includes(state.config.cadence) ||
    !Number.isInteger(state.config.hourUTC) || state.config.hourUTC < 0 || state.config.hourUTC > 23 ||
    !(state.lastSlot === null || Number.isSafeInteger(state.lastSlot) && state.lastSlot >= 0) ||
    !(state.lastError === null || typeof state.lastError === 'string' && state.lastError.length <= 400)) return false;
  return state.reports.every(report => report && /^[0-9a-f-]{36}$/.test(report.id) &&
    Number.isSafeInteger(report.createdAt) && report.createdAt >= 0 && Number.isSafeInteger(report.from) &&
    Number.isSafeInteger(report.to) && report.from >= 0 && report.from < report.to &&
    report.sensitivePayloads === false && report.timeZone === 'UTC' && Array.isArray(report.servers) &&
    report.servers.length <= 100 && report.servers.every(server => server && typeof server.serverId === 'string' &&
      ['available', 'unavailable'].includes(server.status) && (server.status === 'unavailable'
        ? typeof server.reason === 'string' : server.coverage && server.metrics && server.baselines && server.evidence)));
}
const metric = (point, key) => key === 'batchRequestsPerSec'
  ? point.intervalMetrics?.batchRequestsPerSec : point[key];
const quantile = (values, fraction) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
};
const weekend = date => [0, 6].includes(date.getUTCDay());
export function insightTime(value, name = 'time') {
  const time = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) throw bad(`Invalid ${name}. Use epoch milliseconds.`);
  return time;
}

// Hourly averages are compared with hourly averages, never presented as raw percentiles.
export function workloadBaseline(points, current, at, gapThresholdMs = 180000) {
  const date = new Date(at), hourStart = Math.floor(at / HOUR) * HOUR;
  const candidates = points.filter(point => point.resolution === 'hour' && !point.gap && !point.reset &&
    !point.omittedMetrics && point.t >= at - 28 * DAY && (point.lastT ?? point.t) < hourStart &&
    finite(point.firstT) && finite(point.lastT) && point.lastT - point.firstT >= 30 * 60000 &&
    point.count >= 6 && weekend(new Date(point.t)) === weekend(date) &&
    Math.min(Math.abs(new Date(point.t).getUTCHours() - date.getUTCHours()),
      24 - Math.abs(new Date(point.t).getUTCHours() - date.getUTCHours())) <= 2);
  const result = {};
  for (const [key, direction] of Object.entries(METRICS)) {
    const validValue = value => finite(value) && value >= 0 &&
      (!(key.endsWith('Pct') || key === 'bhr') || value <= 100);
    const eligible = candidates.filter(point => finite(metric(point, key)) && metric(point, key) >= 0 &&
      validValue(metric(point, key)) &&
      (!point.stats || point.stats[key === 'batchRequestsPerSec' ? 'intervalMetrics.batchRequestsPerSec' : key]?.count >= 6));
    const values = eligible.map(point => metric(point, key));
    const days = new Set(eligible.map(point => new Date(point.t).toISOString().slice(0, 10))).size;
    const value = current && !current.reset && !current.gap && !current.omittedMetrics &&
      (current.lastT ?? current.t) <= at && at - (current.lastT ?? current.t) <= gapThresholdMs &&
      validValue(metric(current, key)) ? metric(current, key) : null;
    if (values.length < 6 || days < 3) {
      result[key] = { status: 'warming-up', current: value, buckets: values.length, days,
        reason: 'Need 6 covered hourly buckets across 3 comparable days. Static health/alert thresholds remain unchanged.' };
      continue;
    }
    const median = quantile(values, .5), mad = quantile(values.map(value => Math.abs(value - median)), .5);
    const margin = Math.max(3 * 1.4826 * mad, Math.abs(median) * .25, key.endsWith('Pct') || key === 'bhr' ? 5 : 1);
    const lower = Math.max(0, Math.min(quantile(values, .1), median - margin));
    let upper = Math.max(quantile(values, .9), median + margin);
    if (key.endsWith('Pct') || key === 'bhr') upper = Math.min(100, upper);
    result[key] = { status: value === null ? 'unavailable' : 'ready', current: value, median, lower, upper,
      buckets: values.length, samples: eligible.reduce((sum, point) => sum +
        (point.stats?.[key === 'batchRequestsPerSec' ? 'intervalMetrics.batchRequestsPerSec' : key]?.count ?? point.count), 0), days,
      anomaly: value === null ? null : direction === 'low' ? value < lower : value > upper,
      direction, percentChange: value !== null && median !== 0 ? (value - median) / Math.abs(median) * 100 : null };
  }
  return { at, method: 'UTC hour ±2; weekday/weekend; prior 28 days; median/MAD and p10/p90 of covered hourly averages',
    currentKind: current?.resolution === 'hour' ? 'hourly sample-weighted average' : 'raw recorded sample',
    advisoryOnly: true, metrics: result };
}

export function correlateEvidence(window, events, at) {
  const selected = window.points.filter(point => (point.lastT ?? point.t) <= at).at(-1);
  const fresh = selected && (!selected.gap || selected.resolution === 'raw') &&
    at - (selected.lastT ?? selected.t) <= window.gapThresholdMs;
  return {
    at, sampleAt: fresh ? selected.t : null,
    sampleStatus: fresh ? selected.resolution === 'raw' ? 'recorded' : 'average-only' : 'gap',
    waits: fresh && selected.resolution === 'raw' ? selected.visual?.intervals?.waits ?? null : null,
    waitWindow: fresh && selected.resolution === 'raw' && finite(selected.visual?.intervals?.elapsedSeconds) ?
      { from: selected.t - selected.visual.intervals.elapsedSeconds * 1000, to: selected.t } : null,
    sources: fresh ? selected.visual?.sectionMetadata ?? {} : {},
    events: events.filter(event => Date.parse(event.time) >= window.from && Date.parse(event.time) < window.to &&
      Date.parse(event.time) <= at).slice(0, 100),
    notice: 'Independent polls and Query Store windows are correlated by recorded times, not exact execution order. Host/SQL clock skew can affect alignment. Brief incidents may be missed. No live SQL is read.',
  };
}

export function dueReportSlot(now, config) {
  const date = new Date(now);
  let due = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), config.hourUTC);
  if (config.cadence === 'weekly') due -= ((new Date(due).getUTCDay() + 6) % 7) * DAY;
  if (due > now) due -= config.cadence === 'weekly' ? 7 * DAY : DAY;
  return due;
}

export function createOperationalInsights({ dataDir, history, incidents, getServers, now = Date.now,
  setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const file = path.join(dataDir, 'operational-reports.json');
  const defaults = () => ({ version: 1, config: { enabled: false, cadence: 'daily', hourUTC: 8 },
    lastSlot: null, reports: [], lastError: null });
  const store = createJsonStore(file, defaults, validReportState);
  let timer, pending = null, stopped = false;
  async function ready() { await mkdir(dataDir, { recursive: true }); }
  async function settings() { await ready(); const state = await store.read(); return {
    ...state.config, timeZone: 'UTC', lastSlot: state.lastSlot, lastError: state.lastError,
    notice: 'Local generation only, while backend is running. Latest missed slot only; interrupted or failed slots are not automatically retried.' };
  }
  async function configure(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some(key => !['enabled', 'cadence', 'hourUTC'].includes(key))) throw bad('Invalid report settings.');
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw bad('enabled must be boolean.');
    if ('cadence' in patch && !['daily', 'weekly'].includes(patch.cadence)) throw bad('cadence must be daily or weekly.');
    if ('hourUTC' in patch && (!Number.isInteger(patch.hourUTC) || patch.hourUTC < 0 || patch.hourUTC > 23)) throw bad('hourUTC must be 0-23.');
    await ready();
    await store.update(state => {
      const config = { ...state.config, ...patch };
      if (JSON.stringify(config) !== JSON.stringify(state.config)) state.lastSlot = dueReportSlot(now(), config);
      state.config = config;
    });
    return settings();
  }
  async function baseline(id, at) {
    at = insightTime(at);
    if (at > now()) throw bad('Baseline cursor must not be in the future.');
    const [past, recent] = await Promise.all([
      history.query(id, { from: Math.max(0, at - 28 * DAY), to: Math.floor(at / HOUR) * HOUR, resolution: 'hour', limit: 1000 }),
      history.query(id, { from: Math.max(0, at - HOUR), to: at + 1, resolution: 'auto', limit: 2000 }),
    ]);
    const current = recent.points.filter(point => (point.lastT ?? point.t) <= at).at(-1);
    return { serverId: id, ...workloadBaseline(past.points, current, at, recent.gapThresholdMs),
      partial: past.partial || recent.partial, recoveryWarnings: [...past.recoveryWarnings || [], ...recent.recoveryWarnings || []] };
  }
  async function timeline(id, { from, to, at = to - 1 }) {
    from = insightTime(from, 'from'); to = insightTime(to, 'to'); at = insightTime(at, 'at');
    if (from >= to || to - from > 7 * DAY || at < from || at >= to || at > now()) throw bad('Timeline requires an increasing window of at most 7 days and a past cursor inside it.');
    const [window, listed, availability] = await Promise.all([
      history.query(id, { from: Math.max(from, at - HOUR), to: at + 1, limit: 2000 }),
      incidents.list(id, { since: new Date(from).toISOString(), until: new Date(at).toISOString(), limit: 100, includeEvidence: true }),
      incidents.status(id),
    ]);
    // Current availability is labelled separately; never imply it was known at the cursor.
    return { serverId: id, ...correlateEvidence({ ...window, from, to }, listed.events, at), truncated: listed.truncated,
      currentCollectionStatus: availability, partial: window.partial };
  }
  async function summarize(id, from, to) {
    const [comparison, evidence, baselines] = await Promise.all([
      history.compare(id, { from, to, baseline: 'previous', limit: 1000 }),
      incidents.list(id, { since: new Date(from).toISOString(), until: new Date(to - 1).toISOString(), limit: 500 }),
      baseline(id, to - 1),
    ]);
    const window = comparison.window;
    if (!window.points.length) return { serverId: id, status: 'unavailable',
      reason: 'No retained samples in this period. Capture may be disabled, stopped, outside retention, or unavailable; workload and incident absence cannot be inferred.' };
    let coveredMs = 0, previous = null;
    for (const point of window.points) {
      const first = point.firstT ?? point.t, last = point.lastT ?? point.t;
      if (!point.gap) coveredMs += Math.max(0, last - first);
      if (previous !== null && first - previous <= (window.gapThresholdMs || 180000)) coveredMs += Math.max(0, first - previous);
      previous = last;
    }
    const counts = {};
    for (const item of evidence) if (TYPES.has(item.type)) counts[item.type] = (counts[item.type] || 0) + 1;
    const comparisonMetrics = {};
    for (const key of [...Object.keys(METRICS), 'intervalMetrics.batchRequestsPerSec']) {
      const source = comparison.metrics[key];
      if (!source) continue;
      comparisonMetrics[key] = Object.fromEntries(['current', 'baseline', 'delta', 'percentChange', 'count', 'baselineCount', 'min', 'max']
        .map(field => [field, finite(source[field]) ? source[field] : null]));
    }
    return { serverId: id, status: 'available',
      coverage: { points: window.points.length, partial: window.partial,
        observedContiguousMs: coveredMs, windowMs: to - from,
        firstAt: window.points[0]?.firstT ?? window.points[0]?.t ?? null,
        lastAt: window.points.at(-1)?.lastT ?? window.points.at(-1)?.t ?? null,
        gaps: window.points.filter(point => point.gap).length, missingIsNotZero: true },
      metrics: comparisonMetrics, baselines: baselines.metrics,
      evidence: { recordedCounts: counts, truncated: evidence.length >= 500,
        notice: 'Recorded evidence only; absent evidence is not proof of zero incidents. Collection may be disabled.' },
      health: 'Static health alerts are unchanged; baseline anomalies below are advisory, not a retrospective health score.' };
  }
  function prune(state) {
    state.reports = state.reports.filter(report => report.createdAt >= now() - 90 * DAY).slice(-30);
    while (Buffer.byteLength(JSON.stringify(state, null, 2)) > 2 * 1024 * 1024 && state.reports.length) state.reports.shift();
    return state;
  }
  async function build(from, to, slot = null) {
    const servers = await getServers();
    if (!Array.isArray(servers) || servers.length > 100) throw bad('Reports support at most 100 registered servers.');
    const report = { id: randomUUID(), createdAt: now(), from, to, slot, timeZone: 'UTC',
      kind: 'Local operational summary', servers: [], sensitivePayloads: false,
      notice: 'Sample-weighted comparisons; numeric history only. Polling gaps and absent evidence are unknown. No email or webhook was sent.' };
    for (const server of servers) {
      try { report.servers.push(await summarize(server.id, from, to)); }
      catch { report.servers.push({ serverId: server.id, status: 'unavailable',
        reason: 'Stored history/evidence could not be read. Check local storage integrity and permissions.' }); }
    }
    const available = report.servers.filter(server => server.status === 'available');
    const evaluated = available.flatMap(server => Object.values(server.baselines)).filter(metric => metric.status === 'ready');
    report.fleet = { registeredServers: servers.length, availableServers: available.length,
      unavailableServers: servers.length - available.length,
      baselineMetricsEvaluatedAtEnd: evaluated.length,
      advisoryAnomaliesAtEnd: evaluated.length ? evaluated.filter(metric => metric.anomaly).length : null,
      recordedEvidenceCounts: available.reduce((totals, server) => {
        for (const [key, value] of Object.entries(server.evidence.recordedCounts)) totals[key] = (totals[key] || 0) + value;
        return totals;
      }, {}) };
    report.status = report.servers.every(server => server.status === 'available') ? 'complete' : 'partial-or-unavailable';
    if (Buffer.byteLength(JSON.stringify(report, null, 2)) > 1900000) throw Object.assign(new Error('Local summary exceeds its storage budget. Reduce the registered fleet size.'), { status: 413 });
    await store.update(state => {
      state.reports.push(report); state.lastError = null; prune(state);
      if (!state.reports.some(item => item.id === report.id)) throw Object.assign(
        new Error('Local summary cannot fit the report storage budget.'), { status: 413 });
      return state;
    });
    return report;
  }
  function run(work) {
    if (pending) throw Object.assign(new Error('A local report is already being generated.'), { status: 409 });
    const job = Promise.resolve().then(work);
    pending = job;
    return job.finally(() => { if (pending === job) pending = null; });
  }
  async function generate({ from, to } = {}) {
    from = insightTime(from, 'from'); to = insightTime(to, 'to');
    if (from >= to || to > now() || to - from > 7 * DAY || from < to - from) {
      throw bad('Report window must be in the recorded past, increasing, at most 7 days, with room for a previous comparison.');
    }
    await ready();
    if (stopped) throw Object.assign(new Error('Local report generation is stopping.'), { status: 503 });
    return run(() => build(from, to));
  }
  async function tick() {
    if (stopped || pending) return;
    await ready();
    const state = await store.read();
    if (state.reports.some(report => report.createdAt < now() - 90 * DAY)) await store.update(prune);
    if (!state.config.enabled || pending || stopped) return;
    const slot = dueReportSlot(now(), state.config);
    if (state.lastSlot !== null && slot <= state.lastSlot) return;
    return run(async () => {
      let claimed = false;
      await store.update(current => {
        if (!current.config.enabled || dueReportSlot(now(), current.config) !== slot ||
          current.lastSlot !== null && current.lastSlot >= slot) return;
        current.lastSlot = slot;
        current.lastError = 'Generation started; if interrupted, this slot is not retried. Generate a manual summary if needed.';
        claimed = true;
      });
      if (!claimed) return;
      try { return await build(slot - (state.config.cadence === 'weekly' ? 7 : 1) * DAY, slot, slot); }
      catch (error) {
        await store.update(current => { current.lastError = 'Local summary failed. Check storage/registered-server limits; this slot will not retry automatically.'; });
        throw error;
      }
    });
  }
  return { settings, configure, baseline, timeline, generate,
    async list() { await ready(); return (await store.update(prune, { skipUnchanged: true })).reports.slice().reverse(); },
    tick,
    start(onError = console.error, onSuccess = () => {}) {
      if (timer) return;
      stopped = false;
      const poll = () => { void tick().then(result => { if (result) onSuccess(result); }).catch(onError); };
      timer = setTimer(poll, 60000); timer.unref?.(); poll();
    },
    async close() { stopped = true; if (timer) clearTimer(timer); timer = null; await pending; },
  };
}
