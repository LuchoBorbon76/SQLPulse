const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function alertUiRequest(fetchImpl, path, body, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`/api/alerts/${path}`, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let value;
    try { value = await response.json(); } catch { throw new Error('The dashboard returned an invalid email-settings response.'); }
    if (!response.ok) {
      const error = new Error(value.error || value.message || `Email settings request failed (HTTP ${response.status}).`);
      if (path === 'test' && value.status === 'failed' && typeof value.time === 'string' && typeof value.message === 'string') {
        error.deliveryStatus = { time: value.time, message: value.message };
      }
      throw error;
    }
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Email request timed out. Its delivery outcome may be unknown; check the SMTP service before retrying.');
    throw error;
  } finally { clearTimeout(timer); }
}

export function initAlertSettingsUi({
  el = id => document.getElementById(id), esc = escapeHtml,
  confirmDialog = async (title, message) => window.confirm(`${title}\n\n${message}`),
  onMonitoringChanged = () => {}, onClose = () => {}, onClosed = onClose, fetchImpl = window.fetch.bind(window),
} = {}) {
  let backdrop = el('alert-settings-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'alert-settings-backdrop'; backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <section class="modal alert-settings-modal" role="dialog" aria-modal="true" aria-labelledby="email-settings-title" tabindex="-1">
      <header class="email-heading"><div><h2 id="email-settings-title">Notifications</h2><p class="email-muted">Optional, private by default, approved by you.</p></div><button type="button" class="btn ghost" id="email-close">Close</button></header>
      <p class="email-notice">SQL Pulse detects events on the next completed poll, not instant SQL push. Notification delivery may take longer. Background monitoring works without a browser only after you enable it; this computer must stay awake and the SQL Pulse Node process must keep running.</p>
      <form id="email-settings-form">
        <label class="email-switch"><input id="email-enabled" type="checkbox"><span><strong>Enable notifications + background monitoring</strong><small>Disabled by default. Enabling requires reviewing and approving the destinations, triggers and exact templates below.</small></span></label>
        <div id="email-options">
        <fieldset><legend>Recipients &amp; sender</legend><div class="email-grid">
          <label class="email-field email-wide" for="email-recipients">Recipient email addresses<textarea id="email-recipients" rows="3" maxlength="5200" placeholder="operator@example.com&#10;team@example.com"></textarea><small>One address per line, or comma-separated. Up to 20 unique recipients; addresses will be visible to each other.</small></label>
          <label class="email-field email-wide" for="email-sender">Sender address<input id="email-sender" type="email" maxlength="254" autocomplete="off" placeholder="sqlpulse@example.com"><small>Use an address allowed by your SMTP service.</small></label>
        </div></fieldset>
        <fieldset><legend>Secure SMTP delivery</legend><div class="email-grid">
          <label class="email-field" for="email-host">SMTP host<input id="email-host" maxlength="254" autocomplete="off" placeholder="smtp.example.com"></label>
          <label class="email-field" for="email-port">Port<input id="email-port" type="number" min="1" max="65535" value="587"></label>
          <label class="email-field email-wide" for="email-tls">Encryption<select id="email-tls"><option value="starttls">Required STARTTLS (typically port 587)</option><option value="implicit">Implicit TLS (typically port 465)</option></select><small>Trusted TLS certificates are required. Unencrypted SMTP is not supported.</small></label>
          <label class="email-field email-wide" for="email-auth-mode">Authentication<select id="email-auth-mode"><option value="password">SMTP password / authorized relay</option><option value="microsoft">Microsoft sign-in (OAuth2)</option></select><small>Outlook.com requires Microsoft sign-in. Password mode remains available for other SMTP providers.</small></label>
          <p id="email-provider-hint" class="email-notice email-wide" hidden>Gmail requires a Google app password, not your normal Google password. Enable 2-Step Verification, then create an app password for SQL Pulse. Use your full Gmail address, port 587 and STARTTLS. <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">Create a Google app password</a>. If this option is unavailable, your account policy may prohibit app passwords.</p>
          <div id="email-microsoft-panel" class="email-wide email-microsoft-panel" hidden>
            <p class="email-muted">Sign in through Microsoft, not with a password in this app. Tokens are encrypted on this computer and renewed silently; sending still requires your approval.</p>
            <div class="email-grid">
              <label class="email-field" for="email-microsoft-client">Application (client) ID<input id="email-microsoft-client" maxlength="36" autocomplete="off" placeholder="Your Microsoft app registration GUID"></label>
              <label class="email-field" for="email-microsoft-tenant">Account authority<input id="email-microsoft-tenant" maxlength="253" autocomplete="off" value="consumers"><small>consumers: personal Outlook; common: personal + work; or your tenant ID/domain.</small></label>
            </div>
            <details class="email-microsoft-setup"><summary>One-time app registration setup</summary><ol><li>Register your own app in Microsoft Entra with personal Microsoft accounts supported for Outlook.com.</li><li>Under Authentication, add Mobile and desktop applications with redirect URI <code>http://localhost/callback</code>. No client secret is needed.</li><li>Add Office 365 Exchange Online delegated permission <code>SMTP.Send</code> and paste the Application (client) ID here. Work accounts may require admin consent and SMTP AUTH enabled for the mailbox.</li></ol><a href="https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth" target="_blank" rel="noopener noreferrer">Microsoft OAuth documentation</a></details>
            <div class="email-actions"><button type="button" class="btn" id="email-microsoft-login">Sign in with Microsoft</button><button type="button" class="btn ghost" id="email-microsoft-cancel" hidden>Cancel sign-in</button><a id="email-microsoft-link" hidden target="_blank" rel="noopener noreferrer">Open Microsoft sign-in</a></div>
            <p id="email-microsoft-status" class="email-muted" role="status" aria-live="polite">Not signed in for email.</p>
          </div>
          <label class="email-field email-password-field" id="email-user-field" for="email-user">SMTP username<input id="email-user" maxlength="320" autocomplete="off"><small>Encrypted on the app host. Leave blank to keep a stored username.</small></label>
          <label class="email-field email-password-field" id="email-password-field" for="email-password">SMTP password<input id="email-password" type="password" maxlength="4096" autocomplete="new-password"><small id="email-secret-hint">Encrypted on the app host. Leave blank to keep the stored password; it is never returned to this form.</small></label>
          <label class="email-check email-wide" id="email-show-password-field"><input type="checkbox" id="email-show-password" aria-controls="email-password"> Show password</label>
        </div></fieldset>
        <fieldset><legend>Triggers &amp; polling</legend><div class="email-grid">
          <label class="email-check"><input id="email-critical" type="checkbox" checked> Critical conditions &amp; connection unavailable</label>
          <label class="email-check"><input id="email-warning" type="checkbox"> Warning conditions</label>
          <label class="email-check email-wide"><input id="email-recovery" type="checkbox" checked> Recovery after a condition successfully reported by notification</label>
          <label class="email-field" for="email-interval">Poll interval (seconds)<input id="email-interval" type="number" min="30" max="1800" value="60"><small>Default 60s; minimum 30s. SQL collection time is additional.</small></label>
          <label class="email-field" for="email-cooldown">Notification cooldown (seconds)<input id="email-cooldown" type="number" min="60" max="86400" value="120"><small>Suppresses flapping and repeated events; unchanged samples never send reminders.</small></label>
          <label class="email-check email-wide"><input id="email-server-name" type="checkbox"> Include the connection display name in notifications</label>
        </div><p class="email-muted">By default, notifications contain only a generic event and UTC detection time. No SQL text, database names, server addresses, custom-counter names or metric values are sent. Enabling display names can reveal private information.</p></fieldset>
        <div class="email-actions"><button type="submit" class="btn" id="email-save">Save / preview enabling</button><button type="button" class="btn ghost" id="email-test">Preview delivery test</button><button type="button" class="btn ghost" id="email-disable">Disable immediately</button></div>
        </div>
      </form>
      <section id="email-preview" class="email-preview" hidden aria-labelledby="email-preview-title"><h3 id="email-preview-title">Review before approving</h3><p id="email-preview-destination"></p><p id="email-preview-warning" class="email-notice"></p><p id="email-preview-summary"></p><p class="email-muted" id="email-template-hint"></p><div id="email-preview-templates"></div><div class="email-actions"><button type="button" class="btn" id="email-approve">Approve</button><button type="button" class="btn ghost" id="email-cancel">Cancel</button></div></section>
      <div id="email-status" class="email-status" role="status" aria-live="polite"></div>
      <div id="email-delivery" class="email-muted" role="status" aria-live="polite"></div>
    </section>`;
  const modal = backdrop.querySelector('.alert-settings-modal');
  let busy = false, preview = null, saved = null, returnFocus = null, destroyed = false, operation = 0;
  let microsoft = null, login = null, loginTimer = null, loginStarting = false;
  const api = (path, body) => alertUiRequest(fetchImpl, path, body);
  function status(message, error = false) {
    el('email-status').textContent = message;
    el('email-status').classList.toggle('email-error', error);
  }
  function setBusy(value) {
    busy = value;
    const off = !el('email-enabled').checked;
    modal.querySelectorAll('input,select,textarea,button').forEach(node => {
      if (node.id !== 'email-close') node.disabled = value || (off && node.id !== 'email-enabled');
    });
    modal.querySelectorAll('fieldset').forEach(node => { node.disabled = value || off; });
    const options = el('email-options');
    options.inert = value || off;
    options.classList.toggle('email-options-disabled', off);
    options.setAttribute('aria-disabled', String(off));
    el('email-preview').inert = value || off;
    el('email-save').textContent = value ? 'Working…' : 'Save / preview enabling';
    if (loginStarting || login?.state === 'running') el('email-microsoft-login').disabled = true;
  }
  function invalidate() {
    preview = null;
    el('email-preview').hidden = true;
    el('email-preview-templates').replaceChildren();
  }
  function body() {
    if (el('email-auth-mode').value === 'microsoft' && microsoft?.authenticated &&
      (el('email-microsoft-client').value.trim().toLowerCase() !== String(microsoft.clientId).toLowerCase()
        || el('email-microsoft-tenant').value.trim().toLowerCase() !== String(microsoft.tenant).toLowerCase())) {
      throw new Error('The Microsoft app ID or authority was edited. Sign in again before reviewing email settings.');
    }
    return {
      enabled: el('email-enabled').checked,
      emailEnabled: saved?.emailEnabled !== false,
      recipients: el('email-recipients').value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean),
      sender: el('email-sender').value.trim(), intervalSeconds: Number(el('email-interval').value),
      cooldownSeconds: Number(el('email-cooldown').value),
      levels: { warning: el('email-warning').checked, critical: el('email-critical').checked },
      sendRecovery: el('email-recovery').checked, includeServerName: el('email-server-name').checked,
      smtp: {
        host: el('email-host').value.trim(), port: Number(el('email-port').value), tlsMode: el('email-tls').value,
        authMode: el('email-auth-mode').value,
        ...(el('email-auth-mode').value === 'password' ? { username: el('email-user').value.trim(), password: el('email-password').value } : {}),
      },
    };
  }
  function concealPassword() {
    el('email-password').type = 'password';
    el('email-show-password').checked = false;
  }
  function renderAuthMode() {
    const oauth = el('email-auth-mode').value === 'microsoft';
    el('email-microsoft-panel').hidden = !oauth;
    for (const id of ['email-user-field', 'email-password-field', 'email-show-password-field']) el(id).hidden = oauth;
    el('email-provider-hint').hidden = oauth || el('email-host').value.trim().toLowerCase() !== 'smtp.gmail.com';
  }
  function renderMicrosoft(auth) {
    microsoft = auth;
    el('email-microsoft-client').value = auth.clientId || '';
    el('email-microsoft-tenant').value = auth.tenant || 'consumers';
    el('email-microsoft-status').textContent = auth.authenticationError || (auth.authenticated
      ? `Signed in for email: ${auth.username}. SMTP uses OAuth2; your Microsoft password is not stored.`
      : 'Not signed in for email. Enter your app ID, then sign in with Microsoft.');
  }
  function renderLogin(value) {
    login = value;
    const running = value.state === 'running';
    el('email-microsoft-login').disabled = busy || !el('email-enabled').checked || running || loginStarting;
    el('email-microsoft-cancel').hidden = !running;
    if (!running) el('email-microsoft-link').hidden = true;
    if (running) el('email-microsoft-status').textContent = 'Complete sign-in in the Microsoft browser tab. No email is sent by signing in.';
    else if (value.state === 'failed') el('email-microsoft-status').textContent = value.error || 'Microsoft sign-in failed. Check the app registration.';
    else if (value.state === 'cancelled') el('email-microsoft-status').textContent = 'Sign-in cancelled. No email was sent.';
  }
  function pollMicrosoft() {
    clearTimeout(loginTimer);
    loginTimer = setTimeout(async () => {
      if (destroyed || !backdrop.classList.contains('show')) return;
      try {
        const value = await api('microsoft/login-status?operationId=' + encodeURIComponent(login.operationId));
        renderLogin(value);
        if (value.state === 'running') pollMicrosoft();
        else if (value.state === 'succeeded') {
          renderMicrosoft(await api('microsoft/settings'));
          invalidate();
          status('Microsoft email sign-in completed. Review recipients and enable settings separately; nothing was sent.');
        }
      } catch (error) {
        el('email-microsoft-status').textContent = error.message;
        login = null;
        el('email-microsoft-login').disabled = busy || !el('email-enabled').checked;
        el('email-microsoft-cancel').hidden = true;
      }
    }, 1200);
  }
  function populate(settings) {
    saved = settings;
    const values = {
      'email-recipients': settings.recipients.join('\n'), 'email-sender': settings.sender,
      'email-interval': settings.intervalSeconds, 'email-cooldown': settings.cooldownSeconds,
      'email-host': settings.smtp.host, 'email-port': settings.smtp.port,
      'email-tls': settings.smtp.tlsMode, 'email-user': settings.smtp.username,
      'email-auth-mode': settings.smtp.authMode || 'password',
    };
    for (const [id, value] of Object.entries(values)) el(id).value = value;
    for (const [id, value] of Object.entries({
      'email-enabled': settings.enabled, 'email-warning': settings.levels.warning, 'email-critical': settings.levels.critical,
      'email-recovery': settings.sendRecovery, 'email-server-name': settings.includeServerName,
    })) el(id).checked = Boolean(value);
    el('email-password').value = ''; concealPassword();
    renderAuthMode();
    if (settings.microsoft) renderMicrosoft(settings.microsoft);
    el('email-user').placeholder = settings.smtp.hasUsername ? 'Stored securely — leave blank to keep' : 'SMTP account or blank for authorized relay';
    el('email-password').placeholder = settings.smtp.hasPassword ? 'Stored securely — leave blank to keep' : 'Enter SMTP password';
    el('email-delivery').textContent = settings.deliveryStatus ? `Last delivery: ${settings.deliveryStatus.time} — ${settings.deliveryStatus.message}` : 'No notification has been sent.';
  }
  function showPreview(value, type) {
    if (destroyed || !el('email-enabled').checked || !backdrop.classList.contains('show')) return;
    preview = { ...value, type };
    el('email-preview-destination').textContent = value.emailEnabled === false ? 'Email channel disabled. Only the reviewed webhook destinations will be contacted.'
      : `From: ${value.sender}\nTo: ${value.recipients.join(', ')}\nSMTP: ${value.smtp.host}:${value.smtp.port} (${value.smtp.tlsMode}; ${value.smtp.authMode === 'microsoft' ? 'Microsoft OAuth2' : 'password / relay'})`;
    el('email-preview-warning').textContent = value.warning;
    el('email-preview-summary').textContent = value.configSummary;
    el('email-template-hint').textContent = type === 'test'
      ? 'This test sends the exact subject and body shown below. It does not enable monitoring or save these settings.'
      : 'These are the exact outbound templates. {{time}} is replaced only by the event detection time in UTC; {{serverName}}, when opted in, is replaced by the connection display name. SQL details are never substituted.';
    el('email-preview-templates').innerHTML = (value.emailEnabled === false ? [] : value.templates).map(t => `<article><h4>${esc(t.subject)}</h4><pre tabindex="0">${esc(t.text)}</pre></article>`).join('')
      + (value.webhookTemplates || []).map(t => `<article><h4>${esc(t.destination)}</h4><pre tabindex="0">${esc(JSON.stringify(t, null, 2))}</pre></article>`).join('');
    el('email-approve').textContent = type === 'test' ? 'Send this exact notification test' : 'Approve & enable background notifications';
    el('email-preview').hidden = false;
    el('email-preview').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function perform(work) {
    if (busy || destroyed) return;
    setBusy(true); status('');
    try { await work(); } catch (error) {
      status(error.message || 'Email settings could not be updated.', true);
      if (error.deliveryStatus) el('email-delivery').textContent = `Last delivery: ${error.deliveryStatus.time} — ${error.deliveryStatus.message}`;
    }
    finally { if (!destroyed) setBusy(false); }
  }
  async function open() {
    if (destroyed || busy) return;
    returnFocus = document.activeElement;
    backdrop.classList.add('show'); invalidate(); modal.focus();
    const id = ++operation;
    await perform(async () => {
      const settings = await api('settings');
      if (id !== operation || destroyed) return;
      populate(settings);
      renderMicrosoft(settings.microsoft || await api('microsoft/settings'));
      const pendingLogin = await api('microsoft/login-status');
      if (pendingLogin.state === 'running') { renderLogin(pendingLogin); pollMicrosoft(); }
      onMonitoringChanged(settings);
      status(settings.enabled ? `Notifications enabled. Background polling every ${settings.intervalSeconds}s while the app host is awake and running.` : 'Notifications disabled. No background notification monitoring is authorized.');
    });
  }
  async function refresh({ preserveDrafts = true } = {}) {
    if (destroyed || busy) return;
    const id = ++operation;
    invalidate();
    return perform(async () => {
      const settings = await api('settings');
      if (destroyed || id !== operation) return;
      const values = preserveDrafts ? [
        'email-recipients', 'email-sender', 'email-interval', 'email-cooldown',
        'email-host', 'email-port', 'email-tls', 'email-user', 'email-password',
        'email-auth-mode', 'email-microsoft-client', 'email-microsoft-tenant',
      ].map(key => [key, el(key).value]) : [];
      const checks = preserveDrafts ? ['email-warning', 'email-critical', 'email-recovery', 'email-server-name']
        .map(key => [key, el(key).checked]) : [];
      populate(settings);
      values.forEach(([key, value]) => { el(key).value = value; });
      checks.forEach(([key, value]) => { el(key).checked = value; });
      renderAuthMode(); concealPassword();
      onMonitoringChanged(settings);
    });
  }
  function close() {
    ++operation; backdrop.classList.remove('show'); invalidate();
    clearTimeout(loginTimer);
    el('email-password').value = '';
    concealPassword();
    el('email-user').value = '';
    returnFocus?.focus();
    onClosed();
  }
  el('email-close').addEventListener('click', close);
  async function disableEmail() {
    invalidate();
    let settings;
    try {
      settings = await api('settings', { ...(saved || { smtp: {} }), enabled: false, disableOnly: true });
      if (settings.enabled !== false) throw new Error('The dashboard did not confirm that notification monitoring stopped. Refresh settings before retrying.');
    } catch (error) { el('email-enabled').checked = true; throw error; }
    saved = settings;
    onMonitoringChanged(settings);
    el('email-enabled').checked = false;
    concealPassword();
    status('Notifications disabled. Settings are greyed out and background notification monitoring stopped; a delivery already underway may finish.');
  }
  el('email-enabled').addEventListener('change', () => {
    if (busy) return;
    invalidate(); concealPassword(); setBusy(false);
    if (!el('email-enabled').checked) {
      void perform(disableEmail);
    } else status(saved?.enabled
      ? 'Notifications enabled. Review and approve any changes before applying them.'
      : 'Settings unlocked. Background notifications remain disabled until you review and approve enabling.');
  });
  el('email-auth-mode').addEventListener('change', () => {
    if (el('email-auth-mode').value === 'microsoft') {
      el('email-password').value = ''; concealPassword();
      if (!['smtp-mail.outlook.com', 'smtp.office365.com'].includes(el('email-host').value.trim().toLowerCase())) {
        el('email-host').value = 'smtp-mail.outlook.com';
      }
      el('email-port').value = '587'; el('email-tls').value = 'starttls';
    }
    renderAuthMode(); invalidate();
  });
  el('email-host').addEventListener('input', renderAuthMode);
  el('email-host').addEventListener('change', renderAuthMode);
  el('email-microsoft-login').addEventListener('click', () => {
    if (busy || !el('email-enabled').checked || loginStarting || login?.state === 'running') return;
    const clientId = el('email-microsoft-client').value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      status('Enter your Application (client) ID from the app registration setup before signing in.', true);
      el('email-microsoft-client').focus(); return;
    }
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    loginStarting = true; el('email-microsoft-login').disabled = true;
    const guard = operation;
    void perform(async () => {
      try {
        const value = await api('microsoft/login', { clientId, tenant: el('email-microsoft-tenant').value.trim() || 'consumers',
          username: el('email-sender').value.trim() || undefined });
        const url = new URL(value.authorizationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || !/\/oauth2\/v2\.0\/authorize$/.test(url.pathname)) {
          throw new Error('Microsoft sign-in returned an invalid authorization URL.');
        }
        const redirect = new URL(url.searchParams.get('redirect_uri'));
        if (url.searchParams.get('client_id')?.toLowerCase() !== clientId.toLowerCase()
          || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256'
          || !url.searchParams.get('code_challenge') || !url.searchParams.get('state')
          || redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' || redirect.pathname !== '/callback'
          || !redirect.port) throw new Error('Microsoft sign-in returned an invalid local authorization request.');
        renderLogin(value); invalidate();
        if (guard !== operation || destroyed) { if (tab && !tab.closed) tab.close(); return; }
        el('email-microsoft-link').href = url.href; el('email-microsoft-link').hidden = false;
        if (tab && !tab.closed) { tab.location.replace(url.href); tab.focus(); }
        pollMicrosoft();
      } catch (error) { if (tab && !tab.closed) tab.close(); throw error; }
      finally { loginStarting = false; }
    });
  });
  el('email-microsoft-cancel').addEventListener('click', () => {
    void perform(async () => {
      clearTimeout(loginTimer);
      renderLogin(await api('microsoft/cancel', { operationId: login?.operationId }));
      invalidate();
    });
  });
  el('email-show-password').addEventListener('change', () => {
    el('email-password').type = el('email-show-password').checked ? 'text' : 'password';
  });
  el('email-cancel').addEventListener('click', () => { invalidate(); status('Approval cancelled. Nothing was sent or enabled.'); });
  const formChanged = event => { if (event.target.id !== 'email-show-password') invalidate(); };
  el('email-settings-form').addEventListener('input', formChanged);
  el('email-settings-form').addEventListener('change', formChanged);
  el('email-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!el('email-enabled').checked) return;
    perform(async () => {
      invalidate();
      const candidate = body();
      if (candidate.enabled) showPreview(await api('settings-preview', candidate), 'settings');
      else {
        const settings = await api('settings', candidate);
        populate(settings); onMonitoringChanged(settings);
        status('Settings saved with notifications disabled. No message was sent.');
      }
    });
  });
  el('email-test').addEventListener('click', () => {
    if (!el('email-enabled').checked) return;
    return perform(async () => {
    invalidate();
    const candidate = body();
    showPreview(await api('test-preview', candidate), 'test');
    });
  });
  el('email-approve').addEventListener('click', () => {
    if (!el('email-enabled').checked) return;
    return perform(async () => {
    if (!preview) throw new Error('Preview the recipients and message again before approval.');
    const current = preview;
    const id = operation;
    const approved = await confirmDialog(current.type === 'test' ? 'Send the reviewed notification test?' : 'Enable reviewed notification monitoring?',
      `${current.warning}\n\n${current.type === 'test' ? 'Only the exact test shown above will be sent.' : current.configSummary}`,
      current.type === 'test' ? 'Send exact test' : 'Enable notifications', { danger: false });
    if (!approved || id !== operation || preview?.previewId !== current.previewId || destroyed) return;
    invalidate();
    if (current.type === 'test') {
      let result;
      concealPassword();
      try { result = await api('test', { previewId: current.previewId }); }
      finally { concealPassword(); }
      status(result.message, !result.ok);
      el('email-delivery').textContent = `Last delivery: ${result.time} — ${result.message}`;
    } else {
      const settings = await api('settings-apply', { previewId: current.previewId });
      populate(settings); onMonitoringChanged(settings);
      status(`Approved. Notification monitoring is enabled with ${settings.intervalSeconds}s polling. Destination acceptance is not guaranteed delivery to a person.`);
    }
    });
  });
  el('email-disable').addEventListener('click', () => { if (el('email-enabled').checked) void perform(disableEmail); });
  const keydown = event => {
    if (!backdrop.classList.contains('show')) return;
    if (el('confirm-backdrop')?.classList.contains('show')) return;
    if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const nodes = [...modal.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  document.addEventListener('keydown', keydown);
  const buttons = ['alerts-email-settings', 'alert-settings-btn'].map(el).filter(Boolean);
  buttons.forEach(button => button.addEventListener('click', open));
  return {
    open, close, refresh,
    destroy() {
      destroyed = true; ++operation; invalidate(); el('email-password').value = ''; el('email-user').value = '';
      clearTimeout(loginTimer);
      concealPassword();
      onClosed();
      document.removeEventListener('keydown', keydown); buttons.forEach(button => button.removeEventListener('click', open));
      backdrop.remove();
    },
  };
}
