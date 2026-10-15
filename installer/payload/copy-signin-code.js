export async function copySignInCode(code, {
  clipboard = globalThis.navigator?.clipboard,
  document: doc = globalThis.document,
} = {}) {
  if (typeof code !== 'string' || !/^(?:[A-Z0-9]{8,16}|[A-Z0-9]{4}-[A-Z0-9]{4})$/i.test(code)) {
    throw new Error('No valid sign-in code is available to copy.');
  }
  let clipboardError;
  if (clipboard?.writeText) {
    try { await clipboard.writeText(code); return; }
    catch (error) { clipboardError = error; }
  }
  const temporary = doc.createElement('textarea');
  temporary.value = code;
  temporary.setAttribute('readonly', '');
  temporary.style.position = 'fixed';
  temporary.style.left = '-10000px';
  doc.body.append(temporary);
  const previousFocus = doc.activeElement;
  try {
    temporary.focus();
    temporary.select();
    if (!doc.execCommand?.('copy')) {
      throw new Error('Clipboard access was blocked. Select the displayed code and press Ctrl+C.');
    }
  } catch (error) {
    if (error.message.includes('Clipboard access was blocked')) throw error;
    throw new Error('The code could not be copied. Select it and press Ctrl+C.', { cause: clipboardError || error });
  } finally {
    temporary.remove();
    previousFocus?.focus();
  }
}
