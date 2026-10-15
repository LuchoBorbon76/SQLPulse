import { createHash } from 'node:crypto';

// Hash credentials rather than retaining them in map keys.
export function configIdentity(config) {
  const { password, engineEdition, monitoringPaused, ...stored } = config;
  stored.entraFlow ??= 'browser';
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(stored))).digest('hex');
}

export function connectionIdentity(config) {
  return configIdentity(Object.fromEntries(
    ['server', 'auth', 'user', 'passwordEnc', 'database', 'encrypt', 'trustCert', 'connectionType', 'tenant', 'entraFlow']
      .map(key => [key, key === 'entraFlow' ? config[key] ?? 'browser' : config[key]])
  ));
}

export function createAsyncLimiter(maxConcurrent = 2) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid concurrency limit');
  const queue = [];
  let active = 0;
  function drain() {
    while (active < maxConcurrent && queue.length) {
      const { operation, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  const limited = operation => new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject });
    drain();
  });
  limited.stats = () => ({ active, queued: queue.length, maxConcurrent });
  limited.configure = value => {
    if (!Number.isInteger(value) || value < 1 || value > 2) throw new Error('Concurrency budget must be 1 or 2');
    maxConcurrent = value;
    drain();
  };
  return limited;
}

export function createSectionCache({ now = Date.now } = {}) {
  const entries = new Map(), pending = new Map(), generations = new Map();
  function invalidate(id) {
    generations.set(id, (generations.get(id) || 0) + 1);
    for (const [key, entry] of entries) if (entry.id === id) entries.delete(key);
  }
  function get(config, section, intervalMs, collect) {
    const identity = `${connectionIdentity(config)}:${config.engineEdition || ''}`;
    const key = JSON.stringify([config.id, section, identity]);
    const generation = generations.get(config.id) || 0;
    const cached = entries.get(key);
    if (cached && now() - cached.attemptedAt < intervalMs) return Promise.resolve(cached);
    const requestKey = `${key}:${generation}`;
    if (pending.has(requestKey)) return pending.get(requestKey);
    const request = Promise.resolve().then(() => collect(cached?.data)).then(data => ({
      id: config.id, data, sampledAt: now(), attemptedAt: now(), error: null,
    }), error => ({
      id: config.id, data: cached?.data, sampledAt: cached?.sampledAt,
      attemptedAt: now(), error,
    })).then(entry => {
      if ((generations.get(config.id) || 0) === generation) entries.set(key, entry);
      return entry;
    }).finally(() => pending.delete(requestKey));
    pending.set(requestKey, request);
    return request;
  }
  return { get, invalidate };
}

export function createCollectorCache(collect, {
  now = Date.now, defaultMaxAgeMs = 30000, minimumMaxAgeMs = 15000, maxConcurrent = 2,
} = {}) {
  const entries = new Map();
  const failures = new Map();
  const inFlight = new Map();
  const latestRequests = new Map();
  const generations = new Map();
  const tails = new Map();
  const snapshots = new Map();
  const limited = createAsyncLimiter(maxConcurrent);
  function invalidate(id) {
    generations.set(id, (generations.get(id) || 0) + 1);
    entries.delete(id);
    failures.delete(id);
    latestRequests.delete(id);
    snapshots.delete(id);
  }
  function peek(config) {
    const cached = entries.get(config.id);
    return cached?.identity === configIdentity(config) ? { ...cached } : null;
  }
  function snapshot(config, sampledAt) {
    const identity = configIdentity(config);
    const recent = (snapshots.get(config.id) || []).filter(entry =>
      entry.identity === identity && now() - entry.at < 120000);
    snapshots.set(config.id, recent);
    return (sampledAt ? recent.find(entry => entry.data.generated_at === sampledAt)?.data : null)
      || peek(config)?.data || null;
  }
  function get(config, maxAgeMs = defaultMaxAgeMs) {
    const id = config.id;
    const identity = configIdentity(config);
    const generation = generations.get(id) || 0;
    const cached = entries.get(id);
    const failure = failures.get(id);
    if (failure?.identity === identity && now() - failure.at < minimumMaxAgeMs) return Promise.reject(failure.error);
    if (failure?.identity !== identity && cached?.identity === identity && now() - cached.at < Math.max(minimumMaxAgeMs, maxAgeMs)) return Promise.resolve(cached.data);
    const bucket = inFlight.get(id) || new Map();
    const requestKey = `${identity}:${generation}`;
    const pending = bucket.get(requestKey);
    if (pending) return pending.promise;
    const request = { identity, generation };
    const previous = tails.get(id) || Promise.resolve();
    request.promise = previous.catch(() => {}).then(() => limited(() => {
      if ((generations.get(id) || 0) !== generation) {
        throw Object.assign(new Error('Server configuration changed before collection'), { status: 409 });
      }
      return collect(config);
    })).then(data => {
      if ((generations.get(id) || 0) === generation && latestRequests.get(id) === request) {
        entries.set(id, { identity, at: now(), data });
        const recent = (snapshots.get(id) || []).filter(entry =>
          entry.identity === identity && now() - entry.at < 120000 && entry.data !== data);
        snapshots.set(id, [...recent, { identity, at: now(), data }].slice(-4));
        failures.delete(id);
      }
      return data;
    }, error => {
      if ((generations.get(id) || 0) === generation && latestRequests.get(id) === request && !error?.monitoringPaused) {
        failures.set(id, { identity, at: now(), error });
      }
      throw error;
    }).finally(() => {
      if (bucket.get(requestKey) === request) bucket.delete(requestKey);
      if (bucket.size === 0 && inFlight.get(id) === bucket) inFlight.delete(id);
      if (latestRequests.get(id) === request) latestRequests.delete(id);
      if (tails.get(id) === request.promise) tails.delete(id);
    });
    bucket.set(requestKey, request);
    tails.set(id, request.promise);
    inFlight.set(id, bucket);
    latestRequests.set(id, request);
    return request.promise;
  }
  return {
    get, peek, snapshot, invalidate,
    idle: () => Promise.allSettled([...tails.values()]),
    stats: () => ({ ...limited.stats(), cached: entries.size, failed: failures.size, pending: latestRequests.size }),
  };
}
