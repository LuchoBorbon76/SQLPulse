const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const messages = {
  queued: 'Waiting for the connection authentication queue.',
  'checking-account': 'Verifying the configured Entra account and tenant.',
  'sign-in': 'Preparing Microsoft browser sign-in. Waiting for the sign-in link…',
  connecting: 'Connecting to SQL.',
  retrying: 'Temporary Azure SQL connection interruption. Reconnecting once after 5 seconds.',
  testing: 'Testing the SQL connection.',
  probing: 'Detecting the SQL engine.',
  saving: 'Saving the verified connection. Please wait.',
  complete: 'Connection request completed.',
  failed: 'Connection failed. See the request error for details.',
  cancelling: 'Cancelling the connection request and stopping its SQL/CLI processes.',
  cancelled: 'Connection request cancelled.',
  timeout: 'Connection request timed out. Try Test or Load again.',
};
const httpError = (status, message) => Object.assign(new Error(message), { status });

export function connectionAbortError(signal) {
  return Object.assign(new Error(signal?.reason?.message || 'Connection request cancelled.'), {
    name: 'AbortError', code: 'ABORT_ERR', status: signal?.reason?.status || 499,
  });
}
export function throwIfConnectionAborted(signal) {
  if (signal?.aborted) throw connectionAbortError(signal);
}
export function commitConnection(context, operation) {
  throwIfConnectionAborted(context?.signal);
  return context?.commit ? context.commit(operation) : operation();
}

export function connectionSignInOptions(cfg, body, context) {
  if (body.forceLogin !== undefined && typeof body.forceLogin !== 'boolean') {
    throw httpError(400, 'forceLogin must be a boolean');
  }
  if (body.forceLogin && cfg.auth !== 'azuread-interactive') {
    throw httpError(400, 'Sign in again requires Microsoft browser or device-code authentication');
  }
  return { ...context, forceLogin: body.forceLogin === true };
}

