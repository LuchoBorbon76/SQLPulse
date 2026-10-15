import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const executables = { node: ['node.exe'], sqlcmd: ['sqlcmd.exe'], gh: ['gh.exe'], az: ['az.cmd', 'az.exe'] };
const packageIds = { node: 'OpenJS.NodeJS.LTS', sqlcmd: 'Microsoft.Sqlcmd', gh: 'GitHub.cli', az: 'Microsoft.AzureCLI' };

export function supportedToolVersion(name, output) {
  const text = String(output).trim();
  let match;
  if (name === 'node') {
    match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
  }
  if (name === 'sqlcmd') {
    match = /^\s*(?:(?:sqlcmd|Version):\s*)?v(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?\s*$/im.exec(text);
    return !!match && (+match[1] > 1 || (+match[1] === 1 && +match[2] >= 10));
  }
  return name === 'gh' ? /^gh version \d+\.\d+\.\d+/m.test(text)
    : name === 'az' && /^azure-cli\s+\d+\.\d+\.\d+/m.test(text);
}

function versionOutput(file) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] };
  if (/\.cmd$/i.test(file)) {
    if (/["%\r\n]/.test(file)) throw new Error('Unsupported CLI path');
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}" --version"`],
      { ...options, windowsVerbatimArguments: true, timeout: 15000 });
  }
  return execFileSync(file, ['--version'], options);
}

export function resolveToolPath(name, {
  env = process.env, exists = existsSync, probe = versionOutput,
  verify, manifestFile = path.join(directory, '.sql-pulse-tools.json'), read = readFileSync, list = readdirSync,
} = {}) {
  if (!executables[name]) throw new Error(`Unknown tool: ${name}`);
  let manifest = {};
  try { manifest = JSON.parse(String(read(manifestFile, 'utf8')).replace(/^\uFEFF/, '')); } catch {}
  const candidates = typeof manifest[name] === 'string' ? [manifest[name]] : [];
  const paths = (env.Path || env.PATH || '').split(';').map(value => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const entry of paths) for (const exe of executables[name]) candidates.push(path.win32.join(entry, exe));
  for (const base of [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
    const relatives = {
      node: ['nodejs\\node.exe'], sqlcmd: ['SqlCmd\\sqlcmd.exe'], gh: ['GitHub CLI\\gh.exe'],
      az: ['Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd', 'Azure CLI\\wbin\\az.cmd'],
    };
    for (const relative of relatives[name]) candidates.push(path.win32.join(base, relative));
  }
  if (env.LOCALAPPDATA) {
    const winget = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    for (const exe of executables[name]) candidates.push(path.win32.join(winget, 'Links', exe));
    const packages = path.win32.join(winget, 'Packages');
    try {
      const folders = list(packages, { withFileTypes: true });
      for (const folder of folders) {
        if (!folder.isDirectory() || !folder.name.toLowerCase().startsWith(packageIds[name].toLowerCase() + '_')) continue;
        const walk = (base, depth) => {
          if (depth > 4) return;
          for (const entry of list(base, { withFileTypes: true })) {
            const file = path.win32.join(base, entry.name);
            if (entry.isDirectory()) walk(file, depth + 1);
            else if (executables[name].some(exe => exe.toLowerCase() === entry.name.toLowerCase())) candidates.push(file);
          }
        };
        walk(path.win32.join(packages, folder.name), 0);
      }
    } catch {}
    // The common portable location is also useful when directory enumeration is restricted.
    for (const exe of executables[name]) candidates.push(path.win32.join(packages, `${packageIds[name]}_Microsoft.Winget.Source_8wekyb3d8bbwe`, exe));
  }
  const seen = new Set();
  for (const file of candidates) {
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!exists(file)) continue;
    try {
      if (verify ? verify(file) : supportedToolVersion(name, probe(file))) return file;
    } catch {}
  }
  return null;
}
