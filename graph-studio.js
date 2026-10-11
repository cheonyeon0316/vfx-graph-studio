if (!globalThis.PXFGraphRenderer) {
  const errorNode = document.getElementById('graphInputError');
  errorNode.textContent = '그래프 렌더러를 불러오지 못했습니다. graph-renderer-core.js 파일이 같은 폴더에 있는지 확인하세요.';
  errorNode.classList.remove('is-hidden');
  document.getElementById('graphInputStatus').textContent = '렌더러 초기화에 실패했습니다.';
  throw new Error('PXF graph renderer is unavailable.');
}

const { graphDescription, prepareGraphAssets, releaseGraphAssets, renderGraphFrame, validateGraphDocument } = globalThis.PXFGraphRenderer;

const $ = (id) => document.getElementById(id);
const DB_NAME = 'vfx-lab-private-graph-library';
const STORE_NAME = 'effects';
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_LIBRARY_ITEMS = 100;
const state = {
  db: null,
  library: [],
  graphs: [],
  selectedIndex: 0,
  collection: false,
  frame: 0,
  playbackTimer: 0,
  playing: false,
  currentLibraryId: null,
  sourceFormat: 'PXF graph',
  renderRequestId: 0,
};

const editor = $('graphJsonInput');
const preview = $('graphPreviewCanvas');
const previewContext = preview.getContext('2d');

function selectedGraph() { return state.graphs[state.selectedIndex] || null; }

function setStatus(message, success = false) {
  const node = $('graphInputStatus');
  node.textContent = message;
  node.classList.toggle('is-success', success);
}

function setError(message = '') {
  const node = $('graphInputError');
  node.textContent = message;
  node.classList.toggle('is-hidden', !message);
}

function parseEditorText(value) {
  let source = String(value || '').trim();
  if (!source) throw new Error('JSON을 붙여넣거나 파일을 선택하세요.');
  if (source.length > MAX_JSON_BYTES) throw new Error('JSON은 20MiB 이하로 입력할 수 있습니다.');
  if (source.startsWith('```')) {
    source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new Error(`JSON 문법을 확인하세요. ${error.message}`); }
  const result = validateGraphDocument(parsed);
  if (!result.valid) throw new Error(result.message);
  return result;
}

async function renderDocument(result) {
  const requestId = ++state.renderRequestId;
  stopPlayback();
  setError('');
  if (result.value.some((graph) => Array.isArray(graph.assets) && graph.assets.length)) setStatus('내장 PNG 프레임을 읽는 중입니다.');
  const assetResults = await Promise.allSettled(result.value.map((graph) => prepareGraphAssets(graph)));
  if (requestId !== state.renderRequestId) {
    result.value.forEach(releaseGraphAssets);
    return;
  }
  const assetError = assetResults.find((resultItem) => resultItem.status === 'rejected');
  if (assetError) {
    result.value.forEach(releaseGraphAssets);
    throw assetError.reason;
  }
  for (const graph of state.graphs) if (!result.value.includes(graph)) releaseGraphAssets(graph);
  state.graphs = result.value;
  state.collection = result.collection;
  state.sourceFormat = result.sourceFormat || (result.collection ? 'PXF variations' : 'PXF graph');
  state.selectedIndex = 0;
  state.frame = 0;
  state.currentLibraryId = null;
  $('graphVariations').classList.toggle('is-hidden', !result.collection);
  $('saveAllVariations').classList.toggle('is-hidden', !result.collection || state.graphs.length < 2 || !state.db);
  if (result.collection) renderVariationPicker();
  else $('graphVariationList').replaceChildren();
  renderSelectedGraph(true);
  setError('');
  const count = result.value.length;
  setStatus(result.collection ? `${count}개 후보를 검증하고 렌더했습니다. 후보 버튼으로 미리보기를 바꾸세요.` : '그래프 검증을 통과했습니다. 애니메이션을 렌더했습니다.', true);
}

