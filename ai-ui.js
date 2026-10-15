import { copySignInCode } from './copy-signin-code.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ICONS = { github: '◉', openrouter: '⇄', 'azure-openai': '☁', openai: '◎', anthropic: '✳', local: '▣', ollama: '◌' };
const VISUAL_TITLES = {
  instance: 'Instance metrics', timeline: 'Performance timeline', blocking: 'Blocking sessions', active: 'Active requests',
  waiters: 'Waiting tasks', waits: 'Wait statistics', latches: 'Latch statistics', buffer_pool: 'Buffer pool',
  file_io: 'File I/O', databases: 'Databases', top_queries: 'Top queries', missing_indexes: 'Missing indexes',
  tempdb: 'TempDB', custom_counters: 'Custom counter', all: 'Server overview', history: 'Historical investigation',
};
const openAiReasoningModel = model => /^(?:o1(?:-\d{4}-\d{2}-\d{2})?|o3(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?|o4-mini(?:-\d{4}-\d{2}-\d{2})?|gpt-5(?:[.-]\d+)?(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?)$/.test(model);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function recommendedVisualPrompts({ scope = 'instance', metricId, title } = {}) {
  const topics = {
    instance: [
      ['Resource pressure', 'Which captured instance metrics suggest CPU or memory pressure, and which are missing?'],
      ['Session activity', 'Compare user sessions, active requests and blocked requests. What needs attention in this snapshot?'],
      ['First checks', 'Prioritize three read-only checks using the instance metrics, without assuming unavailable measurements.'],
    ],
    timeline: [
      ['Spot changes', 'Identify spikes, sustained changes and gaps in the recorded timeline. Cite the sample times and avoid treating gaps as zero.'],
      ['Compare series', 'Which recorded timeline series change together, and what can or cannot be inferred from that correlation?'],
      ['Next sample', 'What should I compare in the next timeline samples to confirm whether the observed change persists?'],
    ],
    history: [
      ['Compare periods', 'Compare the selected historical window with its baseline. Cite sample coverage and do not infer missing measurements.'],
      ['Explain changes', 'Identify sustained changes, spikes, collection gaps and counter resets in this historical window. Distinguish correlation from cause.'],
      ['Next checks', 'Prioritize read-only checks for the observed historical changes. Do not present old measurements as current conditions.'],
    ],
    blocking: [
      ['Head blocker', 'Identify the head blocker and downstream blocked sessions in the captured chain. Explain the waits and available query text.'],
      ['Impact', 'Which blocked requests have the longest recorded waits, and what is their likely impact?'],
      ['Safe checks', 'Suggest read-only checks for locks and open transactions before considering any session termination. Do not execute anything.'],
    ],
    active: [
      ['Busy requests', 'Which captured active requests deserve attention based on their status, command, waits and available query text?'],
      ['Suspended or blocked?', 'Distinguish suspended requests from requests blocked by another session using the captured wait type and blocker fields.'],
      ['Monitoring activity', 'Does the program name or query text suggest monitoring or background activity rather than a user-query bottleneck?'],
    ],
    waiters: [
      ['Longest waits', 'Rank the captured waiting tasks by wait duration and identify any known blocking session.'],
      ['Wait meaning', 'Explain the observed wait types and resources. Which read-only evidence would distinguish locking, I/O and normal background waits?'],
      ['User impact', 'Which captured waiting tasks appear to affect user requests, and which may be monitoring activity? State uncertainty.'],
    ],
    waits: [
      ['Dominant waits', 'Explain the dominant captured wait types and task counts. Treat cumulative totals as historical, not proof of a current bottleneck.'],
      ['Signal vs resource', 'Compare recorded signal wait time with total wait time. What evidence is missing to assess CPU scheduling pressure?'],
      ['Measure deltas', 'Suggest read-only interval-delta measurements to check whether the observed cumulative waits are increasing now.'],
    ],
    latches: [
      ['Latch hotspots', 'Which latch classes dominate the captured cumulative wait time and task counts? Explain their typical meaning.'],
      ['Latch or lock?', 'Explain how the observed latch waits differ from transaction lock blocking, without conflating them.'],
      ['Confirm contention', 'What read-only interval-delta checks would confirm current latch contention rather than historical totals?'],
    ],
    buffer_pool: [
      ['Memory distribution', 'Compare the captured buffer-pool memory by database. Which databases occupy the largest share?'],
      ['Cache vs pressure', 'Can this buffer-pool distribution establish memory pressure? Explain what additional evidence would be needed.'],
      ['Investigate usage', 'Suggest read-only checks for the databases with the largest cached footprint; do not recommend cache clearing.'],
    ],
    file_io: [
      ['Slowest files', 'Rank the captured files by average read and write latency, considering their I/O counts.'],
      ['Reads vs writes', 'Which captured data or log files show read-heavy or write-heavy I/O? Distinguish lifetime averages from current rates.'],
      ['Verify storage', 'Recommend read-only interval-delta checks to confirm whether the observed file latency is currently worsening.'],
    ],
    databases: [
      ['Database health', 'Review the captured database states, recovery models, compatibility levels and Query Store settings.'],
      ['Backup evidence', 'Interpret the captured backup dates using the SQL service type. Distinguish platform-managed backups from missing local backup history.'],
      ['Capacity checks', 'Compare data and log sizes and suggest read-only capacity checks. Do not infer free space from file size alone.'],
    ],
    top_queries: [
      ['CPU consumers', 'Which captured queries contribute the most total CPU in the stated Query Store lookback? Compare execution counts and average CPU.'],
      ['Slow or frequent?', 'Distinguish slow individual executions from frequently executed queries using captured duration, reads and execution counts.'],
      ['Plan investigation', 'For the highest-impact captured query, suggest read-only plan and statistics checks without inventing its execution plan.'],
    ],
    missing_indexes: [
      ['Prioritize candidates', 'Rank the captured missing-index candidates by estimated improvement and observed seeks/scans; estimates are not guaranteed gains.'],
      ['Existing-index review', 'Which candidate key and included columns should be checked for overlap with existing indexes before any change?'],
      ['Trade-offs', 'Explain the write, storage and maintenance costs to evaluate before testing the captured index suggestions. Do not execute DDL.'],
    ],
    tempdb: [
      ['Space consumers', 'Compare captured TempDB user objects, internal objects, version store and free space. What is consuming the most space?'],
      ['Version store', 'What can the captured version-store size indicate, and which read-only checks would identify long-running snapshot transactions?'],
      ['Next checks', 'Suggest read-only checks for TempDB allocations and spills; do not infer contention from space usage alone.'],
    ],
    custom_counters: [
      ['Threshold meaning', 'Interpret this selected custom counter value, units, warning/critical thresholds and comparison direction.'],
      ['Sample freshness', 'Check this counter sampling interval, last successful sample and cached/stale/error state before drawing conclusions.'],
      ['Counter trend', 'Explain changes in this counter recorded history and suggest the next read-only check. Do not invent the counter SQL.'],
    ],
  };
  let prompts = topics[scope] || topics.instance;
  if (scope === 'instance' && metricId) {
    const id = String(metricId).toLowerCase();
    const subject = /cpu|cores/.test(id) ? 'CPU usage or core count'
      : /ple|page.*life/.test(id) ? 'page life expectancy'
        : /bhr|buffer.*cache/.test(id) ? 'buffer cache hit ratio'
          : /mem/.test(id) ? 'SQL memory usage'
            : /session|connection/.test(id) ? 'session and connection counts'
              : /active|blocked/.test(id) ? 'active and blocked request counts'
                : /io|log.*write/.test(id) ? 'data I/O or log-write utilization'
                  : /batch|compilation/.test(id) ? 'cumulative batch and compilation counters'
                    : /uptime/.test(id) ? 'instance uptime'
                      : /version|engine|edition/.test(id) ? 'SQL version and engine edition'
                        : String(title || metricId).slice(0, 160);
    prompts = [
      ['Interpret metric', `Explain the captured ${subject} measurement, its units and the SQL service-specific denominator if relevant. Note missing data.`],
      ['Assess significance', `Can this selected ${subject} sample establish a performance issue? Distinguish cumulative values, limits and point-in-time observations.`],
      ['Next checks', `Recommend focused read-only checks to investigate ${subject}. Do not assume metrics outside this selected visual were supplied.`],
    ];
  } else if (scope === 'timeline' && metricId) {
    const series = String(title || metricId).slice(0, 160);
    prompts = prompts.map(([label, question]) => [label, `For the selected timeline series "${series}": ${question}`]);
  }
  return prompts.map(([label, question]) => ({ label, question }));
}

export async function aiUiRequest(fetchImpl, path, body, { signal, timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(`/api/ai/${path}`, {
          ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        let data;
        try { data = await response.json(); } catch { throw new Error('The dashboard returned an invalid AI response.'); }
        if (!response.ok) throw new Error(data.error || `AI request failed (HTTP ${response.status}).`);
        return data;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('The dashboard request timed out. Retry the action or check the server connection.'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function initAiUi({
  el = id => document.getElementById(id), esc = escapeHtml,
  getActiveServerId = () => null, getServerName = id => id, getServerData = () => null, renderSimpleMd,
  confirmDialog = async (title, message, label, options = {}) => window.confirm(`${title}\n\n${message}${options.payload ? `\n\nExact payload:\n${options.payload}` : ''}`),
  fmtInt = value => Number(value).toLocaleString(), fetchImpl = window.fetch.bind(window),
} = {}) {
  const backdrop = el('ai-backdrop'), modal = backdrop.querySelector('.modal');
  modal.classList.add('ai-modal');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'ai-heading');
  modal.innerHTML = `
    <div class="ai-heading-row"><div><h2 id="ai-heading">Configure AI provider</h2><p id="ai-purpose" class="ai-muted">Choose where approved questions are sent. No AI tools, SQL execution, or system access.</p><p id="ai-visual-context" class="ai-visual-context" hidden></p></div><button class="btn ghost" id="ai-close" aria-label="Close AI assistant">Close</button></div>
    <div id="ai-provider-summary-row" class="ai-provider-summary-row" hidden><span id="ai-provider-summary"></span><button type="button" class="btn ghost" id="ai-configure" aria-controls="ai-settings-panel" aria-expanded="false">Configure</button></div>
    <details id="ai-settings-panel" open><summary>AI provider settings</summary>
      <p class="ai-muted">Choose a provider. Each provider keeps its own configuration. API keys and tokens are encrypted on the dashboard server, never stored in your browser.</p>
      <div id="ai-provider-cards" class="ai-provider-cards"></div>
      <div id="ai-provider-form"></div>
      <div class="ai-actions"><button class="btn" id="ai-save">Save settings</button><button class="btn ghost" id="ai-refresh-models">Reload models</button><button class="btn ghost" id="ai-test">Test provider</button></div>
      <div id="ai-model-status" class="ai-status" role="status" aria-live="polite"></div>
      <p class="ai-muted">Test provider sends only “Health check. Reply with exactly OK.” — no SQL data. A test may incur provider charges.</p>
    </details>
    <div id="ai-status" class="ai-status" role="status" aria-live="polite"></div>
    <div id="ai-chat-layout" class="ai-chat-layout" hidden>
    <section id="ai-question-panel" class="ai-question-panel" hidden aria-label="Chat about the selected visual">
      <div class="ai-chat-scroll" id="ai-chat-scroll" tabindex="0" aria-label="Conversation messages"><div id="ai-conversation" class="ai-conversation" role="log" aria-label="Conversation"></div><div id="ai-answer" class="ai-answer" hidden aria-live="polite"></div></div>
      <label for="ai-question">Your question</label>
      <textarea id="ai-question" rows="2" maxlength="8000" placeholder="Ask a question about this visual..."></textarea>
      <div id="ai-inline-review" class="ai-inline-review" hidden><p id="ai-send-warning"></p><p id="ai-send-destination"></p><details id="ai-exact-payload"><summary>Exact question &amp; data sent</summary><pre id="ai-exact-payload-text" tabindex="0"></pre></details></div>
      <div class="ai-actions ai-composer-actions"><button class="btn" id="ai-send">Send question</button><span class="ai-muted">Send approves the question and data shown above. No pop-up.</span></div>
      <div class="ai-recommendations"><p class="ai-muted">Recommended for this visual</p><div id="ai-suggestions" class="ai-suggestions"></div></div>
    </section>
    <details id="ai-context-panel" class="ai-context-panel"><summary>Context &amp; privacy</summary>
      <p id="ai-context-info" class="ai-muted" role="status">Capturing the selected visual...</p>
      <p class="ai-muted">Only this visual and recent successful chat turns are included. Context stays pinned while the dashboard refreshes. Provider retention and billing policies apply. Refreshing context starts a new conversation without running SQL.</p>
      <button type="button" class="btn ghost" id="ai-refresh-context">Refresh context</button>
      <pre id="ai-context-json" tabindex="0"></pre>
    </details></div>`;

  let saved = null, provider = '', drafts = {}, catalogs = new Map(), sequence = 0, busy = false, preview = null, loginTimer = null;
  let discoveryController = null, loginPending = false, loginSequence = 0, statusSequence = 0;
  let returnFocus = null, lastOperation = 0, destroyed = false;
  let mode = 'settings', visual = null, dialogSequence = 0, settingsLoad = null;
  let selectedContext = null, contextLoad = null, contextSequence = 0, lastAnswer = null, chatMessages = [];
  let reviewSequence = 0, reviewTimer = null, reviewController = null, reviewPending = null;
  function api(path, body, options = {}) {
    const timeoutMs = path === 'ask' || path === 'test' ? 200000 : path.startsWith('models') || path.startsWith('status') ? 65000 : 45000;
    return aiUiRequest(fetchImpl, path, body, { timeoutMs, ...options });
  }
  function status(message, error = false) {
    el('ai-status').textContent = message; el('ai-status').classList.toggle('ai-error', error);
  }
  function modelStatus(message, error = false) {
    el('ai-model-status').textContent = message;
    el('ai-model-status').classList.toggle('ai-error', error);
  }
  function cancelDiscovery() {
    ++sequence;
    discoveryController?.abort();
    discoveryController = null;
  }
  function invalidatePreview() {
    preview = null;
    ++reviewSequence; clearTimeout(reviewTimer); reviewTimer = null;
    reviewController?.abort(); reviewController = null; reviewPending = null;
    el('ai-inline-review').hidden = true;
    el('ai-exact-payload-text').textContent = '';
    el('ai-send').disabled = busy;
    el('ai-send').textContent = busy ? 'Working…' : 'Send question';
  }
  function updateProviderSummary() {
    if (!saved || !provider) { el('ai-provider-summary').textContent = 'Loading provider settings…'; return; }
    const name = saved.providers.find(p => p.id === provider)?.name || provider;
    const d = draft();
    el('ai-provider-summary').textContent = `Provider: ${name} / ${d.model || 'No model configured'}`;
  }
  function setBusy(value) {
    busy = value;
    modal.querySelectorAll('input,select,textarea,button').forEach(node => {
      if (node.id !== 'ai-close') node.disabled = value || (loginPending && ['ai-login', 'ai-switch'].includes(node.id));
    });
    if (!value && provider) updateReasoning();
    if (!value && provider === 'azure-openai' && el('ai-manual-model')) el('ai-manual-model').disabled = true;
    el('ai-send').disabled = value || Boolean(reviewPending);
    el('ai-send').textContent = value ? 'Working…' : reviewPending ? 'Preparing…' : 'Send question';
  }
  function draft() { return drafts[provider]; }
  function readForm() {
    if (!provider || !el('ai-model')) return;
    const d = draft();
    d.manualModel = el('ai-manual-model').checked;
    d.model = d.manualModel ? el('ai-model-input').value.trim() : el('ai-model').value;
    d.reasoningEffort = el('ai-effort').value;
    if (el('ai-endpoint')) d.baseUrl = el('ai-endpoint').value.trim();
    if (el('ai-auth-mode')) d.authMode = el('ai-auth-mode').value;
    if (el('ai-reasoning-enabled')) d.reasoningEnabled = el('ai-reasoning-enabled').checked;
    if (el('ai-clear-secret')) d.clearSecret = el('ai-clear-secret').checked;
    if (provider === 'azure-openai') d.deployment = d.model;
  }
  function capabilities() {
    const d = draft(), m = catalogs.get(provider)?.find(x => x.id === d.model);
    if (['local', 'azure-openai'].includes(provider)) return { reasoning: d.reasoningEnabled, reasoningEfforts: ['low', 'medium', 'high'] };
    if (provider === 'openai') return { reasoning: openAiReasoningModel(d.model), reasoningEfforts: ['low', 'medium', 'high'] };
    return m || { reasoning: false, reasoningEfforts: [] };
  }
  function updateReasoning() {
    readForm();
    const meta = capabilities(), effort = el('ai-effort'), d = draft();
    effort.disabled = busy || (!meta.reasoning && !d.reasoningEffort);
    [...effort.options].forEach(option => { option.disabled = Boolean(option.value && !(meta.reasoning && meta.reasoningEfforts?.includes(option.value))); });
    el('ai-effort-hint').textContent = d.reasoningEffort && (!meta.reasoning || !meta.reasoningEfforts?.includes(d.reasoningEffort))
      ? 'Selected effort is unsupported or unverified. Choose Default or a supported model before sending.'
      : meta.reasoning ? 'Only supported reasoning effort values are available.' : 'Default only: this provider/model has no verified reasoning effort support.';
    const manual = el('ai-manual-model').checked;
    el('ai-model').hidden = manual; el('ai-model-input').hidden = !manual;
  }
  function modelOptions() {
    const d = draft(), models = catalogs.get(provider) || [];
    const extra = d.model && !models.some(m => m.id === d.model) ? `<option value="${esc(d.model)}">${esc(d.model)} (saved; unverified)</option>` : '';
    return `<option value="">Choose a discovered model</option>${extra}${models.map(m => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}`;
  }
  function renderForm() {
    const d = draft(), isAzure = provider === 'azure-openai', isGitHub = provider === 'github';
    const manual = isAzure || Boolean(d.manualModel);
    el('ai-provider-cards').innerHTML = saved.providers.map(p => `<button type="button" class="ai-provider-card${provider === p.id ? ' selected' : ''}" data-provider="${esc(p.id)}" aria-pressed="${provider === p.id}"><span class="ai-provider-icon">${esc(p.icon || ICONS[p.id] || '✦')}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.description)}</small></span></button>`).join('');
    el('ai-provider-form').innerHTML = `
      ${isGitHub ? `<div class="ai-github-row"><span id="ai-github-status" role="status">Checking GitHub sign-in…</span><div class="ai-actions"><button class="btn ghost" id="ai-login">Sign in with GitHub CLI</button><button class="btn ghost" id="ai-switch">Switch GitHub account</button></div><p class="ai-muted">Uses your Copilot subscription. Sign-in changes GitHub CLI authentication on this computer. No tools or MCP servers are exposed to AI.</p><div id="ai-login-state" class="ai-login-state" hidden></div></div>` : ''}
      <div class="ai-form-grid">
        ${!isGitHub ? `<label class="ai-field ai-wide">Endpoint<input id="ai-endpoint" type="url" maxlength="2048" value="${esc(d.baseUrl)}" placeholder="${isAzure ? 'https://RESOURCE.openai.azure.com' : 'https://provider.example/v1'}"><small class="ai-muted">HTTPS required for cloud and remote endpoints. Explicit HTTP is permitted only for loopback/private local providers.</small></label>` : ''}
        ${isAzure ? `<label class="ai-field">Authentication<select id="ai-auth-mode"><option value="entra"${d.authMode === 'entra' ? ' selected' : ''}>Entra ID (Azure CLI)</option><option value="key"${d.authMode === 'key' ? ' selected' : ''}>API key</option></select><small class="ai-muted">Entra uses an existing az login session.</small></label>` : ''}
        <label class="ai-field${isAzure ? '' : ' ai-wide'}">${isAzure ? 'Deployment name (actual Azure deployment)' : 'Model'}
          <select id="ai-model">${modelOptions()}</select><input id="ai-model-input" maxlength="200" value="${esc(isAzure ? d.deployment || d.model : d.model)}" placeholder="${isAzure ? 'Enter your actual deployment name' : 'Enter a model ID explicitly'}">
          <span class="ai-checkbox"><input type="checkbox" id="ai-manual-model"${manual ? ' checked' : ''}${isAzure ? ' disabled' : ''}> ${isAzure ? 'Azure deployment is explicitly configured, never guessed' : 'Enter a model ID manually (not verified by discovery)'}</span>
        </label>
        <label class="ai-field">Reasoning effort<select id="ai-effort"><option value="">Default</option>${EFFORTS.map(e => `<option value="${e}"${d.reasoningEffort === e ? ' selected' : ''}>${e}</option>`).join('')}</select><small class="ai-muted" id="ai-effort-hint"></small></label>
        ${['local', 'azure-openai'].includes(provider) ? `<label class="ai-checkbox ai-field"><input type="checkbox" id="ai-reasoning-enabled"${d.reasoningEnabled ? ' checked' : ''}> This deployment supports OpenAI reasoning_effort (enable only if documented by your host)</label>` : ''}
        <label class="ai-field ai-wide">${isGitHub ? 'GitHub token (optional)' : isAzure ? 'API key (only for key authentication)' : ['ollama', 'local'].includes(provider) ? 'API key (optional)' : 'API key'}
          <input id="ai-secret" type="password" autocomplete="new-password" maxlength="16384" placeholder="${d.hasSecret ? 'Encrypted credential saved — leave blank to keep' : d.hasEnvironmentSecret ? 'Environment credential available — leave blank to use' : 'Enter credential'}">
          <span class="ai-checkbox"><input type="checkbox" id="ai-clear-secret"> Clear saved credential (environment credentials remain available)</span>
        </label>
      </div>`;
    el('ai-model').value = d.model;
    // Credentials remain only in this input until submitted, never in drafts.
    el('ai-secret').value = '';
    el('ai-clear-secret').checked = Boolean(d.clearSecret);
    updateReasoning();
    el('ai-provider-form').querySelectorAll('input,select').forEach(node => {
      node.addEventListener('input', () => { if (node.id !== 'ai-manual-model') readForm(); invalidatePreview(); });
      node.addEventListener('change', () => {
        if (node.id === 'ai-manual-model') {
          const current = draft();
          current.manualModel = node.checked;
          if (node.checked) el('ai-model-input').value = current.model;
        }
        readForm(); updateReasoning(); updateProviderSummary(); invalidatePreview();
      });
    });
    el('ai-provider-cards').querySelectorAll('[data-provider]').forEach(node => node.addEventListener('click', () => { void switchProvider(node.dataset.provider); }));
    if (isGitHub) {
      el('ai-login').addEventListener('click', () => { void signIn(false); });
      el('ai-switch').addEventListener('click', () => { void signIn(true); });
      if (mode === 'settings' || el('ai-settings-panel').open) {
        void loadStatus();
        if (!loginPending) void restoreLogin();
      } else el('ai-github-status').textContent = 'Open Configure to check GitHub authentication or sign in.';
    }
    if (busy) setBusy(true);
    updateProviderSummary();
  }
  async function persist() {
    cancelDiscovery();
    readForm();
    const id = provider, d = draft(), config = {};
    for (const key of ['baseUrl', 'model', 'deployment', 'authMode', 'reasoningEnabled', 'reasoningEffort']) config[key] = d[key];
    if (el('ai-secret').value) config.secret = el('ai-secret').value;
    if (d.clearSecret) config.clearSecret = true;
    if (saved.providerId === id && !config.secret && !config.clearSecret
      && Object.entries(config).every(([key, value]) => value === saved.configs[id][key])) return saved;
    let next;
    try { next = await api('settings', { providerId: id, config }); }
    finally { delete config.secret; }
    saved = next;
    drafts[id] = { ...next.configs[id], manualModel: d.manualModel };
    el('ai-secret').value = '';
    el('ai-secret').placeholder = next.configs[id].hasSecret ? 'Encrypted credential saved — leave blank to keep'
      : next.configs[id].hasEnvironmentSecret ? 'Environment credential available — leave blank to use' : 'Enter credential';
    el('ai-clear-secret').checked = false; invalidatePreview();
    updateProviderSummary();
    return next;
  }
  async function operation(fn) {
    if (busy || destroyed) return;
    const operationId = ++lastOperation; setBusy(true);
    try { await fn(); } catch (e) { status(e.message, true); }
    finally { if (operationId === lastOperation) setBusy(false); }
  }
  async function switchProvider(id) {
    if (busy || id === provider) return;
    await operation(async () => {
      await persist();
      provider = id; ++sequence; invalidatePreview(); renderForm();
      await persist();
      void discover();
    });
  }
  async function loadStatus() {
    const id = provider, guard = ++statusSequence;
    try {
      const data = await api(`status?providerId=${encodeURIComponent(id)}`);
      if (destroyed || loginPending || guard !== statusSequence || id !== provider) return;
      if (el('ai-github-status')) {
        el('ai-github-status').textContent = data.isAuthenticated ? `✓ Signed in${data.login ? `: ${data.login}` : ''}` : data.message || 'GitHub is not signed in.';
        el('ai-github-status').classList.toggle('ai-error', !data.isAuthenticated);
      }
    } catch (e) {
      if (guard === statusSequence && id === provider && el('ai-github-status')) {
        el('ai-github-status').textContent = e.message;
        el('ai-github-status').classList.add('ai-error');
      }
    }
  }
  async function discover() {
    cancelDiscovery();
    const id = provider, guard = sequence, controller = new AbortController();
    discoveryController = controller;
    modelStatus('Loading models in the background. GitHub sign-in remains available.');
    try {
      const data = await api(`models?providerId=${encodeURIComponent(id)}`, undefined, { signal: controller.signal });
      if (destroyed || guard !== sequence || id !== provider) return;
      catalogs.set(id, data.models || []);
      const d = draft();
      if (id === 'github' && !d.model && data.models?.some(m => m.id === 'auto')) d.model = 'auto';
      el('ai-model').innerHTML = modelOptions(); el('ai-model').value = d.model;
      updateReasoning();
      updateProviderSummary();
      modelStatus(data.note || `Model discovery succeeded · ${fmtInt(data.models?.length || 0)} models. No prompt was sent.`);
      if (id === 'github') void loadStatus();
    } catch (e) {
      if (controller.signal.aborted || guard !== sequence || id !== provider) return;
      catalogs.delete(id); updateReasoning();
      modelStatus(`${e.message} Discovery unavailable; explicitly enter a model ID to try it. This does not verify a connection.`, true);
    } finally { if (discoveryController === controller) discoveryController = null; }
  }
  async function signIn(switchAccount) {
    if (busy || loginPending) return;
    if (switchAccount && !(await confirmDialog('Switch GitHub account?', 'This starts GitHub CLI sign-in for another account on this computer and clears this app’s saved GitHub token. It changes the global gh identity, which may affect other applications. Existing accounts are not automatically logged out. Environment GitHub tokens will be ignored for this dashboard until restart.', 'Switch account'))) return;
    await operation(async () => {
      ++loginSequence;
      ++statusSequence;
      cancelDiscovery();
      invalidatePreview();
      modelStatus('Model loading paused for GitHub sign-in.');
      showLogin({ state: 'running', starting: true });
      status(switchAccount ? 'Starting GitHub account switch…' : 'Starting GitHub device sign-in…');
      try {
        const result = await api('login', { switchAccount });
        showLogin(result);
        if (result.state === 'running') scheduleLogin();
      } catch (e) {
        showLogin({ state: 'failed', error: e.message });
        throw e;
      }
    });
  }
  function showLogin(data) {
    loginPending = data.state === 'running';
    setBusy(busy);
    if (provider !== 'github' || !el('ai-login-state')) return;
    const box = el('ai-login-state');
    const viewKey = JSON.stringify([data.state, data.deviceCode, data.error, Boolean(data.starting)]);
    if (box.dataset.loginView === viewKey) return;
    box.dataset.loginView = viewKey;
    box.hidden = false; box.replaceChildren();
    const message = document.createElement('p');
    message.textContent = data.state === 'succeeded' ? '✓ GitHub sign-in completed and Copilot access verified.'
      : data.error || (data.deviceCode ? 'Enter this code at GitHub to finish signing in.'
        : data.state === 'idle' ? 'No sign-in is running. Click Sign in to start again.'
        : data.starting ? 'Starting GitHub device sign-in…' : 'Waiting for GitHub CLI to display a device code…');
    box.append(message);
    if (data.deviceCode && data.state === 'running') {
      const row = document.createElement('div'); row.className = 'ai-login-code-row';
      const code = document.createElement('input');
      code.id = 'ai-login-code'; code.className = 'ai-login-code'; code.type = 'text';
      code.value = data.deviceCode; code.readOnly = true; code.spellcheck = false; code.autocomplete = 'off';
      code.setAttribute('aria-label', 'GitHub sign-in code');
      code.addEventListener('focus', () => code.select());
      code.addEventListener('click', () => code.select());
      const copy = document.createElement('button');
      copy.id = 'ai-copy-code'; copy.type = 'button'; copy.className = 'btn ghost'; copy.textContent = 'Copy code';
      const feedback = document.createElement('p');
      feedback.id = 'ai-copy-code-status'; feedback.className = 'ai-muted';
      feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
      let copying = false;
      copy.addEventListener('click', async () => {
        if (copying) return;
        copying = true; copy.disabled = true; feedback.textContent = '';
        feedback.classList.remove('ai-error');
        try {
          await copySignInCode(code.value);
          feedback.textContent = 'Code copied. Paste it into GitHub with Ctrl+V.';
        } catch (error) {
          feedback.textContent = error.message;
          feedback.classList.add('ai-error');
          code.focus(); code.select();
        } finally { copying = false; copy.disabled = false; }
      });
      row.append(code); row.append(copy); box.append(row); box.append(feedback);
      const link = document.createElement('a'); link.href = 'https://github.com/login/device'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = 'Open GitHub device sign-in ↗'; box.append(link);
    }
  }
  async function restoreLogin() {
    const guard = loginSequence;
    try {
      const data = await api('login-status');
      if (destroyed || loginPending || provider !== 'github' || guard !== loginSequence) return;
      if (data.state !== 'idle') showLogin(data);
      if (data.state === 'running') scheduleLogin();
    } catch (e) { if (guard === loginSequence && provider === 'github') status(e.message, true); }
  }
  async function refreshGitHubAuthentication() {
    const next = await api('settings');
    if (destroyed || (saved && next.revision < saved.revision)) return;
    saved = next;
    if (drafts.github) {
      drafts.github.hasSecret = next.configs.github.hasSecret;
      drafts.github.hasEnvironmentSecret = next.configs.github.hasEnvironmentSecret;
    }
    if (provider === 'github') {
      const secret = el('ai-secret');
      if (secret && !secret.value) {
        secret.placeholder = next.configs.github.hasSecret ? 'Encrypted credential saved — leave blank to keep'
          : next.configs.github.hasEnvironmentSecret ? 'Environment credential available — leave blank to use' : 'Enter credential';
      }
      void loadStatus();
      if (!busy) void discover();
    }
  }
  function scheduleLogin() {
    clearTimeout(loginTimer);
    loginTimer = setTimeout(async () => {
      if (destroyed) return;
      try {
        const data = await api('login-status'); showLogin(data);
        if (data.state === 'running') scheduleLogin();
        else if (data.state === 'succeeded') {
          await refreshGitHubAuthentication();
        }
      } catch (e) {
        showLogin({ state: 'failed', error: `Cannot read sign-in progress: ${e.message}` });
        status(e.message, true);
      }
    }, 1500);
  }
  function scheduleReview() {
    invalidatePreview();
    if (mode !== 'analysis' || !visual || busy || destroyed || !el('ai-question').value.trim()) return;
    reviewTimer = setTimeout(() => { reviewTimer = null; void prepareReview(); }, 500);
  }
  function prepareReview() {
    if (reviewPending) return reviewPending;
    if (mode !== 'analysis' || !visual || destroyed || !el('ai-question').value.trim()) return Promise.resolve();
    const selected = visual, serverId = selected.serverId, guard = dialogSequence;
    const question = el('ai-question').value.trim();
    const generation = reviewSequence, controller = new AbortController();
    clearTimeout(reviewTimer); reviewTimer = null; reviewController = controller;
    el('ai-send').disabled = true; el('ai-send').textContent = 'Preparing…';
    const request = (async () => {
      status('Preparing inline question review…');
      await ensureSettings();
      if (contextLoad) await contextLoad;
      if (generation !== reviewSequence || guard !== dialogSequence || destroyed) return;
      if (!serverId || getActiveServerId() !== serverId) throw new Error('The selected server changed or was removed. Open Ask AI on the intended visual again.');
      if (!selectedContext) throw new Error('Context is not available. Open Context & privacy and choose Refresh context.');
      readForm();
      if (!draft().model) throw new Error('No model configured. Use Configure to select and save a provider/model before previewing.');
      const id = provider, d = draft();
      const dirty = saved.providerId !== id || el('ai-secret').value || d.clearSecret ||
        ['baseUrl', 'model', 'deployment', 'authMode', 'reasoningEnabled', 'reasoningEffort'].some(key => d[key] !== saved.configs[id][key]);
      if (dirty) throw new Error('Save the provider settings before reviewing or sending this question.');
      if (!d.model) throw new Error('Select or explicitly enter a model before previewing.');
      const meta = capabilities();
      if (d.reasoningEffort && (!meta.reasoning || !meta.reasoningEfforts?.includes(d.reasoningEffort))) {
        throw new Error('Selected reasoning effort is unsupported or unverified. Use Configure to reload models or choose Default before previewing.');
      }
      if (getActiveServerId() !== serverId) throw new Error('The selected server changed. Open Ask AI on the intended visual again.');
      const data = await api('preview', {
        serverId, providerId: id, model: d.model, reasoningEffort: d.reasoningEffort, question,
        scope: selected.scope, metricId: selected.metricId, panelTitle: selected.title, contextId: selectedContext.contextId,
        from: selected.from, to: selected.to, baseline: selected.baseline,
      }, { signal: controller.signal });
      if (guard !== dialogSequence || generation !== reviewSequence || destroyed || el('ai-question').value.trim() !== question) return;
      if (getActiveServerId() !== serverId) throw new Error('The selected server changed. Open Ask AI on the intended visual again.');
      if (!data.previewId || typeof data.prompt !== 'string') throw new Error('The dashboard did not return a valid payload preview.');
      if (data.serverId && data.serverId !== serverId) throw new Error('The preview server did not match the selected visual.');
      const payload = { ...data, question, serverId, providerId: id, model: d.model, revision: saved.revision, dialogSequence: guard };
      preview = payload;
      const warning = data.isLoopback
        ? '⚠️ This message contains details from your private data. Confirm before I send? The destination is local; the model may have its own network behavior.'
        : '⚠️ This message contains details from your private data. Confirm before I send?';
      const sampledAt = Object.hasOwn(data, 'sampledAt') ? data.sampledAt || 'not available' : data.sampleGeneratedAt || 'not recorded';
      const section = data.sectionMetadata?.[selected.scope];
      const freshness = section?.applicable === false ? ' · Not supported by this engine'
        : section?.stale ? ' · STALE cached section — review the collection error'
          : section?.intervalSeconds ? ` · Section refresh interval: ${section.intervalSeconds}s` : '';
      const lookback = selected.scope === 'top_queries' && section?.lookbackHours
        ? ` · Query Store lookback: ${section.lookbackHours}h (independently sampled)` : '';
      el('ai-send-destination').textContent = `To: ${data.providerName} · ${d.model} · ${data.destination}\nQuestion: ${question}\nContext: ${selected.title} · ${fmtInt(data.contextBytes || 0)} bytes · Section sampled: ${sampledAt}${freshness}${lookback} · Snapshot: ${data.sampleGeneratedAt || 'not recorded'}`;
      el('ai-send-warning').textContent = warning;
      el('ai-exact-payload-text').textContent = data.prompt;
      el('ai-exact-payload').open = false;
      el('ai-inline-review').hidden = false;
      status('Ready. Send question approves the destination and exact payload shown inline. Nothing has been sent yet.');
    })().catch(error => {
      if (!controller.signal.aborted && generation === reviewSequence && guard === dialogSequence && !destroyed) status(error.message, true);
    }).finally(() => {
      if (reviewPending === request) reviewPending = null;
      if (reviewController === controller) reviewController = null;
      if (generation === reviewSequence && guard === dialogSequence && !destroyed) {
        el('ai-send').disabled = busy; el('ai-send').textContent = busy ? 'Working…' : 'Send question';
      }
    });
    reviewPending = request;
    return request;
  }
  async function sendQuestion() {
    if (busy || destroyed) return;
    if (mode !== 'analysis' || !visual) { status('Select a visual before asking a question.', true); return; }
    if (!el('ai-question').value.trim()) { status('Enter a question or choose a recommended prompt.', true); el('ai-question').focus(); return; }
    if (!preview) { await prepareReview(); return; }
    const payload = preview;
    if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
      invalidatePreview(); await prepareReview(); return;
    }
    await operation(async () => {
      if (preview !== payload || getActiveServerId() !== payload.serverId || provider !== payload.providerId
        || saved.revision !== payload.revision || mode !== 'analysis' || payload.dialogSequence !== dialogSequence
        || el('ai-question').value.trim() !== payload.question) {
        invalidatePreview(); throw new Error('The question, server or provider changed. Send again to review the current question.');
      }
      invalidatePreview();
      await sendApprovedQuestion(payload);
    });
  }
  async function sendApprovedQuestion(payload) {
      status('Sending question…');
      modal.classList.add('ai-has-messages');
      if (lastAnswer) chatMessages.push({ role: 'assistant', text: lastAnswer });
      chatMessages.push({ role: 'user', text: payload.question });
      chatMessages = chatMessages.slice(-11);
      el('ai-conversation').innerHTML = chatMessages.map(message => `<div class="ai-chat-message ${message.role}"><strong>${message.role === 'user' ? 'You' : 'SQL Pulse AI'}</strong><div>${message.role === 'assistant' && renderSimpleMd ? renderSimpleMd(message.text) : esc(message.text)}</div></div>`).join('');
      lastAnswer = null;
      const answer = el('ai-answer'); answer.hidden = false; answer.textContent = 'Waiting for the selected provider…';
      const started = Date.now();
      try {
        const data = await api('ask', { previewId: payload.previewId });
        if (payload.dialogSequence !== dialogSequence) return;
        if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('The AI provider returned no answer.');
        lastAnswer = data.answer;
        if (renderSimpleMd) answer.innerHTML = renderSimpleMd(data.answer); else answer.textContent = data.answer;
        const footer = document.createElement('div'); footer.className = 'ai-answer-footer';
        footer.textContent = `${data.model || payload.model} · server ${payload.serverId} · ${payload.panelTitle || visual?.title || 'Selected visual'} · ${fmtInt(data.contextBytes || payload.contextBytes || 0)} context bytes · ${((Date.now() - started) / 1000).toFixed(1)}s`;
        answer.append(footer); status('Answer received. Validate recommendations before taking action.');
        if (el('ai-question').value.trim() === payload.question) el('ai-question').value = '';
        const messages = el('ai-chat-scroll');
        messages.scrollTop = messages.scrollHeight;
        el('ai-question').focus();
      } catch (e) { if (payload.dialogSequence === dialogSequence) answer.textContent = `Failed: ${e.message}`; throw e; }
  }
  function captureContext({ refresh = false } = {}) {
    const selected = visual, guard = dialogSequence, capture = ++contextSequence;
    selectedContext = null; invalidatePreview();
    chatMessages = []; lastAnswer = null;
    modal.classList.remove('ai-has-messages');
    el('ai-conversation').replaceChildren(); el('ai-answer').hidden = true; el('ai-answer').textContent = '';
    el('ai-context-json').textContent = '';
    el('ai-context-info').textContent = 'Capturing the selected visual...';
    const request = api('context', {
      serverId: selected.serverId, scope: selected.scope, metricId: selected.metricId, panelTitle: selected.title,
      from: selected.from, to: selected.to, baseline: selected.baseline,
      visualSampleAt: refresh ? getServerData(selected.serverId)?.generated_at || selected.visualSampleAt : selected.visualSampleAt,
    }).then(data => {
      if (guard !== dialogSequence || capture !== contextSequence || destroyed) return;
      if (!data.contextId || data.serverId !== selected.serverId || data.scope !== selected.scope || !data.context) throw new Error('The dashboard returned invalid visual context.');
      selectedContext = data;
      const section = data.sectionMetadata?.[selected.scope];
      el('ai-context-info').textContent = `Pinned snapshot: ${data.sampleGeneratedAt || 'not recorded'} · Section sampled: ${data.sampledAt || 'not available'} · ${fmtInt(data.contextBytes || 0)} bytes${section?.stale ? ' · STALE section; review collection limitations' : ''}${data.updatedFromViewed ? ' · The visual refreshed before capture; this is the newer cached snapshot shown below.' : ''} · Expires: ${data.expiresAt || 'soon'}.`;
      el('ai-context-json').textContent = JSON.stringify(data.context, null, 2);
    }).catch(error => {
      if (guard === dialogSequence && capture === contextSequence && !destroyed) {
        el('ai-context-info').textContent = `Context unavailable: ${error.message}`;
        status(error.message, true);
        throw error;
      }
    }).finally(() => { if (contextLoad === request) contextLoad = null; });
    contextLoad = request;
    return request;
  }
  async function ensureSettings() {
    if (saved || destroyed) return;
    if (!settingsLoad) {
      settingsLoad = (async () => {
        const next = await api('settings');
        if (destroyed) return;
        saved = next; provider = saved.providerId;
        drafts = Object.fromEntries(Object.entries(saved.configs).map(([id, c]) => [id, { ...c, manualModel: Boolean(c.model) }]));
        renderForm();
      })().finally(() => { settingsLoad = null; });
    }
    await settingsLoad;
  }
  function showMode(nextMode) {
    mode = nextMode; ++dialogSequence; invalidatePreview();
    el('ai-answer').hidden = true; el('ai-answer').textContent = '';
    el('ai-conversation').replaceChildren(); chatMessages = []; lastAnswer = null; selectedContext = null;
    modal.classList.remove('ai-has-messages');
    el('ai-chat-layout').hidden = mode !== 'analysis';
    el('ai-question-panel').hidden = mode !== 'analysis';
    el('ai-provider-summary-row').hidden = mode !== 'analysis';
    el('ai-visual-context').hidden = mode !== 'analysis';
    el('ai-settings-panel').open = mode === 'settings';
    el('ai-settings-panel').hidden = mode !== 'settings';
    el('ai-context-panel').open = false;
    modal.classList.toggle('ai-analysis', mode === 'analysis');
    el('ai-configure').setAttribute('aria-expanded', 'false');
    el('ai-heading').textContent = mode === 'settings' ? 'Configure AI provider' : `Ask AI · ${visual.title}`;
    el('ai-purpose').textContent = mode === 'settings'
      ? 'Choose where approved questions are sent. Credentials are encrypted on the dashboard server.'
      : 'Analyze only the selected visual. No AI tools, SQL execution, or system access.';
    if (mode === 'analysis') el('ai-visual-context').textContent = `Server: ${visual.serverName} · ${visual.scope}${visual.lookbackHours ? ` · Query Store lookback: ${visual.lookbackHours}h (independently sampled)` : ''}${visual.visualSampleAt ? ` · Viewed snapshot: ${visual.visualSampleAt}` : ''}`;
    status(''); updateProviderSummary();
    if (!backdrop.classList.contains('show')) returnFocus = document.activeElement;
    backdrop.classList.add('show');
  }
  async function openSettings() {
    if (destroyed || busy) return;
    const settingsWereLoaded = Boolean(saved);
    visual = null; showMode('settings');
    const guard = dialogSequence;
    try {
      await ensureSettings();
      if (guard !== dialogSequence || destroyed) return;
      if (settingsWereLoaded && provider === 'github') {
        void loadStatus();
        if (!loginPending) void restoreLogin();
      }
      if (!catalogs.has(provider) && !discoveryController) void discover();
      el('ai-provider-cards').querySelector('[data-provider]')?.focus();
    } catch (e) { if (guard === dialogSequence) status(e.message, true); }
  }
  async function askVisual({ serverId, scope = 'instance', metricId, title, question, visualSampleAt, from, to, baseline } = {}) {
    if (destroyed || busy) return;
    if (!serverId || !Object.hasOwn(VISUAL_TITLES, scope)) throw new Error('Select a server and a valid visual before asking AI.');
    const serverName = getServerName(serverId) || serverId;
    const serverData = getServerData(serverId);
    const panelTitle = (String(title || VISUAL_TITLES[scope]).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200)) || VISUAL_TITLES[scope];
    visual = {
      serverId, serverName, scope, metricId, title: panelTitle,
      visualSampleAt: scope === 'history' ? undefined : visualSampleAt ?? serverData?.generated_at,
      from, to, baseline,
      lookbackHours: scope === 'top_queries' ? serverData?.sectionMetadata?.top_queries?.lookbackHours : undefined,
    };
    el('ai-suggestions').replaceChildren();
    for (const prompt of recommendedVisualPrompts(visual)) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn ghost ai-suggest';
      button.textContent = prompt.label; button.title = prompt.question;
      button.setAttribute('aria-label', prompt.question);
      button.addEventListener('click', () => {
        el('ai-question').value = prompt.question; scheduleReview(); el('ai-question').focus();
      });
      el('ai-suggestions').append(button);
    }
    showMode('analysis');
    const guard = dialogSequence;
    el('ai-question').value = String(question || '').slice(0, 8000);
    el('ai-question').focus();
    try {
      await Promise.all([ensureSettings(), captureContext()]);
      if (guard !== dialogSequence || destroyed) return;
      if (!draft().model) status('No model configured. Use Configure to select and save a provider/model. Nothing has been sent.');
      else if (draft().reasoningEffort && !capabilities().reasoningEfforts?.includes(draft().reasoningEffort)) {
        status('The saved reasoning effort needs verification. Use Configure to reload models or select Default. Nothing has been sent.');
      }
      el('ai-question').focus();
      if (el('ai-question').value.trim()) scheduleReview();
    } catch (e) { if (guard === dialogSequence) status(e.message, true); }
  }
  function close() {
    ++dialogSequence; backdrop.classList.remove('show'); invalidatePreview();
    if (el('ai-secret')) el('ai-secret').value = '';
    returnFocus?.focus?.();
  }
  const openHandler = () => { void openSettings(); };
  el('ai-btn')?.addEventListener('click', openHandler);
  if (el('ai-btn')) {
    el('ai-btn').title = 'Configure AI provider, model, and encrypted credentials';
    el('ai-btn').setAttribute('aria-label', 'Configure AI provider');
  }
  el('ai-configure').addEventListener('click', () => {
    const settings = el('ai-settings-panel');
    settings.open = !settings.open;
    settings.hidden = !settings.open;
    if (settings.open) el('ai-context-panel').open = false;
    el('ai-configure').setAttribute('aria-expanded', String(settings.open));
    if (settings.open && saved) {
      if (provider === 'github') {
        void loadStatus();
        if (!loginPending) void restoreLogin();
      }
      if (!catalogs.has(provider) && !discoveryController) void discover();
      el('ai-provider-cards').querySelector('[data-provider]')?.focus();
    }
  });
  el('ai-settings-panel').addEventListener('toggle', () => {
    el('ai-configure').setAttribute('aria-expanded', String(el('ai-settings-panel').open));
  });
  el('ai-context-panel').addEventListener('toggle', () => {
    if (mode !== 'analysis' || !el('ai-context-panel').open) return;
    el('ai-settings-panel').open = false; el('ai-settings-panel').hidden = true;
    el('ai-configure').setAttribute('aria-expanded', 'false');
  });
  el('ai-close').addEventListener('click', close);
  el('ai-save').addEventListener('click', () => { void operation(async () => { await persist(); status('Provider settings saved.'); renderForm(); }); });
  el('ai-refresh-models').addEventListener('click', () => { void operation(async () => { await persist(); void discover(); }); });
  el('ai-test').addEventListener('click', () => { void operation(async () => {
    await persist(); const d = draft();
    if (!d.model) throw new Error('Select or explicitly enter a model to test.');
    const data = await api('test', { providerId: provider, model: d.model, reasoningEffort: d.reasoningEffort });
    if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('Provider test returned no answer.');
    status(`Provider test completed: ${data.answer.slice(0, 250)}. No SQL data was sent.`);
  }); });
  el('ai-refresh-context').addEventListener('click', () => { void operation(async () => { await captureContext({ refresh: true }); status('Context refreshed. A new conversation is ready; no SQL collection was triggered.'); }); });
  el('ai-send').addEventListener('click', () => { void sendQuestion(); });
  el('ai-question').addEventListener('input', scheduleReview);
  let down = null;
  backdrop.addEventListener('mousedown', event => { down = event.target; });
  backdrop.addEventListener('mouseup', event => { if (down === backdrop && event.target === backdrop) close(); down = null; });
  const keyHandler = event => {
    if (!backdrop.classList.contains('show')) return;
    if (el('confirm-backdrop')?.classList.contains('show')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const nodes = [...modal.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  document.addEventListener('keydown', keyHandler);
  return {
    open: openSettings, openSettings, askVisual, close,
    destroy() { destroyed = true; cancelDiscovery(); clearTimeout(loginTimer); el('ai-btn')?.removeEventListener('click', openHandler); document.removeEventListener('keydown', keyHandler); close(); },
  };
}
