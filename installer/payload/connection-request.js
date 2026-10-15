export function createConnectionRequest({
  fetchImpl = globalThis.fetch.bind(globalThis),
  onProgress = () => {},
  createId = () => globalThis.crypto.randomUUID(),
  now = Date.now, pollMs = 750, timeoutMs = 360000, requestTimeoutMs = 10000,
} = {}) {
  let current = null;
  let reconciliationRequired = false;

  async function readJson(response) {
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The dashboard returned an invalid connection response.'); }
    if (!response.ok) throw Object.assign(new Error(data.error || `Connection request failed (HTTP ${response.status}).`), { status: response.status });
    return data;
  }

  async function controlRequest(url, body) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => readJson(await fetchImpl(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })))(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Could not contact the dashboard to read or cancel connection progress.'));
            controller.abort();
          }, requestTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function emit(operation, data) {
    if (current !== operation) return;
    operation.progress = data;
    onProgress({ ...data, elapsedSeconds: Math.floor((now() - operation.startedAt) / 1000) });
  }

  function schedulePoll(operation) {
    clearTimeout(operation.pollTimer);
    if (current !== operation || operation.finished) return;
    operation.pollTimer = setTimeout(async () => {
      try {
        const data = await controlRequest(`/api/connection-progress?operationId=${encodeURIComponent(operation.id)}`);
        if (current !== operation || operation.finished) return;
        emit(operation, data);
        if (!['completed', 'failed', 'cancelled'].includes(data.state)) schedulePoll(operation);
      } catch (error) {
        if (current !== operation || operation.finished) return;
        if (error.status === 404 && now() - operation.startedAt < 3000) schedulePoll(operation);
        else {
          emit(operation, {
            state: 'running', phase: 'progress-unavailable',
            message: `${error.message} The connection request is still pending; use Cancel to stop it.`,
          });
          schedulePoll(operation);
        }
      }
    }, pollMs);
  }

  async function cancel() {
    const operation = current;
    if (!operation || operation.finished) return null;
    if (operation.cancelPromise) return operation.cancelPromise;
    if (operation.progress?.cancellable === false) {
      emit(operation, { ...operation.progress, message: 'Connection settings are already being saved. Waiting for the save result.' });
      return operation.progress;
    }
    operation.cancelPromise = (async () => {
      emit(operation, { state: 'cancelling', phase: 'cancelling', message: 'Stopping the connection test and sign-in process…' });
      let data;
      for (let attempt = 0; ; attempt++) {
        try {
          data = await controlRequest('/api/connection-cancel', { operationId: operation.id });
          break;
        } catch (error) {
          if (error.status !== 404 || attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      emit(operation, data);
      if (data.state === 'cancelled' && !operation.timingOut) operation.controller.abort();
      else if (!['completed', 'failed'].includes(data.state)) schedulePoll(operation);
      return data;
    })();
    try { return await operation.cancelPromise; }
    catch (error) {
      emit(operation, { state: 'running', phase: 'cancel-failed', message: `Cancellation was not confirmed: ${error.message}` });
      throw error;
    } finally { operation.cancelPromise = null; }
  }

  async function request(url, { method = 'POST', body } = {}) {
    if (reconciliationRequired) throw new Error('The previous save result is uncertain. Refresh the dashboard and check the server list before retrying.');
    if (current) throw new Error('A connection test is already running. Cancel it or wait for completion.');
    const operation = {
      id: createId(), startedAt: now(), controller: new AbortController(),
      finished: false, pollTimer: null, timeoutTimer: null, cancelPromise: null,
    };
    current = operation;
    emit(operation, { state: 'running', phase: 'starting', message: 'Starting connection test…' });
    schedulePoll(operation);
    let timedOut = false;
    try {
      return await Promise.race([
        (async () => readJson(await fetchImpl(url, {
          method, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, operationId: operation.id }),
          credentials: 'same-origin', signal: operation.controller.signal,
        })))(),
        new Promise((_, reject) => {
          operation.timeoutTimer = setTimeout(async () => {
            timedOut = true;
            operation.timingOut = true;
            try {
              const result = await cancel();
              if (result?.state === 'completed' || (result?.cancellable === false && result?.phase === 'saving')) {
                reconciliationRequired = true;
                reject(new Error('The connection response timed out during saving; the connection may already be saved. Refresh the dashboard and check the server list before retrying.'));
              } else reject(new Error('The connection test timed out. Cancellation was requested; check the dashboard before retrying.'));
            } catch (error) {
              reconciliationRequired = true;
              reject(new Error(`The connection test timed out and cancellation could not be confirmed: ${error.message}`));
            } finally { operation.controller.abort(); }
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut && error.name === 'AbortError') {
        throw new Error('The connection test timed out. Refresh the dashboard and check the server list before retrying.');
      }
      if (!timedOut && error.name === 'AbortError' && operation.progress?.state === 'cancelled') {
        throw new Error('Connection test cancelled.');
      }
      throw error;
    } finally {
      operation.finished = true;
      clearTimeout(operation.pollTimer);
      clearTimeout(operation.timeoutTimer);
      if (current === operation) current = null;
    }
  }

  return { request, cancel, get isRunning() { return Boolean(current); }, get reconciliationRequired() { return reconciliationRequired; } };
}
export { normalizeMicrosoftDeviceUri, normalizeMicrosoftBrowserUrl } from './microsoft-device-signin.js';