function renderSelectedGraph(autoplay = false) {
  const graph = selectedGraph();
  if (!graph) return;
  state.frame = Math.min(state.frame, graph.settings.frames - 1);
  const size = graph.settings.size;
  if (preview.width !== size || preview.height !== size) {
    preview.width = size;
    preview.height = size;
  }
  previewContext.clearRect(0, 0, size, size);
  try {
    const frameCanvas = renderGraphFrame(graph, state.frame);
    previewContext.imageSmoothingEnabled = false;
    previewContext.drawImage(frameCanvas, 0, 0);
    preview.classList.remove('is-hidden');
    $('graphEmptyState').classList.add('is-hidden');
    $('graphEffectName').textContent = graph.name;
    $('graphEffectSettings').textContent = graphDescription(graph);
    $('graphFormatBadge').textContent = state.collection
      ? `후보 ${state.selectedIndex + 1} / ${state.graphs.length}`
      : state.sourceFormat === 'VFX Lab sprite graph' ? 'PNG SPRITE GRAPH' : 'PXF GRAPH';
    $('graphNodeMeta').textContent = `${graph.nodes.length} nodes · ${graph.links.length} links`;
    $('graphFrameSlider').max = String(graph.settings.frames - 1);
    $('graphFrameSlider').value = String(state.frame);
    $('graphFrameCounter').textContent = `${String(state.frame + 1).padStart(2, '0')} / ${graph.settings.frames}`;
    $('toggleGraphPlayback').disabled = false;
    $('restartGraphPlayback').disabled = false;
    $('exportGraphPng').disabled = false;
    $('exportGraphJson').disabled = false;
    $('graphFrameSlider').disabled = graph.settings.frames < 2;
    updateSaveButton();
    renderVariationPickerSelection();
    if (autoplay) startPlayback();
  } catch (error) {
    setError(`렌더 중 오류: ${error.message}`);
    stopPlayback();
  }
}

function renderVariationPicker() {
  const host = $('graphVariationList');
  host.replaceChildren();
  $('graphVariationCount').textContent = `${state.graphs.length}개`;
  state.graphs.forEach((graph, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gs-variation-option';
    button.dataset.index = String(index);
    button.setAttribute('aria-pressed', index === state.selectedIndex ? 'true' : 'false');
    const thumb = document.createElement('span');
    thumb.className = 'gs-variation-thumb';
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    try {
      const frame = renderGraphFrame(graph, Math.min(2, graph.settings.frames - 1));
      canvas.getContext('2d').drawImage(frame, 0, 0, 64, 64);
    } catch { /* The main preview reports the full render error. */ }
    thumb.append(canvas);
    const label = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = graph.name;
    const meta = document.createElement('small');
    meta.textContent = `${graph.nodes.length}개 노드 · ${graph.settings.frames}프레임`;
    label.append(name, meta);
    button.append(thumb, label);
    button.addEventListener('click', () => {
      state.selectedIndex = index;
      state.frame = 0;
      renderSelectedGraph(true);
    });
    host.append(button);
  });
}

function renderVariationPickerSelection() {
  if (!state.collection) return;
  $('graphVariationList').querySelectorAll('.gs-variation-option').forEach((button) => {
    const active = Number(button.dataset.index) === state.selectedIndex;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function startPlayback() {
  const graph = selectedGraph();
  if (!graph || graph.settings.frames < 2) return;
  stopPlayback();
  state.playing = true;
  $('toggleGraphPlayback').textContent = 'Ⅱ';
  $('toggleGraphPlayback').setAttribute('aria-label', '일시정지');
  const interval = Math.max(16, 1000 / graph.settings.fps);
  state.playbackTimer = window.setInterval(() => {
    const current = selectedGraph();
    if (!current) return stopPlayback();
    if (state.frame + 1 >= current.settings.frames) {
      if (current.settings.loop) state.frame = 0;
      else {
        state.frame = representativeFrame(current);
        stopPlayback();
      }
    } else state.frame += 1;
    renderSelectedGraph(false);
  }, interval);
}

function stopPlayback() {
  if (state.playbackTimer) window.clearInterval(state.playbackTimer);
  state.playbackTimer = 0;
  state.playing = false;
  const button = $('toggleGraphPlayback');
  if (button) {
    button.textContent = '▶';
    button.setAttribute('aria-label', '재생');
  }
}

function togglePlayback() {
  if (state.playing) stopPlayback();
  else {
    const graph = selectedGraph();
    if (graph && state.frame >= graph.settings.frames - 1) state.frame = 0;
    renderSelectedGraph(false);
    startPlayback();
  }
}

function updateSaveButton() {
  const graph = selectedGraph();
  const save = $('saveGraphButton');
  save.disabled = !graph || !state.db;
  save.textContent = state.db && graph && state.library.some((item) => graphHash(item.graph) === graphHash(graph))
    ? '라이브러리에 저장됨'
    : state.db ? '내 라이브러리에 저장' : '로컬 저장소 사용 불가';
  save.disabled = save.disabled || save.textContent === '라이브러리에 저장됨';
}

async function openDatabase() {
  if (!window.indexedDB) throw new Error('이 브라우저는 IndexedDB를 지원하지 않습니다.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('브라우저 저장소를 열 수 없습니다.'));
  });
}

function readLibrary() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))));
    request.onerror = () => reject(request.error || new Error('라이브러리를 읽지 못했습니다.'));
  });
}

