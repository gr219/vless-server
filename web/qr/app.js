// QR page behaviour: live-parses the textarea into one table row per VLESS
// URI and keeps each row's QR code in step with the server and label chosen.
(function () {
  'use strict';

  const {
    TARGETS, splitUris, parseVlessUri, buildVlessUri, normalizeAuthority, toFileName,
  } = window.Vless;

  /** Dropdown value that reveals the free-form address field. */
  const CUSTOM_TARGET = 'custom';
  const THEME_KEY = 'qr-theme';
  const DEFAULT_HINT = 'Replaces host:port of every URI.';

  /** Pixels per QR module and quiet-zone width, in modules. */
  const MODULE_SIZE = 6;
  const QUIET_MODULES = 4;
  const CAPTION_HEIGHT = 36;

  /** Printed above every QR code, so a saved or shared image says where it came from. */
  const QR_HEADER = 'https://data.std.io.vn';
  const HEADER_HEIGHT = 36;

  const urisInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('uris'));
  const targetSelect = /** @type {HTMLSelectElement} */ (document.getElementById('target'));
  const rowsBody = /** @type {HTMLTableSectionElement} */ (document.getElementById('rows'));
  const emptyRow = /** @type {HTMLTableRowElement} */ (document.getElementById('empty-row'));
  const countText = /** @type {HTMLElement} */ (document.getElementById('count'));
  const toast = /** @type {HTMLElement} */ (document.getElementById('toast'));
  const customWrap = /** @type {HTMLElement} */ (document.getElementById('custom-wrap'));
  const customInput = /** @type {HTMLInputElement} */ (document.getElementById('custom-target'));
  const targetHint = /** @type {HTMLElement} */ (document.getElementById('target-hint'));
  const themeToggle = /** @type {HTMLButtonElement} */ (document.getElementById('theme-toggle'));

  /**
   * Labels the user typed, keyed by the URI they belong to, so editing one
   * line of the textarea does not reset the labels of the others.
   * @type {Map<string, string>}
   */
  const labelEdits = new Map();

  if (typeof window.qrcode !== 'function') {
    throw new Error('ERR_QR_LIBRARY_MISSING: qrcode-generator did not load.');
  }
  window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];

  for (const [value, target] of Object.entries(TARGETS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${target.name} (${target.authority})`;
    targetSelect.append(option);
  }
  const customOption = document.createElement('option');
  customOption.value = CUSTOM_TARGET;
  customOption.textContent = 'Custom…';
  targetSelect.append(customOption);

  themeToggle.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch (_) {
      // Storage blocked: the choice lasts for this page view only.
    }
  });

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let toastTimer = 0;
  /** @param {string} message */
  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove('opacity-0');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.add('opacity-0'), 2000);
  }

  /**
   * Reads the dropdown (and the custom field when chosen) and updates the hint
   * under it. An empty or invalid custom address keeps each URI's own.
   * @returns {string} The chosen host:port, or '' to keep each URI's own.
   */
  function selectedAuthority() {
    const isCustom = targetSelect.value === CUSTOM_TARGET;
    customWrap.classList.toggle('hidden', !isCustom);
    targetHint.classList.remove('text-rose-600', 'dark:text-rose-400');
    if (!isCustom) {
      targetHint.textContent = DEFAULT_HINT;
      const target = TARGETS[/** @type {keyof typeof TARGETS} */ (targetSelect.value)];
      return target ? target.authority : '';
    }
    if (customInput.value.trim() === '') {
      targetHint.textContent = 'Enter a host, host:port or URL. Port defaults to 443.';
      return '';
    }
    const result = normalizeAuthority(customInput.value);
    if (!result.ok) {
      targetHint.textContent = `${result.code}: ${result.message} Keeping original addresses.`;
      targetHint.classList.add('text-rose-600', 'dark:text-rose-400');
      return '';
    }
    targetHint.textContent = `Using ${result.authority}.`;
    return result.authority;
  }

  /**
   * Writes one line of centred text, cut with an ellipsis to fit `maxWidth`.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} x
   * @param {number} y
   * @param {number} maxWidth
   */
  function fillFittedText(ctx, text, x, y, maxWidth) {
    let shown = text;
    while (shown.length > 1 && ctx.measureText(shown).width > maxWidth) {
      shown = shown.slice(0, -1);
    }
    if (shown !== text) shown = shown.slice(0, -1) + '…';
    ctx.fillText(shown, x, y);
  }

  /**
   * Draws the QR code for `text` with QR_HEADER printed above it and `caption`
   * underneath, so a saved or copied image says where it came from and which
   * profile it is. The text sits partly in the quiet zone, which stays wider
   * than the 4 modules scanners need on the side of the finder patterns.
   * @param {HTMLCanvasElement} canvas
   * @param {string} text
   * @param {string} caption
   */
  function drawQr(canvas, text, caption) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount();
    const size = (modules + QUIET_MODULES * 2) * MODULE_SIZE;
    const captionHeight = caption ? CAPTION_HEIGHT : 0;
    canvas.width = size;
    canvas.height = HEADER_HEIGHT + size + captionHeight;

    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    const offset = QUIET_MODULES * MODULE_SIZE;
    const top = HEADER_HEIGHT + offset;
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(offset + col * MODULE_SIZE, top + row * MODULE_SIZE, MODULE_SIZE, MODULE_SIZE);
        }
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
    fillFittedText(ctx, QR_HEADER, size / 2, HEADER_HEIGHT / 2 + offset / 2, size - 16);
    if (caption) {
      ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
      fillFittedText(ctx, caption, size / 2, HEADER_HEIGHT + size - offset / 2 + captionHeight / 2, size - 16);
    }
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<Blob>}
   */
  function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('ERR_QR_ENCODE_FAILED: could not encode the QR image as PNG.'));
      }, 'image/png');
    });
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string} fileName
   */
  async function saveImage(canvas, fileName) {
    const blob = await canvasToPng(canvas);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Copies the QR image and the URI as one clipboard entry: image editors and
   * chat apps paste the picture, text fields paste the URI.
   * @param {HTMLCanvasElement} canvas
   * @param {string} uri
   */
  async function copyImageAndUri(canvas, uri) {
    if (!navigator.clipboard) {
      throw new Error('ERR_CLIPBOARD_UNAVAILABLE: the clipboard needs HTTPS or localhost.');
    }
    if (typeof ClipboardItem === 'function') {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            // A promise keeps Safari's user-gesture check satisfied.
            'image/png': canvasToPng(canvas),
            'text/plain': new Blob([uri], { type: 'text/plain' }),
          }),
        ]);
        showToast('Copied QR image and URI.');
        return;
      } catch (error) {
        console.warn('Copying the image failed; falling back to the URI only.', error);
      }
    }
    await navigator.clipboard.writeText(uri);
    showToast('Copied URI only: this browser cannot copy images.');
  }

  /**
   * @param {string} text
   * @param {() => Promise<void>} action
   * @returns {HTMLButtonElement}
   */
  function actionButton(text, action) {
    const button = /** @type {HTMLButtonElement} */ (el('button',
      'flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
      text));
    button.type = 'button';
    button.addEventListener('click', () => {
      action().catch((error) => {
        console.error(error);
        showToast(error instanceof Error ? error.message : String(error));
      });
    });
    return button;
  }

  /**
   * @param {import('./vless.js').ParseError} parsed
   * @param {number} index
   * @returns {HTMLTableRowElement}
   */
  function errorRow(parsed, index) {
    const tr = /** @type {HTMLTableRowElement} */ (el('tr', 'bg-rose-50 dark:bg-rose-950/40'));
    tr.append(el('td', 'px-3 py-3 align-top text-slate-400', String(index + 1)));
    const cell = el('td', 'px-3 py-3 align-top');
    cell.colSpan = 3;
    cell.append(
      el('p', 'font-medium text-rose-700 dark:text-rose-300', `${parsed.code}: ${parsed.message}`),
      el('p', 'mt-1 break-all font-mono text-xs text-slate-500', parsed.source),
    );
    tr.append(cell);
    return tr;
  }

  /**
   * @param {import('./vless.js').ParsedVless} parsed
   * @param {number} index
   * @param {string} authority
   * @returns {HTMLTableRowElement}
   */
  function uriRow(parsed, index, authority) {
    const tr = /** @type {HTMLTableRowElement} */ (el('tr', 'align-top'));
    tr.append(el('td', 'px-3 py-3 text-slate-400', String(index + 1)));

    const labelCell = el('td', 'px-3 py-3');
    const labelInput = /** @type {HTMLInputElement} */ (el('input',
      'block w-full rounded-md border border-slate-300 bg-white p-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-950'));
    labelInput.type = 'text';
    labelInput.placeholder = 'Label';
    labelInput.value = labelEdits.get(parsed.source) ?? parsed.label;
    labelInput.setAttribute('aria-label', `Label for URI ${index + 1}`);
    labelCell.append(labelInput);
    if (parsed.label) {
      labelCell.append(el('p', 'mt-1 text-xs text-slate-400', `Original: ${parsed.label}`));
    }

    const uriCell = el('td', 'px-3 py-3');
    const server = el('p', 'font-mono text-xs');
    if (authority && authority !== parsed.authority) {
      server.append(
        el('span', 'text-slate-400 line-through', parsed.authority),
        document.createTextNode(' → '),
        el('span', 'font-semibold text-indigo-600 dark:text-indigo-400', authority),
      );
    } else {
      server.append(el('span', 'font-semibold', parsed.authority));
    }
    const uriText = el('p', 'mt-2 break-all font-mono text-xs text-slate-600 dark:text-slate-300');
    uriCell.append(server, uriText);

    const qrCell = el('td', 'px-3 py-3');
    const canvas = /** @type {HTMLCanvasElement} */ (el('canvas', 'block w-48 rounded border border-slate-200 bg-white dark:border-slate-700'));
    const buttons = el('div', 'mt-2 flex w-48 gap-2');
    qrCell.append(canvas, buttons);

    let currentUri = '';
    let currentLabel = '';
    const refresh = () => {
      currentLabel = labelInput.value;
      currentUri = buildVlessUri(parsed, { authority, label: currentLabel, tls: true });
      uriText.textContent = currentUri;
      drawQr(canvas, currentUri, currentLabel);
      canvas.setAttribute('aria-label', `QR code for ${currentLabel || `URI ${index + 1}`}`);
    };
    labelInput.addEventListener('input', () => {
      labelEdits.set(parsed.source, labelInput.value);
      refresh();
    });
    buttons.append(
      actionButton('Save image', () => saveImage(canvas, toFileName(currentLabel))),
      actionButton('Copy', () => copyImageAndUri(canvas, currentUri)),
    );
    refresh();

    tr.append(labelCell, uriCell, qrCell);
    return tr;
  }

  function render() {
    const sources = splitUris(urisInput.value);
    const authority = selectedAuthority();
    const parsedList = sources.map(parseVlessUri);
    const rows = parsedList.map((parsed, index) =>
      parsed.ok ? uriRow(parsed, index, authority) : errorRow(parsed, index));
    const invalid = parsedList.filter((parsed) => !parsed.ok).length;

    // Forget labels for URIs that are no longer in the textarea.
    const present = new Set(sources);
    for (const source of labelEdits.keys()) {
      if (!present.has(source)) labelEdits.delete(source);
    }

    rowsBody.replaceChildren(...(rows.length ? rows : [emptyRow]));
    countText.textContent = sources.length === 0
      ? 'No URIs yet.'
      : `${sources.length - invalid} valid` + (invalid ? `, ${invalid} invalid` : '') + '.';
  }

  urisInput.addEventListener('input', render);
  targetSelect.addEventListener('change', () => {
    render();
    if (targetSelect.value === CUSTOM_TARGET) customInput.focus();
  });
  customInput.addEventListener('input', render);
  render();
})();
