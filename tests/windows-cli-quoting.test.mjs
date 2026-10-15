import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveToolPath } from '../tool-paths.mjs';
import { azureCliCommand } from '../azure-sql-auth.mjs';
const run = promisify(execFile);

test('real Windows batch dispatch preserves a verified CLI path containing spaces', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pulse-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'Azure CLI fixture');
  await mkdir(folder);
  const cli = path.join(folder, 'az.cmd'), manifestFile = path.join(dir, 'tools.json');
  await writeFile(cli, '@echo off\r\nif "%~1"=="--version" (\r\n  echo azure-cli 2.90.0\r\n  exit /b 0\r\n)\r\necho {"argument":"%~1","format":"%~4"}\r\n');
  await writeFile(manifestFile, JSON.stringify({ az: cli }));
  assert.equal(resolveToolPath('az', { manifestFile, env: { PATH: '' }, list: () => [] }), cli);
  const command = azureCliCommand(['account', 'show', '--output', 'json'], 'win32', cli);
  const result = await run(command.executable, command.args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { argument: 'account', format: 'json' });
  for (const value of ['C:\\bad%PATH%\\az.cmd', 'C:\\bad&path\\az.cmd', 'C:\\bad"path\\az.cmd']) {
    assert.throws(() => azureCliCommand(['account', 'show'], 'win32', value), /Unsafe Azure CLI executable path/);
  }
});