function writeLibraryItem(item) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(item);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('효과를 저장하지 못했습니다.'));
    transaction.onabort = () => reject(transaction.error || new Error('저장이 취소되었습니다.'));
  });
}

function writeLibraryItems(items) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    items.forEach((item) => store.put(item));
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('후보를 저장하지 못했습니다.'));
    transaction.onabort = () => reject(transaction.error || new Error('저장이 취소되었습니다.'));
  });
}

function deleteLibraryItem(id) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('효과를 삭제하지 못했습니다.'));
  });
}

async function refreshLibrary() {
  if (!state.db) return;
  state.library = await readLibrary();
  $('graphLibraryCount').textContent = String(state.library.length);
  renderLibrary();
  updateSaveButton();
}

function renderLibrary() {
  const host = $('graphLibraryList');
  host.replaceChildren();
  const query = $('graphLibrarySearch').value.trim().toLocaleLowerCase();
  const visible = state.library.filter((item) => !query || `${item.name} ${item.graph?.name || ''}`.toLocaleLowerCase().includes(query));
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'gs-library-empty';
    empty.textContent = query ? '검색 결과가 없습니다.' : '저장한 효과가 여기에 표시됩니다.';
    host.append(empty);
    return;
  }
  visible.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'gs-library-item';
    const head = document.createElement('div');
    head.className = 'gs-library-item-head';
    const title = document.createElement('h3');
    title.textContent = item.name;
    const date = document.createElement('time');
    date.dateTime = item.savedAt;
    date.textContent = formatDate(item.savedAt);
    head.append(title);
    const actions = document.createElement('div');
    actions.className = 'gs-library-item-actions';
    actions.append(actionButton('열기', 'open', item.id), actionButton('이름 변경', 'rename', item.id), actionButton('삭제', 'delete', item.id));
    card.append(head, date, actions);
    host.append(card);
  });
}

function actionButton(label, action, id) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

async function saveCurrentGraph() {
  const graph = selectedGraph();
  if (!graph || !state.db) return;
  if (state.library.length >= MAX_LIBRARY_ITEMS) throw new Error(`라이브러리는 최대 ${MAX_LIBRARY_ITEMS}개까지 저장할 수 있습니다.`);
  const alreadySaved = state.library.some((item) => graphHash(item.graph) === graphHash(graph));
  if (alreadySaved) return;
  const item = { id: randomId(), name: graph.name.trim(), graph: structuredCloneSafe(graph), savedAt: new Date().toISOString() };
  await writeLibraryItem(item);
  state.currentLibraryId = item.id;
  await refreshLibrary();
  setStatus(`“${item.name}”을 현재 브라우저 라이브러리에 저장했습니다.`, true);
}

async function saveAllGraphs() {
  if (!state.db || !state.graphs.length) return;
  const newGraphs = state.graphs.filter((graph) => !state.library.some((item) => graphHash(item.graph) === graphHash(graph)));
  if (!newGraphs.length) { setStatus('모든 후보가 이미 라이브러리에 있습니다.', true); return; }
  if (state.library.length + newGraphs.length > MAX_LIBRARY_ITEMS) throw new Error(`후보를 저장하면 라이브러리 ${MAX_LIBRARY_ITEMS}개 제한을 넘습니다.`);
  const now = Date.now();
  const items = newGraphs.map((graph, index) => ({ id: randomId(), name: graph.name.trim(), graph: structuredCloneSafe(graph), savedAt: new Date(now + index).toISOString() }));
  await writeLibraryItems(items);
  await refreshLibrary();
  setStatus(`${items.length}개 후보를 현재 브라우저 라이브러리에 저장했습니다.`, true);
}

