// Teensy Web Controller
import { idbGet, idbSet, lsGet, lsSet } from './store.js';
import { parseIntelHex, TEENSY41 } from './hex.js';
import { findHalfKay, requestHalfKay, detectModel, flashHalfKay } from './halfkay.js';
import { SerialManager, TEENSY_VID } from './serial.js';
import { Monitor } from './monitor.js';
import { h, hex4, formatBytes, formatDateTime, formatFileStamp } from './util.js';

const CONFIG_FILE = 'teensy_web.json';
const ROOT_KEY = 'rootHandle';
const LAST_KEY = 'teensy_web.lastWritten';
const PREFS_KEY = 'teensy_web.prefs';
const HISTORY_KEY = 'teensy_web.history';
const HISTORY_MAX = 50;

const $ = (selector) => document.querySelector(selector);

const support = {
  fs: 'showDirectoryPicker' in window,
  serial: 'serial' in navigator,
  hid: 'hid' in navigator,
};

const state = {
  root: null, // 選択中のルートフォルダ
  pendingRoot: null, // 前回のフォルダ（アクセスの許可待ち）
  config: emptyConfig(),
  loadError: null,
  dirty: false,
  editMode: false,
  flashingId: null,
  hexInfo: new Map(), // programId -> { ok, lastModified, size, error }
  status: new Map(), // programId -> { text, kind, value, max }
  lastWritten: lsGet(LAST_KEY, null), // PC（ブラウザ）ごとの記録。JSON には書き出さない
  ports: [],
};

let serial = null;
let monitor = null;
let lastSerialStatus = 'disconnected';

class CancelError extends Error {
  constructor() {
    super('キャンセルしました');
    this.name = 'CancelError';
  }
}

function emptyConfig() {
  return { version: 1, programs: [] };
}

const uuid = () => crypto.randomUUID();
const findProgram = (id) => state.config.programs.find((p) => p.id === id);
const programLabel = (p) => p.name || p.hexPath;

// ---------------------------------------------------------------- 初期化

function init() {
  monitor = new Monitor($('#monitor'), $('#jumpLatest'));
  bindTopbar();
  bindSerialPanel();
  observeTopbar();

  const missing = [];
  if (!support.fs) missing.push('フォルダの読み書き');
  if (!support.serial) missing.push('シリアル通信');
  if (!support.hid) missing.push('Teensy への書き込み');
  if (missing.length) {
    showNotice(`このブラウザでは ${missing.join('・')} が使えません。Microsoft Edge（最新版）で開いてください。`, 'error', 'support');
  }

  if (support.serial) {
    serial = new SerialManager();
    serial.addEventListener('data', (e) => monitor.appendReceived(e.detail));
    serial.addEventListener('status', onSerialStatus);
    serial.addEventListener('ports', refreshPorts);
    serial.addEventListener('lost', () => monitor.info('シリアル接続が切れました。再接続を待っています…'));
    refreshPorts();
  }

  updateSerialUi();
  updateLastWrittenUi();
  renderFolderUi();
  renderPrograms();
  if (support.fs) restoreRoot();

  // Arduino IDE で .hex を出し直して戻ってきたときに更新日時を反映する
  window.addEventListener('focus', refreshHexInfo);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.flashingId) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function bindTopbar() {
  $('#btnFolder').disabled = !support.fs;
  $('#btnFolder').addEventListener('click', chooseFolder);
  $('#btnAddPort').addEventListener('click', addPort);
  $('#btnConnect').addEventListener('click', connectSelected);
  $('#btnDisconnect').addEventListener('click', disconnectSerial);
  $('#btnEdit').addEventListener('click', () => setEditMode(!state.editMode));
}

// トップバーの高さ（折り返しで変わる）をシリアル欄の追従位置に使う
function observeTopbar() {
  const bar = $('#topbar');
  const update = () => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  new ResizeObserver(update).observe(bar);
  update();
}

// ---------------------------------------------------------------- フォルダと設定ファイル

