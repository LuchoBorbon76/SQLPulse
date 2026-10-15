export const DISCLAIMER_VERSION = '2026-10-14-v1';
const STORAGE_KEY = 'sql-dashboard-disclaimer';

export function initDisclaimer({
  document: doc = document, storage = localStorage, logger = console,
} = {}) {
  const backdrop = doc.getElementById('about-backdrop');
  const button = doc.getElementById('about-close');
  const title = doc.getElementById('about-title');
  const hint = doc.getElementById('disclaimer-hint');
  const layout = doc.querySelector('.layout');
  let required = false, acknowledged = false, resolveAcknowledgement = null, pending = null;
  let previousFocus = null, downTarget = null;

  function show(firstRun = false) {
    previousFocus = doc.activeElement;
    required = firstRun;
    title.textContent = firstRun ? 'Before you begin' : 'About and responsible use';
    hint.textContent = firstRun
      ? 'Please review this notice before connecting to SQL Server. Acknowledgement is remembered in this browser.'
      : 'Review this notice at any time. Your acknowledgement does not approve any SQL action or AI data transfer.';
    button.textContent = firstRun ? 'I understand - open dashboard' : 'Close';
    backdrop.classList.add('show');
    layout.inert = true;
    button.focus();
  }

  function close() {
    if (required) return;
    backdrop.classList.remove('show');
    layout.inert = false;
    previousFocus?.focus();
  }

  function ensureAcknowledged() {
    if (acknowledged) return Promise.resolve();
    try {
      if (storage.getItem(STORAGE_KEY) === DISCLAIMER_VERSION) {
        acknowledged = true;
        return Promise.resolve();
      }
    } catch (error) { logger.warn('Disclaimer acknowledgement cannot be read from browser storage.', error.name); }
    if (!pending) {
      pending = new Promise(resolve => { resolveAcknowledgement = resolve; });
      show(true);
    }
    return pending;
  }

  doc.getElementById('info-btn').addEventListener('click', () => { if (!required) show(); });
  button.addEventListener('click', () => {
    if (required) {
      try { storage.setItem(STORAGE_KEY, DISCLAIMER_VERSION); }
      catch (error) { logger.warn('Disclaimer acknowledged for this session only; browser storage is unavailable.', error.name); }
      acknowledged = true;
      required = false;
      close();
      resolveAcknowledgement();
    } else close();
  });
  backdrop.addEventListener('mousedown', event => { downTarget = event.target; });
  backdrop.addEventListener('mouseup', event => {
    if (downTarget === backdrop && event.target === backdrop) close();
    downTarget = null;
  });
  doc.addEventListener('keydown', event => {
    if (!backdrop.classList.contains('show')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const nodes = [...backdrop.querySelectorAll('button,a[href]')].filter(node => !node.disabled);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  return { ensureAcknowledged };
}