async function openLibraryGraph(id) {
  const item = state.library.find((entry) => entry.id === id);
  if (!item) return;
  editor.value = JSON.stringify(item.graph, null, 2);
  const result = validateGraphDocument(item.graph);
  if (!result.valid) { setError(`저장된 그래프 검증 실패: ${result.message}`); return; }
  await renderDocument(result);
  state.currentLibraryId = item.id;
  setStatus(`“${item.name}”을 열었습니다.`, true);
  $('gsPreviewHeading').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleLibraryAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  const item = state.library.find((entry) => entry.id === id);
  if (!item) return;
  if (action === 'open') { await openLibraryGraph(id); return; }
  if (action === 'rename') {
    const nextName = window.prompt('효과 이름', item.name);
    if (nextName == null) return;
    const name = nextName.trim();
    if (!name || name.length > 80) { setStatus('이름은 1–80자로 입력하세요.'); return; }
    await writeLibraryItem({ ...item, name, graph: { ...item.graph, name } });
    const openIndex = state.library.findIndex((entry) => entry.id === id);
    if (state.currentLibraryId === id && openIndex >= 0) {
      state.graphs[state.selectedIndex] = { ...state.graphs[state.selectedIndex], name };
      editor.value = JSON.stringify(state.graphs[state.selectedIndex], null, 2);
      renderSelectedGraph(false);
    }
    await refreshLibrary();
    return;
  }
  if (action === 'delete' && window.confirm(`“${item.name}”을 이 브라우저 라이브러리에서 삭제할까요?`)) {
    await deleteLibraryItem(id);
    if (state.currentLibraryId === id) state.currentLibraryId = null;
    await refreshLibrary();
  }
}

function exportGraphJson() {
  const graph = selectedGraph();
  if (!graph) return;
  downloadBlob(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json;charset=utf-8' }), `${fileSlug(graph.name)}.json`);
}

function exportFramePng() {
  const graph = selectedGraph();
  if (!graph) return;
  preview.toBlob((blob) => {
    if (!blob) { setStatus('현재 프레임 PNG를 만들지 못했습니다.'); return; }
    downloadBlob(blob, `${fileSlug(graph.name)}-frame-${String(state.frame + 1).padStart(3, '0')}.png`);
  }, 'image/png');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function fileSlug(value) {
  return String(value || 'vfx-effect').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 70) || 'vfx-effect';
}

function representativeFrame(graph) {
  const candidate = Number.isInteger(graph.game?.impactFrame)
    ? graph.game.impactFrame
    : Number.isInteger(graph.settings.impactFrame)
      ? graph.settings.impactFrame
      : Math.round((graph.settings.frames - 1) * .24);
  return Math.max(0, Math.min(graph.settings.frames - 1, candidate));
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '저장됨';
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function graphHash(graph) { return JSON.stringify(graph); }
function randomId() { return globalThis.crypto?.randomUUID?.() || `effect-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value)); }

async function renderInput() {
  try {
    const result = parseEditorText(editor.value);
    await renderDocument(result);
  } catch (error) {
    setError(error.message || 'JSON 그래프를 열지 못했습니다.');
    setStatus('입력 내용을 확인하세요.');
  }
}

async function importFile(file) {
  if (!file) return;
  if (file.size > MAX_JSON_BYTES) { setError('JSON 파일은 20MiB 이하만 열 수 있습니다.'); return; }
  try {
    editor.value = await file.text();
    await renderInput();
  } catch (error) {
    setError(`파일을 읽지 못했습니다: ${error.message}`);
  }
}

function bindEvents() {
  $('renderGraphButton').addEventListener('click', renderInput);
  $('graphJsonFile').addEventListener('change', (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file) importFile(file);
  });
  $('toggleGraphPlayback').addEventListener('click', togglePlayback);
  $('restartGraphPlayback').addEventListener('click', () => { state.frame = 0; renderSelectedGraph(false); startPlayback(); });
  $('graphFrameSlider').addEventListener('input', (event) => {
    stopPlayback();
    state.frame = Number(event.currentTarget.value);
    renderSelectedGraph(false);
  });
  $('saveGraphButton').addEventListener('click', () => saveCurrentGraph().catch((error) => setError(error.message)));
  $('saveAllVariations').addEventListener('click', () => saveAllGraphs().catch((error) => setError(error.message)));
  $('exportGraphJson').addEventListener('click', exportGraphJson);
  $('exportGraphPng').addEventListener('click', exportFramePng);
  $('graphLibrarySearch').addEventListener('input', renderLibrary);
  $('graphLibraryList').addEventListener('click', (event) => handleLibraryAction(event).catch((error) => setError(error.message)));
  editor.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); renderInput(); }
  });
}

async function init() {
  bindEvents();
  try {
    state.db = await openDatabase();
    await refreshLibrary();
  } catch (error) {
    state.db = null;
    $('saveGraphButton').disabled = true;
    setStatus(`렌더는 사용할 수 있지만 브라우저 저장소에 연결하지 못했습니다: ${error.message}`);
  }
}

init();