async function chooseFolder() {
  if (state.flashingId) return;
  if (state.dirty && !confirm('保存していない変更があります。破棄して別のフォルダを開きますか？')) return;
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'teensy-web-root', mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') toast(`フォルダを開けませんでした: ${e.message}`, 'error');
    return;
  }
  if (await openRoot(handle)) {
    try {
      await idbSet(ROOT_KEY, handle);
    } catch {
      // 次回の自動読み込みができないだけ
    }
  }
}

async function restoreRoot() {
  let handle = null;
  try {
    handle = await idbGet(ROOT_KEY);
  } catch {
    return;
  }
  if (!handle) return;
  let permission = 'prompt';
  try {
    permission = await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    // 無視して許可を求める
  }
  if (permission === 'granted' && (await openRoot(handle, { quiet: true }))) return;
  state.pendingRoot = handle;
  renderPrograms();
}

async function reopenPendingRoot() {
  const handle = state.pendingRoot;
  if (!handle) return;
  try {
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
  } catch (e) {
    toast(`フォルダを開けませんでした: ${e.message}`, 'error');
    return;
  }
  await openRoot(handle);
}

async function openRoot(handle, { quiet = false } = {}) {
  try {
    // フォルダが移動・削除されていないか確認する
    for await (const _ of handle.keys()) break;
  } catch {
    if (!quiet) toast(`フォルダ「${handle.name}」を開けませんでした（移動または削除された可能性があります）`, 'error');
    return false;
  }
  state.root = handle;
  state.pendingRoot = null;
  state.editMode = false;
  state.dirty = false;
  state.hexInfo.clear();
  state.status.clear();
  await loadConfig();
  renderFolderUi();
  renderPrograms();
  updateLastWrittenUi();
  refreshHexInfo();
  return true;
}

async function loadConfig() {
  state.loadError = null;
  hideNotice('config');
  let text;
  try {
    const file = await (await state.root.getFileHandle(CONFIG_FILE)).getFile();
    text = await file.text();
  } catch (e) {
    state.config = emptyConfig();
    if (e.name !== 'NotFoundError') setLoadError(e.message);
    return;
  }
  try {
    state.config = normalizeConfig(JSON.parse(text));
  } catch (e) {
    state.config = emptyConfig();
    setLoadError(e.message);
  }
}

function setLoadError(message) {
  state.loadError = message;
  showNotice(`${CONFIG_FILE} を読み込めませんでした（${message}）。ファイルの中身を確認してください。このまま保存すると上書きされます。`, 'error', 'config');
}

function normalizeConfig(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.programs)) {
    throw new Error('programs の一覧がありません');
  }
  const str = (v) => (typeof v === 'string' ? v : '');
  const isObject = (v) => v && typeof v === 'object';
  return {
    version: 1,
    programs: data.programs.filter(isObject).map((p) => ({
      id: str(p.id) || uuid(),
      name: str(p.name),
      hexPath: str(p.hexPath),
      description: str(p.description),
      commands: (Array.isArray(p.commands) ? p.commands : []).filter(isObject).map((c) => ({
        id: str(c.id) || uuid(),
        command: str(c.command),
        description: str(c.description),
      })),
    })),
  };
}

// 保存前の整理: 前後の空白を取り、コマンド名が空のボタンは消す
function tidyConfig() {
  for (const p of state.config.programs) {
    p.name = p.name.trim();
    for (const c of p.commands) c.command = c.command.trim();
    p.commands = p.commands.filter((c) => c.command);
  }
}

