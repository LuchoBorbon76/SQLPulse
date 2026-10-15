import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function isGoSqlcmd(file) {
  try {
    const output = execFileSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000,
      maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    return /Install\/Create\/Query SQL Server/.test(output) && /Version:\s*v?\d+\.\d+/.test(output);
  } catch { return false; }
}

export function sqlcmdPaths({ env = process.env, exists = existsSync, verifyGo = isGoSqlcmd } = {}) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const odbcCandidates = ['170', '180', '190'].map(version =>
    path.win32.join(programFiles, 'Microsoft SQL Server', 'Client SDK', 'ODBC', version, 'Tools', 'Binn', 'SQLCMD.EXE'));
  const goCandidates = [path.win32.join(programFiles, 'SqlCmd', 'sqlcmd.exe')];
  if (env.LOCALAPPDATA) {
    goCandidates.push(
      path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'sqlcmd.exe'),
      path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', 'Microsoft.Sqlcmd_Microsoft.Winget.Source_8wekyb3d8bbwe', 'sqlcmd.exe'),
    );
  }
  const searchPath = env.Path || env.PATH || '';
  const pathDirectories = searchPath.split(';').map(directory => directory.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const directory of pathDirectories.filter(directory => /(?:^|\\)(?:SqlCmd|Microsoft\.Sqlcmd_[^\\]*)$/i.test(directory))) {
    goCandidates.push(path.win32.join(directory, 'sqlcmd.exe'));
  }
  return {
    odbc: odbcCandidates.find(exists) || odbcCandidates[0],
    go: goCandidates.find(exists) || pathDirectories.map(directory => path.win32.join(directory, 'sqlcmd.exe'))
      .find(file => exists(file) && verifyGo(file)) || goCandidates[0],
  };
}
