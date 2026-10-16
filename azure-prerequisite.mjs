import { classifySqlEndpoint } from './sql-endpoint.js';

export function isRegisteredAzure(server) {
  return classifySqlEndpoint(server.server, server.connectionType || 'auto', server.engineEdition).isAzure;
}

export function createAzurePrerequisite({
  getServers, intervalMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout,
  onChange = () => {},
  onError = message => console.error(message),
} = {}) {
  if (typeof getServers !== 'function') throw new TypeError('getServers must be a function');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive');
  const jobs = new Set();
  let registered = [], available = false, eligible = false, generation = 0;
  let timer, stopped = true, closed = false, ticking, epoch = 0, revision = 0;
  function reportError(message) {
    try { onError(message); } catch { console.error(message); }
  }
  function status() {
    return { eligible, generation,
      reason: !available ? 'registration-unavailable' : eligible ? 'ready' : 'registration-required',
      registeredCount: available ? registered.length : null,
      servers: registered.map(server => ({ id: server.id, state: 'registered' })) };
  }
  function track(job) {
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return job;
  }
  function apply(list, readable = true) {
    registered = list;
    available = readable;
    const enabled = readable && registered.length > 0;
    if (enabled !== eligible) {
      eligible = enabled;
      const changedGeneration = ++generation, changedEpoch = epoch;
      track(Promise.resolve().then(() => {
        if (epoch === changedEpoch && generation === changedGeneration) return onChange(enabled);
      }).catch(() => reportError('Azure prerequisite monitoring configuration could not be applied. Review local monitoring settings.')));
    }
    return status();
  }
  function reconcile(list) {
    if (closed) return status();
    if (!Array.isArray(list) || list.some(server => !server || typeof server !== 'object')) {
      apply([], false);
      throw new TypeError('Invalid saved connection registry');
    }
    revision++;
    return apply(list.filter(isRegisteredAzure).map(server => ({ id: server.id })));
  }
  function tick() {
    if (stopped) return Promise.resolve();
    if (ticking) return ticking;
    const readEpoch = epoch, readRevision = revision;
    const job = (async () => {
      try {
        const list = await getServers();
        if (!stopped && epoch === readEpoch && revision === readRevision) reconcile(list);
      } catch {
        if (stopped || epoch !== readEpoch || revision !== readRevision) return;
        apply([], false);
        reportError('Azure prerequisite could not read the saved connection registry. Registration status is unavailable; live monitoring remains locked.');
      }
    })().finally(() => { if (ticking === job) ticking = undefined; });
    ticking = track(job);
    return ticking;
  }
  function arm() {
    if (stopped) return;
    const timerEpoch = epoch;
    timer = setTimer(async () => {
      if (stopped || epoch !== timerEpoch) return;
      await tick();
      if (!stopped && epoch === timerEpoch) arm();
    }, intervalMs);
    timer?.unref?.();
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    closed = false;
    void tick();
    arm();
  }
  function stop() {
    stopped = true;
    closed = true;
    epoch++;
    revision++;
    clearTimer(timer);
    ticking = undefined;
    registered = [];
    available = false;
    if (eligible) generation++;
    eligible = false;
  }
  async function idle() {
    while (jobs.size) await Promise.allSettled([...jobs]);
  }
  return { status, reconcile, tick, start, stop, idle };
}
