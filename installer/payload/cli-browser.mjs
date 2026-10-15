import { fileURLToPath } from 'node:url';
import { BROWSER_URL_PREFIX, normalizeMicrosoftBrowserUrl } from './microsoft-device-signin.js';

export function cliBrowserCommand(nodePath = process.execPath, helperPath = fileURLToPath(import.meta.url)) {
  if ([nodePath, helperPath].some(value => typeof value !== 'string' || !value || /["%;\r\n\0]/.test(value))) {
    throw new Error('Invalid Microsoft browser helper path');
  }
  // Python webbrowser uses shlex, not cmd.exe; quote paths and the single URL argument.
  return `"${nodePath}" "${helperPath}" "%s"`;
}

export async function openCliBrowser(value, {
  publish = text => process.stdout.write(text),
} = {}) {
  const signInUrl = normalizeMicrosoftBrowserUrl(value);
  if (!signInUrl) throw new Error('Invalid Microsoft authorization URL');
  // The UI reserves the foreground tab from the user's click and opens this URL.
  // Do not launch a second browser window from the hidden CLI process.
  publish(`${BROWSER_URL_PREFIX}${signInUrl}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  openCliBrowser(process.argv[2]).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