async function saveConfig() {
  if (!state.root) return false;
  if (state.loadError && !confirm(`${CONFIG_FILE} は読み込みに失敗したままです。上書き保存しますか？`)) return false;
  tidyConfig();
  const text = `${JSON.stringify(state.config, null, 2)}\n`;
  try {
    if ((await state.root.queryPermission({ mode: 'readwrite' })) !== 'granted'
      && (await state.root.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('フォルダへの書き込みが許可されていません');
    }
    const file = await state.root.getFileHandle(CONFIG_FILE, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (e) {
    toast(`保存できませんでした: ${e.message}`, 'error');
    return false;
  }
  state.dirty = false;
  state.loadError = null;
  hideNotice('config');
  toast(`${CONFIG_FILE} に保存しました`);
  return true;
}

function markDirty() {
  state.dirty = true;
}

async function getFileByPath(root, path) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) throw new DOMException('パスが空です', 'NotFoundError');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return dir.getFileHandle(parts.at(-1));
}

async function refreshHexInfo() {
  const root = state.root;
  if (!root) return;
  await Promise.all(state.config.programs.map(async (p) => {
    let info;
    try {
      const file = await (await getFileByPath(root, p.hexPath)).getFile();
      info = { ok: true, lastModified: file.lastModified, size: file.size };
    } catch (e) {
      const missing = e.name === 'NotFoundError' || e.name === 'TypeError';
      info = { ok: false, error: missing ? '.hex が見つかりません' : e.message };
    }
    if (state.root === root) state.hexInfo.set(p.id, info);
  }));
  updateHexInfoViews();
}

// ---------------------------------------------------------------- プログラムの登録・編集

// .hex を選ばせて、ルートフォルダからの相対パス（配列）を返す
async function pickHexPath() {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      startIn: state.root,
      excludeAcceptAllOption: true,
      types: [{ description: 'Teensy の HEX ファイル', accept: { 'application/octet-stream': ['.hex'] } }],
    });
  } catch (e) {
    if (e.name !== 'AbortError') toast(`ファイルを選択できませんでした: ${e.message}`, 'error');
    return null;
  }
  const parts = await state.root.resolve(handle);
  if (!parts) {
    toast(`選択した .hex はフォルダ「${state.root.name}」の中にありません。このフォルダ内の .hex を選んでください。`, 'error');
    return null;
  }
  return parts;
}