export function createConnectionProgress({
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutMs = 330000, deadlineMs = timeoutMs, retentionMs = 300000, maxConcurrent = 10, maxEntries = 20,
} = {}) {
  if (!(deadlineMs > 0 && deadlineMs <= 330000) || !(retentionMs > 0) ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(maxEntries) || maxEntries < maxConcurrent) {
    throw new Error('Invalid connection progress limits');
  }
  const jobs = new Map();
  function validateId(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw httpError(400, 'operationId must be a UUID');
    return id.toLowerCase();
  }
  function sweep() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of jobs) if (terminal.has(job.meta.state) && job.finishedAt <= cutoff) jobs.delete(id);
  }
  function publicMeta(job) { return { ...job.meta }; }
  function update(job, state, phase, message = messages[phase]) {
    Object.assign(job.meta, { state, phase, message, updatedAt: new Date(now()).toISOString() });
    if (phase !== 'sign-in') {
      delete job.meta.deviceCode;
      delete job.meta.verificationUri;
      delete job.meta.signInUrl;
      delete job.meta.entraFlow;
    }
  }
  function abort(job, reason) {
    if (terminal.has(job.meta.state) || job.committing || job.committed) return;
    if (!job.controller.signal.aborted) {
      job.meta.cancellable = false;
      update(job, 'cancelling', 'cancelling');
      job.controller.abort(reason);
    }
  }
  function get(id) {
    sweep();
    const job = jobs.get(validateId(id));
    if (!job) throw httpError(404, 'Connection operation not found');
    return publicMeta(job);
  }
  function cancel(id) {
    sweep();
    const job = jobs.get(validateId(id));
    if (!job) throw httpError(404, 'Connection operation not found');
    abort(job, httpError(499, 'Connection request cancelled.'));
    return publicMeta(job);
  }
  async function run(operationId, req, res, operation) {
    if (operationId === undefined) return operation({});
    sweep();
    const id = validateId(operationId);
    if (jobs.has(id)) throw httpError(409, 'Connection operation already exists; use a new operationId');
    if ([...jobs.values()].filter(job => !terminal.has(job.meta.state)).length >= maxConcurrent) {
      throw httpError(429, 'Too many connection operations. Wait for an existing request to finish.');
    }
    if (jobs.size >= maxEntries) {
      const oldest = [...jobs].find(([, job]) => terminal.has(job.meta.state));
      if (!oldest) throw httpError(429, 'Too many connection operations');
      jobs.delete(oldest[0]);
    }
    const timestamp = new Date(now()).toISOString();
    const job = {
      controller: new AbortController(), committing: false, committed: false,
      meta: { operationId: id, state: 'running', phase: 'queued', message: messages.queued,
        createdAt: timestamp, updatedAt: timestamp, cancellable: true },
    };
    jobs.set(id, job);
    const disconnect = () => {
      if (!res?.writableEnded) abort(job, httpError(499, 'Connection request disconnected.'));
    };
    req?.once?.('aborted', disconnect);
    res?.once?.('close', disconnect);
    if (req?.aborted || res?.destroyed) disconnect();
    const timer = setTimer(() => abort(job, httpError(504, 'Connection request timed out after its overall deadline.')), deadlineMs);
    timer?.unref?.();
    const context = {
      signal: job.controller.signal,
      onProgress(value) {
        if (terminal.has(job.meta.state) || job.controller.signal.aborted || job.committed || !Object.hasOwn(messages, value?.phase)) return;
        update(job, 'running', value.phase);
        if (value.phase === 'sign-in') {
          delete job.meta.deviceCode;
          delete job.meta.verificationUri;
          delete job.meta.signInUrl;
          job.meta.entraFlow = value.entraFlow === 'device-code' ? 'device-code' : 'browser';
          if (job.meta.entraFlow === 'device-code') {
            job.meta.message = 'Preparing Microsoft device sign-in. Waiting for the code…';
          }
          const signInUrl = normalizeMicrosoftBrowserUrl(value.signInUrl);
          if (job.meta.entraFlow === 'browser' && signInUrl) {
            job.meta.signInUrl = signInUrl;
            job.meta.message = 'Continue Microsoft sign-in in your browser.';
          }
        }
        if (value.phase === 'sign-in' && /^(?:[A-Z0-9]{8,16}|[A-Z0-9]{4}-[A-Z0-9]{4})$/i.test(value.deviceCode || '') &&
            normalizeMicrosoftDeviceUri(value.verificationUri)) {
          delete job.meta.signInUrl;
          job.meta.entraFlow = 'device-code';
          job.meta.deviceCode = value.deviceCode;
          job.meta.verificationUri = normalizeMicrosoftDeviceUri(value.verificationUri);
          job.meta.message = 'Enter the Microsoft sign-in code';
        }
      },
      async commit(callback) {
        if (terminal.has(job.meta.state)) throw httpError(409, 'Connection operation already finished');
        throwIfConnectionAborted(job.controller.signal);
        job.committing = true;
        job.meta.cancellable = false;
        update(job, 'running', 'saving');
        try {
          const value = await callback();
          job.committed = true;
          return value;
        } finally { job.committing = false; }
      },
    };
    try {
      const result = await operation(context);
      if (!job.committed) throwIfConnectionAborted(context.signal);
      if ((res?.statusCode || res?.status || 200) >= 400) update(job, 'failed', 'failed');
      else update(job, 'completed', 'complete', job.committed ? 'Connection verified and saved.' : messages.complete);
      return result;
    } catch (error) {
      const timedOut = context.signal.aborted && context.signal.reason?.status === 504;
      const cancelled = context.signal.aborted && !timedOut && error.code !== 'PROCESS_CLEANUP_FAILED';
      update(job, cancelled ? 'cancelled' : 'failed', timedOut ? 'timeout' : cancelled ? 'cancelled' : 'failed');
      throw error;
    } finally {
      clearTimer(timer);
      req?.removeListener?.('aborted', disconnect);
      res?.removeListener?.('close', disconnect);
      job.meta.cancellable = false;
      job.finishedAt = now();
      // Retain only public progress after completion, not abort/commit closures.
      delete job.controller;
    }
  }
  return { run, get, cancel };
}
import { normalizeMicrosoftBrowserUrl, normalizeMicrosoftDeviceUri } from './microsoft-device-signin.js';
