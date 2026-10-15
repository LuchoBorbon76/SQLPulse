import test from 'node:test';
import assert from 'node:assert/strict';
import { copySignInCode } from '../copy-signin-code.js';

test('copies the displayed code to the clipboard exactly', async () => {
  const copied = [];
  await copySignInCode('TEST12345', { clipboard: { writeText: async text => copied.push(text) } });
  await copySignInCode('ABCD-1234', { clipboard: { writeText: async text => copied.push(text) } });
  assert.deepEqual(copied, ['TEST12345', 'ABCD-1234']);
});

test('clipboard denial falls back to selected text and restores focus', async () => {
  const record = [];
  const temporary = { style: {}, setAttribute() {}, focus() { record.push('focus'); }, select() { record.push('select'); }, remove() { record.push('remove'); } };
  const doc = {
    createElement: () => temporary,
    activeElement: { focus() { record.push('restore'); } },
    body: { append() { record.push('append'); } },
    execCommand(command) { assert.equal(command, 'copy'); return true; },
  };
  await copySignInCode('ABCD-EFGH', { clipboard: { writeText: async () => { throw new Error('Denied'); } }, document: doc });
  assert.equal(temporary.value, 'ABCD-EFGH');
  assert.deepEqual(record, ['append', 'focus', 'select', 'remove', 'restore']);
});

test('unavailable copy support gives manual-copy instructions and never claims success', async () => {
  const doc = {
    createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, remove() {} }),
    body: { append() {} }, execCommand: () => false,
  };
  await assert.rejects(copySignInCode('TEST12345', { clipboard: null, document: doc }), /Ctrl\+C/);
  await assert.rejects(copySignInCode(''), /No valid/);
  await assert.rejects(copySignInCode('not a code'), /No valid/);
});
