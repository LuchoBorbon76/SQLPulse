import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlcmdPaths } from '../sqlcmd-paths.mjs';

test('SQL CLI detection supports per-user winget installation without a refreshed PATH', () => {
  const installed = 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Microsoft.Sqlcmd_Microsoft.Winget.Source_8wekyb3d8bbwe\\sqlcmd.exe';
  const paths = sqlcmdPaths({ env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, exists: file => file === installed });
  assert.equal(paths.go, installed);
});

test('SQL CLI detection retains machine-installed go-sqlcmd and falls back to available ODBC SDK', () => {
  const odbc = 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE';
  const go = 'C:\\Program Files\\SqlCmd\\sqlcmd.exe';
  const paths = sqlcmdPaths({ env: {}, exists: file => [odbc, go].includes(file) });
  assert.equal(paths.odbc, odbc);
  assert.equal(paths.go, go);
});

test('PATH lookup for go-sqlcmd does not accidentally select an ODBC executable', () => {
  const go = 'D:\\Tools\\SqlCmd\\sqlcmd.exe';
  const paths = sqlcmdPaths({
    env: { Path: 'D:\\SDK\\ODBC;D:\\Tools\\SqlCmd' },
    exists: file => file === go || file === 'D:\\SDK\\ODBC\\sqlcmd.exe',
  });

  test('Go sqlcmd in a custom PATH directory is verified rather than mistaken for ODBC', () => {
    const go = 'D:\\CustomTools\\sqlcmd.exe', odbc = 'D:\\SDK\\sqlcmd.exe', probes = [];
    const paths = sqlcmdPaths({
      env: { Path: 'D:\\SDK;D:\\CustomTools' }, exists: file => [go, odbc].includes(file),
      verifyGo: file => { probes.push(file); return file === go; },
    });
    assert.equal(paths.go, go);
    assert.deepEqual(probes, [odbc, go]);
  });
  assert.equal(paths.go, go);
});
