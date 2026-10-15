const trustedAddresses = new Set([
  'https://login.microsoft.com/device',
  'https://microsoft.com/devicelogin',
]);

export const BROWSER_URL_PREFIX = 'SQLPULSE_BROWSER_URL:';

export function normalizeMicrosoftBrowserUrl(value) {
  if (typeof value !== 'string' || value.length > 32768 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' ||
      url.port || url.username || url.password || url.hash ||
      !/^\/[a-z0-9][a-z0-9.-]*\/oauth2\/(?:v2\.0\/)?authorize$/i.test(url.pathname)) return '';
  for (const key of ['response_type', 'redirect_uri', 'client_id']) {
    if (url.searchParams.getAll(key).length !== 1) return '';
  }
  if (url.searchParams.get('response_type') !== 'code' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(url.searchParams.get('client_id') || '')) return '';
  if ([...url.searchParams.keys()].some(key => /^(?:access_token|refresh_token|id_token|code|password|client_secret)$/i.test(key))) return '';
  let redirect;
  try { redirect = new URL(url.searchParams.get('redirect_uri')); } catch { return ''; }
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ||
      !redirect.port || Number(redirect.port) < 1 || redirect.username || redirect.password ||
      redirect.pathname !== '/' || redirect.search || redirect.hash) return '';
  return url.href;
}

export function extractMicrosoftBrowserPrompt(output) {
  if (typeof output !== 'string') return null;
  for (const match of output.matchAll(/^SQLPULSE_BROWSER_URL:(https:\/\/[^\r\n]+)\r?\n/gm)) {
    const signInUrl = normalizeMicrosoftBrowserUrl(match[1]);
    if (signInUrl) return { signInUrl };
  }
  return null;
}

export function normalizeMicrosoftDeviceUri(value) {
  if (typeof value !== 'string') return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.username || url.password || url.search || url.hash) return '';
  const normalized = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  return trustedAddresses.has(normalized) ? normalized : '';
}

export function extractMicrosoftDevicePrompt(output) {
  if (typeof output !== 'string') return null;
  const plain = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ');
  const match = /open the page\s+(https:\/\/\S+)\s+and enter the code\s+([a-z0-9]{8,16}|[a-z0-9]{4}-[a-z0-9]{4})\s+to authenticate\b/i.exec(plain);
  if (!match) return null;
  const verificationUri = normalizeMicrosoftDeviceUri(match[1]);
  return verificationUri ? { deviceCode: match[2], verificationUri } : null;
}
