import { createHash } from 'node:crypto';
import { classifySqlEndpoint } from './sql-endpoint.js';

export function isRegisteredAzure(server) {
  return classifySqlEndpoint(server.server, server.connectionType || 'auto', server.engineEdition).isAzure;
}

export function azureReadinessFailure(error) {
  const message = String(error?.message || '');
  if (error?.code === 'AZ_IDENTITY' || /account does not match|different (?:default )?tenant|different tenant/i.test(message)) {
    return { failure: 'account-mismatch', guidance: 'The active Azure CLI account or tenant does not match this saved connection. Open Edit, select Sign in again, and Test & Update with the intended account.' };
  }
  if (error?.category === 'authentication' || /AZ_SESSION|AADSTS|sign in|sign-in|az login|token.*expired|interaction_required/i.test(message)) {
    return { failure: 'sign-in-required', guidance: 'Microsoft sign-in needs attention. Open Edit and use Sign in again, then Test & Update. Automatic checks never open a sign-in browser.' };
  }
  if (error?.category === 'authorization-or-configuration' || /login failed|permission.*denied|not authorized|certificate|x509/i.test(message)) {
    return { failure: 'sql-access', guidance: 'The saved connection could not authenticate to SQL or validate its configuration. Review SQL permissions, database and certificate settings using Test & Update.' };
  }
  if (error?.name === 'AbortError' || error?.category === 'timeout' || /timed out|timeout/i.test(message)) {
    return { failure: 'timeout', guidance: 'The connection check timed out. Review the saved endpoint and client network route, then test the existing connection.' };
  }
  return { failure: 'connectivity', guidance: 'The saved connection check failed. Review network access, authorization and SQL access using the existing connection. This does not prove an Azure service outage.' };
}

// Evidence is bound to credentials as well as the endpoint, but never exposed.
function fingerprint(server) {
  return createHash('sha256').update(JSON.stringify([
    server.id, server.server, server.database, server.connectionType, server.engineEdition,
    server.auth, server.user, server.tenant, server.entraFlow, server.passwordEnc,
    server.encrypt, server.trustCert,
  ])).digest('hex');
}

export function createAzurePrerequisite({
  getServers, probe, now = Date.now, intervalMs = 60000, freshnessMs = 120000,
  timeoutMs = 55000, maxConcurrent = 2, setTimer = setTimeout, clearTimer = clearTimeout,
  onChange = () => {},
  onError = message => console.error(message),
} = {}) {
  const evidence = new Map(), pending = new Map();
  let registered = [], timer, stopped = true, ticking, eligible = false, generation = 0;
  function status() {
    const reachable = registered.filter(server => {
      const item = evidence.get(server.id);
      return item?.identity === fingerprint(server) && item.ok &&
        now() - item.checkedAt >= 0 && now() - item.checkedAt < freshnessMs;
    });
    const enabled = reachable.length > 0;
    if (enabled !== eligible) {
      eligible = enabled;
      generation++;
      Promise.resolve().then(() => onChange(enabled)).catch(() => onError('Azure prerequisite monitoring configuration could not be applied. Review local monitoring settings.'));
    }
    const reason = enabled ? 'ready' : !registered.length ? 'registration-required'
      : registered.some(server => !evidence.has(server.id)) ? 'checking' : 'connectivity-required';
    return { eligible: enabled, generation, reason, registeredCount: registered.length,
      reachableCount: reachable.length, freshnessMs, intervalMs,
      servers: registered.map(server => {
        const item = evidence.get(server.id);
        const fresh = item && now() - item.checkedAt >= 0 && now() - item.checkedAt < freshnessMs;
        return { id: server.id, state: !item ? 'checking' : !fresh ? 'stale' : item.ok ? 'reachable' : 'unreachable',
          checkedAt: item ? new Date(item.checkedAt).toISOString() : null,
          ...(!item?.ok && item?.failure ? { failure: item.failure, guidance: item.guidance } : {}),
          checking: pending.has(server.id) };
      }) };
  }
  function reconcile(list) {
    registered = list.filter(isRegisteredAzure).map(server => ({ ...server }));
    const identities = new Map(registered.map(server => [server.id, fingerprint(server)]));
    for (const [id, item] of evidence) if (identities.get(id) !== item.identity) evidence.delete(id);
    for (const [id, job] of pending) if (identities.get(id) !== job.identity) job.controller.abort();
    return status();
  }
  async function check(server) {
    const identity = fingerprint(server), controller = new AbortController();
    const job = { identity, controller };
    pending.set(server.id, job);
    const timeout = setTimer(() => controller.abort(), timeoutMs);
    timeout?.unref?.();
    job.promise = (async () => {
      let ok = false, failure = azureReadinessFailure();
      try { ok = await probe({ ...server }, { signal: controller.signal }) === true; }
      catch (error) { failure = azureReadinessFailure(error); }
      finally { clearTimer(timeout); }
      const checkedAt = now();
      if (stopped) return;
      reconcile(await getServers());
      if (stopped) return;
      const current = registered.find(item => item.id === server.id);
      if (current && fingerprint(current) === identity && !controller.signal.aborted) {
        evidence.set(server.id, { identity, checkedAt, ok, ...(!ok ? failure : {}) });
      } else if (current && fingerprint(current) === identity) {
        evidence.set(server.id, { identity, checkedAt, ok: false, ...azureReadinessFailure({ name: 'AbortError' }) });
      }
      status();
    })().catch(() => {
      // Fail closed on an unreadable registry; never retain unverified evidence.
      evidence.clear();
      status();
    }).finally(() => { if (pending.get(server.id) === job) pending.delete(server.id); });
  }
  async function tick() {
    if (stopped || ticking) return ticking;
    ticking = (async () => {
      try {
        reconcile(await getServers());
        if (stopped) return;
        for (const server of registered) {
          if (pending.size >= maxConcurrent) break;
          const item = evidence.get(server.id);
          if (!pending.has(server.id) && (!item || now() - item.checkedAt >= intervalMs)) {
            await check(server);
          }
        }
      } catch {
        registered = []; evidence.clear(); status();
        onError('Azure prerequisite could not read the saved connection registry. Live monitoring remains locked.');
      }
    })().finally(() => { ticking = undefined; });
    return ticking;
  }
  function arm() {
    if (stopped) return;
    timer = setTimer(async () => {
      await tick();
      arm();
    }, 5000);
    timer?.unref?.();
  }
  function start() { if (!stopped) return; stopped = false; void tick(); arm(); }
  function stop() {
    stopped = true;
    clearTimer(timer);
    for (const job of pending.values()) job.controller.abort();
    evidence.clear();
    status();
  }
  async function idle() {
    await ticking;
    await Promise.allSettled([...pending.values()].map(job => job.promise));
  }
  return { status, reconcile, tick, start, stop, idle };
}
