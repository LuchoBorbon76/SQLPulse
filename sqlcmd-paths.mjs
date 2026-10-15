import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveToolPath } from './tool-paths.mjs';

export function sqlcmdPaths({ env = process.env, exists = existsSync, verifyGo, ...options } = {}) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const odbcCandidates = ['170', '180', '190'].map(version =>
    path.win32.join(programFiles, 'Microsoft SQL Server', 'Client SDK', 'ODBC', version, 'Tools', 'Binn', 'SQLCMD.EXE'));
  return {
    odbc: odbcCandidates.find(exists) || odbcCandidates[0],
    go: resolveToolPath('sqlcmd', { ...options, env, exists, verify: verifyGo }) ||
      path.win32.join(programFiles, 'SqlCmd', '.sql-pulse-supported-sqlcmd-not-found.exe'),
  };
}