async function addProgram() {
  if (!state.root || state.flashingId) return;
  const parts = await pickHexPath();
  if (!parts) return;
  const hexPath = parts.join('/');
  const dup = state.config.programs.find((p) => p.hexPath === hexPath);
  if (dup && !confirm(`この .hex は「${programLabel(dup)}」として登録済みです。もう 1 つ追加しますか？`)) return;
  // 名前の初期値はプロジェクトフォルダ名（ルート直下の .hex ならファイル名）
  const name = parts.length > 1 ? parts[0] : parts[0].replace(/(\.ino)?\.hex$/i, '');
  const program = { id: uuid(), name, hexPath, description: '', commands: [] };
  state.config.programs.push(program);
  markDirty();
  // 続けて説明やコマンドを入力できるように編集モードにする
  state.editMode = true;
  updateEditUi();
  renderPrograms();
  refreshHexInfo();
  const el = document.querySelector(`.program[data-id="${CSS.escape(program.id)}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.querySelector('textarea')?.focus({ preventScroll: true });
}

async function changeHex(id) {
  const p = findProgram(id);
  if (!p) return;
  const parts = await pickHexPath();
  if (!parts) return;
  p.hexPath = parts.join('/');
  state.hexInfo.delete(id);
  markDirty();
  updateHexInfoViews();
  refreshHexInfo();
}

function deleteProgram(id) {
  const p = findProgram(id);
  if (!p) return;
  if (!confirm(`「${programLabel(p)}」を一覧から削除しますか？\n.hex などのファイルは削除されません。`)) return;
  state.config.programs = state.config.programs.filter((x) => x.id !== id);
  state.hexInfo.delete(id);
  state.status.delete(id);
  markDirty();
  renderPrograms();
}

function moveItem(list, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  [list[index], list[target]] = [list[target], list[index]];
  return true;
}

function moveProgram(index, delta) {
  if (!moveItem(state.config.programs, index, delta)) return;
  markDirty();
  renderPrograms();
}

function addCommand(programId) {
  const p = findProgram(programId);
  if (!p) return;
  const c = { id: uuid(), command: '', description: '' };
  p.commands.push(c);
  markDirty();
  renderPrograms();
  document.querySelector(`[data-cmd-id="${CSS.escape(c.id)}"] input`)?.focus();
}

function moveCommand(programId, index, delta) {
  const p = findProgram(programId);
  if (!p || !moveItem(p.commands, index, delta)) return;
  markDirty();
  renderPrograms();
}

function deleteCommand(programId, commandId) {
  const p = findProgram(programId);
  if (!p) return;
  p.commands = p.commands.filter((c) => c.id !== commandId);
  markDirty();
  renderPrograms();
}

async function setEditMode(on) {
  if (on === state.editMode || state.flashingId || !state.root) return;
  if (!on && state.dirty && !(await saveConfig())) return;
  state.editMode = on;
  updateEditUi();
  renderPrograms();
}

function updateEditUi() {
  const btn = $('#btnEdit');
  btn.textContent = state.editMode ? '編集を終了して保存' : '編集モード';
  btn.setAttribute('aria-pressed', String(state.editMode));
  btn.disabled = !state.root || !!state.flashingId;
  document.body.classList.toggle('is-editing', state.editMode);
}

// ---------------------------------------------------------------- 描画

function renderFolderUi() {
  const name = $('#folderName');
  name.textContent = state.root ? state.root.name : '未選択';
  name.title = state.root ? `ルートフォルダ: ${state.root.name}` : '';
  updateEditUi();
}

function renderPrograms() {
  const list = $('#programList');
  if (!state.root) {
    list.replaceChildren(renderNoFolder());
    return;
  }
  const programs = state.config.programs;
  const items = programs.map((p, i) => (state.editMode ? renderProgramEdit(p, i, programs.length) : renderProgramView(p)));
  if (!programs.length) {
    items.push(h('div', { class: 'empty' },
      h('h2', null, 'まだプログラムが登録されていません'),
      h('p', { class: 'muted' }, '「＋ プログラムを追加」を押して、プロジェクトフォルダ内の .hex ファイルを選んでください。')));
  }
  items.push(h('button', { class: 'btn add-program', type: 'button', disabled: !!state.flashingId, onclick: addProgram },
    '＋ プログラムを追加（.hex を選択）'));
  list.replaceChildren(...items);
}

function renderNoFolder() {
  const pending = state.pendingRoot;
  return h('div', { class: 'empty' },
    h('h2', null, 'プログラムのフォルダを選んでください'),
    h('p', { class: 'muted' },
      'プロジェクトフォルダ（.ino と .hex を入れたフォルダ）が並んでいる親フォルダを選びます。',
      h('br'),
      `設定はそのフォルダの ${CONFIG_FILE} に保存されます。`),
    h('div', { class: 'empty-actions' },
      pending ? h('button', { class: 'btn primary', type: 'button', onclick: reopenPendingRoot }, `前回のフォルダ「${pending.name}」を開く`) : null,
      h('button', { class: pending ? 'btn' : 'btn primary', type: 'button', disabled: !support.fs, onclick: chooseFolder }, 'フォルダを選択')));
}

function renderProgramView(p) {
  const busy = !!state.flashingId;
  return h('article', { class: 'program', dataset: { id: p.id } },
    h('div', { class: 'p-main' },
      h('h2', { class: 'p-name' }, p.name || '（名前なし）'),
      hexInfoView(p, false),
      h('button', { class: 'btn primary btn-write', type: 'button', disabled: busy || !support.hid, onclick: () => writeProgram(p.id) }, '書き込み'),
      statusView(p.id)),
    h('div', { class: `p-desc${p.description ? '' : ' is-empty'}` },
      p.description || '説明はまだありません。編集モードで入力できます。'),
    h('div', { class: 'p-cmds' },
      p.commands.length
        ? p.commands.map((c) => h('div', { class: 'cmd' },
          h('button', { class: 'btn btn-cmd', type: 'button', title: `"${c.command}" を送信`, onclick: () => sendProgramCommand(p.id, c.id) }, c.command),
          c.description ? h('div', { class: 'cmd-desc' }, c.description) : null))
        : h('p', { class: 'muted small' }, 'コマンドボタンはありません')));
}

function renderProgramEdit(p, index, total) {
  return h('article', { class: 'program is-editing', dataset: { id: p.id } },
    h('div', { class: 'p-main' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, 'プログラム名'),
        h('input', { class: 'input', type: 'text', value: p.name, oninput: (e) => { p.name = e.target.value; markDirty(); } })),
      hexInfoView(p, true),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn icon', type: 'button', title: '上へ移動', 'aria-label': '上へ移動', disabled: index === 0, onclick: () => moveProgram(index, -1) }, '▲'),
        h('button', { class: 'btn icon', type: 'button', title: '下へ移動', 'aria-label': '下へ移動', disabled: index === total - 1, onclick: () => moveProgram(index, 1) }, '▼'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteProgram(p.id) }, '削除'))),
    h('label', { class: 'p-desc field' },
      h('span', { class: 'field-label' }, '説明'),
      h('textarea', { class: 'input', rows: 6, value: p.description, placeholder: 'プログラムの説明', oninput: (e) => { p.description = e.target.value; markDirty(); } })),
    h('div', { class: 'p-cmds' },
      h('span', { class: 'field-label' }, 'コマンドボタン'),
      h('div', { class: 'cmd-edit-list' }, p.commands.map((c, i) => renderCommandEdit(p, c, i))),
      h('button', { class: 'btn small', type: 'button', onclick: () => addCommand(p.id) }, '＋ コマンド追加')));
}

function renderCommandEdit(p, c, index) {
  return h('div', { class: 'cmd-edit', dataset: { cmdId: c.id } },
    h('input', { class: 'input mono', type: 'text', value: c.command, placeholder: 'コマンド（例: start）', 'aria-label': 'コマンド', oninput: (e) => { c.command = e.target.value; markDirty(); } }),
    h('input', { class: 'input', type: 'text', value: c.description, placeholder: '説明（例: 開始）', 'aria-label': 'コマンドの説明', oninput: (e) => { c.description = e.target.value; markDirty(); } }),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn icon', type: 'button', title: '上へ移動', 'aria-label': '上へ移動', disabled: index === 0, onclick: () => moveCommand(p.id, index, -1) }, '▲'),
      h('button', { class: 'btn icon', type: 'button', title: '下へ移動', 'aria-label': '下へ移動', disabled: index === p.commands.length - 1, onclick: () => moveCommand(p.id, index, 1) }, '▼'),
      h('button', { class: 'btn icon danger', type: 'button', title: 'このボタンを削除', 'aria-label': 'このボタンを削除', onclick: () => deleteCommand(p.id, c.id) }, '✕')));
}

function hexInfoView(p, editable) {
  const box = h('div', { class: 'p-hex', dataset: { hexFor: p.id, editable: editable ? '1' : '' } });
  fillHexInfo(box, p);
  return box;
}

function fillHexInfo(box, p) {
  const info = state.hexInfo.get(p.id);
  let detail;
  if (!info) detail = h('span', { class: 'muted' }, '確認中…');
  else if (info.ok) detail = h('span', { class: 'muted' }, `更新 ${formatDateTime(new Date(info.lastModified))}`);
  else detail = h('span', { class: 'text-error' }, `⚠ ${info.error}`);
  const parts = [h('div', { class: 'hex-path', title: p.hexPath }, p.hexPath), detail];
  if (box.dataset.editable) parts.push(h('button', { class: 'btn small', type: 'button', onclick: () => changeHex(p.id) }, '.hex変更'));
  box.replaceChildren(...parts);
}

function updateHexInfoViews() {
  for (const p of state.config.programs) {
    const box = document.querySelector(`[data-hex-for="${CSS.escape(p.id)}"]`);
    if (box) fillHexInfo(box, p);
  }
}

function statusView(id) {
  const box = h('div', { class: 'p-status', dataset: { statusFor: id } });
  fillStatus(box, id);
  return box;
}

function fillStatus(box, id) {
  const s = state.status.get(id);
  if (!s) {
    box.replaceChildren();
    return;
  }
  box.dataset.kind = s.kind;
  const parts = [h('span', { class: 'status-text' }, s.text)];
  if (s.max) parts.unshift(h('progress', { max: s.max, value: s.value }));
  box.replaceChildren(...parts);
}

function setProgramStatus(id, text, kind = 'info', value = 0, max = 0) {
  state.status.set(id, { text, kind, value, max });
  const box = document.querySelector(`[data-status-for="${CSS.escape(id)}"]`);
  if (box) fillStatus(box, id);
}

function updateLastWrittenUi() {
  const el = $('#lastWritten');
  const last = state.lastWritten;
  if (!last) {
    el.textContent = '不明';
    el.title = 'このPCでまだ書き込みをしていません';
    return;
  }
  el.textContent = findProgram(last.id)?.name || last.name || last.hexPath;
  el.title = `${last.hexPath}\n${formatDateTime(new Date(last.time))} に書き込み`;
}

// ---------------------------------------------------------------- 書き込み

async function writeProgram(id) {
  const p = findProgram(id);
  if (!p || !state.root || state.flashingId || !support.hid) return;
  state.flashingId = id;
  setBusy(true);
  const label = programLabel(p);
  const serialWasActive = serial ? serial.status !== 'disconnected' : false;
  let ok = false;
  monitor.info(`書き込み開始: ${label}（${p.hexPath}）`);
  try {
    setProgramStatus(id, '.hex を読み込み中…');
    const file = await (await getFileByPath(state.root, p.hexPath)).getFile();
    const hex = parseIntelHex(await file.text(), TEENSY41);
    monitor.info(`.hex を確認しました（${formatBytes(hex.size)}、${hex.blocks.length} ブロック、更新 ${formatDateTime(new Date(file.lastModified))}）`);

    let device = await findHalfKay();
    if (device) {
      await serial?.release();
    } else {
      setProgramStatus(id, 'Teensy をブートローダーに切り替え中…');
      const rebooted = serial ? await serial.rebootToBootloader() : false;
      device = await waitForBootloader(rebooted);
      if (!device) throw new CancelError();
    }

    const model = detectModel(device);
    if (model && model !== TEENSY41.name
      && !confirm(`接続されているボードは ${model} のようです。${TEENSY41.name} 用として書き込みを続けますか？`)) {
      throw new CancelError();
    }

    setProgramStatus(id, '書き込み中… 0%', 'info', 0, hex.blocks.length);
    await flashHalfKay(device, hex, (done, total) => {
      setProgramStatus(id, `書き込み中… ${Math.floor((done / total) * 100)}%`, 'info', done, total);
    });

    state.lastWritten = { id: p.id, name: p.name, hexPath: p.hexPath, time: Date.now() };
    lsSet(LAST_KEY, state.lastWritten);
    updateLastWrittenUi();
    setProgramStatus(id, `書き込み完了（${formatDateTime(new Date())}）`, 'ok');
    monitor.info(`書き込み完了: ${label}`);
    ok = true;
  } catch (e) {
    if (e instanceof CancelError) {
      setProgramStatus(id, '書き込みを中止しました', 'warn');
      monitor.info('書き込みを中止しました');
    } else {
      setProgramStatus(id, `失敗: ${e.message}`, 'error');
      monitor.error(`書き込みに失敗しました: ${e.message}`);
    }
  } finally {
    state.flashingId = null;
    setBusy(false);
  }
  if (serial && (ok || serialWasActive)) reconnectAfterFlash();
}

async function reconnectAfterFlash() {
  if (serial.status === 'connected') return;
  monitor.info('シリアルの再接続を待っています…');
  if ((await serial.reconnect(10000)) === 'timeout') {
    monitor.error('シリアルに自動で再接続できませんでした。画面上部のバーから接続してください。');
  }
}

// HalfKay が現れるのを待つ。自動で見つからなければ案内ダイアログを出す
function waitForBootloader(rebooted) {
  const dialog = $('#bootDialog');
  return new Promise((resolve) => {
    const listeners = new AbortController();
    let finished = false;
    let poll = 0;
    let showTimer = 0;
    const finish = (device) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(showTimer);
      listeners.abort();
      if (dialog.open) dialog.close();
      resolve(device);
    };
    const check = async () => {
      try {
        const device = await findHalfKay();
        if (device) finish(device);
      } catch {
        // 次の確認で再試行
      }
    };
    poll = setInterval(check, 250);
    check();
    showTimer = setTimeout(() => {
      $('#bootDialogLead').textContent = rebooted
        ? 'Teensy をブートローダーに切り替えています。画面が進まない場合は、次の手順を行ってください。'
        : 'シリアルポートが見つからないため、自動で切り替えられませんでした。次の手順を行ってください。';
      dialog.showModal();
    }, rebooted ? 3000 : 0);

    const opts = { signal: listeners.signal };
    $('#bootSelect').addEventListener('click', async () => {
      try {
        const device = await requestHalfKay();
        if (device) finish(device);
      } catch {
        // 選択されなかった
      }
    }, opts);
    $('#bootCancel').addEventListener('click', () => finish(null), opts);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    }, opts);
  });
}

function setBusy(on) {
  document.body.classList.toggle('is-busy', on);
  for (const btn of document.querySelectorAll('.btn-write')) btn.disabled = on || !support.hid;
  for (const btn of document.querySelectorAll('.add-program')) btn.disabled = on;
  $('#btnFolder').disabled = on || !support.fs;
  updateEditUi();
  updateSerialUi();
}

// ---------------------------------------------------------------- シリアル

function onSerialStatus() {
  const now = serial.status;
  if (lastSerialStatus === 'reconnecting' && now === 'connected') monitor.info('シリアルに再接続しました');
  lastSerialStatus = now;
  updateSerialUi();
}

function updateSerialUi() {
  const status = state.flashingId ? 'flashing' : serial?.status ?? 'disconnected';
  const labels = { disconnected: '未接続', connected: '接続中', reconnecting: '再接続中', flashing: '書き込み中' };
  const pill = $('#serialStatus');
  pill.textContent = labels[status];
  pill.dataset.status = status;
  const busy = !!state.flashingId;
  const unavailable = !serial || busy;
  $('#btnConnect').disabled = unavailable || status === 'connected';
  $('#btnDisconnect').disabled = unavailable || !(status === 'connected' || status === 'reconnecting');
  $('#btnAddPort').disabled = unavailable || status === 'connected';
  $('#portSelect').disabled = unavailable || status === 'connected';
}

function portLabel(port, index, count) {
  const { usbVendorId, usbProductId } = port.getInfo();
  let label;
  if (usbVendorId === TEENSY_VID) label = `Teensy（${hex4(usbVendorId)}:${hex4(usbProductId)}）`;
  else if (usbVendorId != null) label = `USB シリアル（${hex4(usbVendorId)}:${hex4(usbProductId)}）`;
  else label = 'シリアルポート';
  return count > 1 ? `${label} #${index + 1}` : label;
}

async function refreshPorts() {
  if (!serial) return;
  const select = $('#portSelect');
  const ports = await serial.getPorts();
  state.ports = ports;
  let index = ports.indexOf(serial.port);
  if (index < 0) index = Math.min(Number(select.value) || 0, ports.length - 1);
  select.replaceChildren(...(ports.length
    ? ports.map((port, i) => h('option', { value: String(i) }, portLabel(port, i, ports.length)))
    : [h('option', { value: '' }, 'ポートなし')]));
  if (ports.length) select.value = String(index);
  updateSerialUi();
}

async function addPort() {
  if (!serial) return null;
  try {
    const port = await serial.requestPort();
    await refreshPorts();
    const index = state.ports.indexOf(port);
    if (index >= 0) $('#portSelect').value = String(index);
    return port;
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(`ポートを選択できませんでした: ${e.message}`, 'error');
    return null;
  }
}

async function connectSelected() {
  if (!serial || state.flashingId) return;
  const port = state.ports[Number($('#portSelect').value)] ?? (await addPort());
  if (!port) return;
  try {
    await serial.connect(port);
    monitor.info('シリアルに接続しました');
  } catch (e) {
    monitor.error(`接続できませんでした: ${e.message}（Arduino IDE のシリアルモニタなど、ほかのアプリがポートを使っていないか確認してください）`);
  }
}

async function disconnectSerial() {
  if (!serial) return;
  const wasConnected = serial.status === 'connected';
  await serial.disconnect();
  monitor.info(wasConnected ? 'シリアルを切断しました' : '再接続を中止しました');
}

function ensureCanSend() {
  if (state.flashingId) {
    monitor.error('書き込み中は送信できません');
    return false;
  }
  if (serial?.status !== 'connected') {
    monitor.error('シリアルが接続されていません。画面上部のバーから接続してください。');
    return false;
  }
  return true;
}

async function sendLine(text) {
  if (!ensureCanSend()) return false;
  monitor.sent(text);
  try {
    await serial.send(`${text}\n`);
    return true;
  } catch (e) {
    monitor.error(`送信できませんでした: ${e.message}`);
    return false;
  }
}

async function sendProgramCommand(programId, commandId) {
  const p = findProgram(programId);
  const c = p?.commands.find((x) => x.id === commandId);
  if (!c?.command || !ensureCanSend()) return;
  const last = state.lastWritten;
  if (last?.id !== p.id) {
    const current = last
      ? `現在 Teensy に書き込まれているのは「${findProgram(last.id)?.name || last.name || last.hexPath}」です。`
      : 'Teensy に書き込まれているプログラムが分かりません。';
    if (!confirm(`${current}\n「${programLabel(p)}」のコマンド "${c.command}" を送信しますか？`)) return;
  }
  await sendLine(c.command);
}

function bindSerialPanel() {
  const input = $('#sendInput');
  const history = lsGet(HISTORY_KEY, []);
  let cursor = history.length;

  $('#sendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    if (!(await sendLine(text))) return;
    if (history.at(-1) !== text) {
      history.push(text);
      if (history.length > HISTORY_MAX) history.shift();
      lsSet(HISTORY_KEY, history);
    }
    cursor = history.length;
    input.value = '';
  });

  // ↑↓ で入力履歴を呼び出す（日本語変換中は変換候補の操作を優先）
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowUp' && cursor > 0) {
      cursor--;
      input.value = history[cursor];
      e.preventDefault();
    } else if (e.key === 'ArrowDown' && cursor < history.length) {
      cursor++;
      input.value = history[cursor] ?? '';
      e.preventDefault();
    }
  });

  const prefs = { autoscroll: true, showTime: false, ...lsGet(PREFS_KEY, {}) };
  const autoscroll = $('#chkAutoscroll');
  const showTime = $('#chkTimestamp');
  autoscroll.checked = prefs.autoscroll;
  showTime.checked = prefs.showTime;
  monitor.autoscroll = prefs.autoscroll;
  monitor.setShowTime(prefs.showTime);
  autoscroll.addEventListener('change', () => {
    prefs.autoscroll = autoscroll.checked;
    monitor.autoscroll = autoscroll.checked;
    lsSet(PREFS_KEY, prefs);
    if (autoscroll.checked) monitor.scrollToBottom();
  });
  showTime.addEventListener('change', () => {
    prefs.showTime = showTime.checked;
    monitor.setShowTime(showTime.checked);
    lsSet(PREFS_KEY, prefs);
  });

  $('#btnClear').addEventListener('click', () => monitor.clear());
  $('#btnSaveLog').addEventListener('click', saveLog);
}

function saveLog() {
  // 先頭の BOM はメモ帳などで文字化けさせないため
  const blob = new Blob(['﻿', monitor.toText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: `serial_${formatFileStamp(new Date())}.txt` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- 通知

let toastTimer = 0;

function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3000);
}

function showNotice(message, kind, key) {
  hideNotice(key);
  $('#notices').append(h('div', { class: `notice ${kind}`, dataset: { key } }, message));
}

function hideNotice(key) {
  $('#notices').querySelector(`[data-key="${key}"]`)?.remove();
}

init();
