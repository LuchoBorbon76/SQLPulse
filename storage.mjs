import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const queues = new Map();

function serialize(file, operation) {
  const previous = queues.get(file) || Promise.resolve();
  const pending = previous.then(operation);
  const settled = pending.catch(() => {});
  queues.set(file, settled);
  settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file);
  });
  return pending;
}

export async function atomicWriteFile(file, content, options = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', options.mode ?? 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Windows sync/antivirus readers can briefly deny atomic replacement.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } catch (error) {
    const failures = [error];
    if (handle) {
      try { await handle.close(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    try { await unlink(temporary); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') failures.push(cleanupError);
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Atomic save and cleanup failed');
    throw error;
  }
}

export function createJsonStore(file, defaultFactory, validate) {
  file = path.resolve(file);
  function checked(value) {
    if (validate(value) === false) throw new Error('Invalid JSON store value');
    return value;
  }
  async function readCurrent() {
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return checked(defaultFactory());
    }
    return checked(JSON.parse(raw));
  }
  async function save(value) {
    checked(value);
    await atomicWriteFile(file, JSON.stringify(value, null, 2));
    return value;
  }
  return {
    async read() {
      await (queues.get(file) || Promise.resolve());
      return readCurrent();
    },
    update(mutator, { skipUnchanged = false } = {}) {
      return serialize(file, async () => {
        const current = await readCurrent();
        const before = skipUnchanged ? JSON.stringify(current) : null;
        const result = await mutator(current);
        const next = result === undefined ? current : result;
        if (skipUnchanged && JSON.stringify(next) === before) return checked(next);
        return save(next);
      });
    },
    write(value) {
      return serialize(file, () => save(value));
    },
  };
}

export function validateServerRegistry(list) {
  if (!Array.isArray(list)) throw new Error('Server registry must be an array');
  const ids = new Set();
  const auths = new Set(['windows', 'sqlauth', 'azuread-integrated', 'azuread-password', 'azuread-interactive']);
  for (const server of list) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('Invalid server registry entry');
    if (typeof server.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.id) || ids.has(server.id)) {
      throw new Error('Server registry IDs must be unique and contain only letters, numbers, underscores or hyphens');
    }
    ids.add(server.id);
    for (const field of ['name', 'server', 'auth']) {
      if (typeof server[field] !== 'string' || !server[field].trim()) throw new Error(`Invalid server ${field}`);
    }
    if (!auths.has(server.auth)) throw new Error('Invalid server authentication method');
    for (const field of ['user', 'database', 'password', 'passwordEnc', 'addedAt']) {
      if (server[field] != null && typeof server[field] !== 'string') throw new Error(`Invalid server ${field}`);
    }
    if (server.passwordEnc && !/^enc:v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/.test(server.passwordEnc)) {
      throw new Error('Invalid encrypted server password');
    }
    if (server.group != null && typeof server.group !== 'string') throw new Error('Invalid server group');
    for (const field of ['encrypt', 'trustCert', 'monitoringPaused']) {
      if (server[field] != null && typeof server[field] !== 'boolean') throw new Error(`Invalid server ${field}`);
    }
    if (server.engineEdition != null && !Number.isInteger(server.engineEdition)) throw new Error('Invalid engine edition');
    if (server.customCounters != null) {
      if (!Array.isArray(server.customCounters)) throw new Error('Invalid custom counters');
      const counterIds = new Set();
      for (const counter of server.customCounters) {
        if (!counter || typeof counter !== 'object' || Array.isArray(counter) ||
            typeof counter.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(counter.id) || counterIds.has(counter.id) ||
            typeof counter.name !== 'string' || typeof counter.sql !== 'string') throw new Error('Invalid custom counter');
        counterIds.add(counter.id);
        for (const field of ['unit', 'description']) {
          if (counter[field] != null && typeof counter[field] !== 'string') throw new Error(`Invalid counter ${field}`);
        }
        for (const field of ['warnGt', 'critGt', 'warnLt', 'critLt']) {
          if (counter[field] != null && (typeof counter[field] !== 'number' || !Number.isFinite(counter[field]))) {
            throw new Error(`Invalid counter ${field}`);
          }
        }
      }
    }
  }
  return true;
}
