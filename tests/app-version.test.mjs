import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('About and sidebar display the validated package version instead of hard-coded releases', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.equal((html.match(/\{\{SQL_PULSE_VERSION\}\}/g) || []).length, 2);
  assert.doesNotMatch(html, /SQL Pulse · v1\.4\.4/);
  const start = source.indexOf("      const { version } = JSON.parse");
  const end = source.indexOf('\n      return;', start);
  const body = source.slice(start, end);
  for (const version of ['1.5.2', '2.0.0-beta.1', '<script>']) {
    let rendered;
    const context = {
      readFile: async file => file === 'package.json' ? JSON.stringify({ version }) : html,
      path: { join: (...parts) => parts.at(-1) }, __dirname: '.', HTML: 'index.html',
      res: { writeHead() {}, end: value => { rendered = value; } },
    };
    const result = vm.runInNewContext(`(async () => { ${body} })()`, context);
    if (version === '<script>') await assert.rejects(result, /version is invalid/);
    else {
      await result;
      assert.equal(rendered.includes('{{SQL_PULSE_VERSION}}'), false);
      assert.ok(rendered.includes(`SQL Pulse · v${version}`));
      assert.ok(rendered.includes(`© 2026 · v${version}`));
    }
  }
});
