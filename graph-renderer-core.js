(function () {
const SUPPORTED_NODE_TYPES = new Set(['Shape', 'Stroke', 'Particles', 'Repeat', 'Blend', 'Glow', 'Palette', 'Tint', 'Sprite', 'Output']);
const SHAPE_TYPES = new Set(['circle', 'ring', 'star', 'diamond', 'square', 'cross', 'burst', 'ellipse']);
const BLEND_MODES = new Set(['max', 'add', 'screen', 'normal']);
const SPRITE_ANCHORS = new Set(['source', 'impact', 'midpoint', 'target']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_EMBEDDED_ASSETS = 64;
const MAX_EMBEDDED_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_EMBEDDED_TOTAL_PIXELS = 32 * 1024 * 1024;
const graphAssetRuntime = new WeakMap();

function validateGraph(graph) {
  const fail = (message) => ({ valid: false, message });
  if (!isRecord(graph)) return fail('그래프는 JSON 객체여야 합니다.');
  if (graph.format !== 'pxf.graph@1') return fail('format은 pxf.graph@1이어야 합니다.');
  if (typeof graph.name !== 'string' || !graph.name.trim() || graph.name.trim().length > 80) return fail('name은 1–80자여야 합니다.');
  const settings = graph.settings;
  if (!isRecord(settings)) return fail('settings 객체가 필요합니다.');
  if (!Number.isInteger(settings.size) || settings.size < 16 || settings.size > 256) return fail('settings.size는 16–256 사이의 정수여야 합니다.');
  if (!Number.isInteger(settings.frames) || settings.frames < 1 || settings.frames > 180) return fail('settings.frames는 1–180 사이의 정수여야 합니다.');
  if (!Number.isFinite(settings.fps) || settings.fps < 1 || settings.fps > 60) return fail('settings.fps는 1–60 사이여야 합니다.');
  if (settings.loop != null && typeof settings.loop !== 'boolean') return fail('settings.loop은 true 또는 false여야 합니다.');
  const assetResult = validateAssets(graph.assets);
  if (!assetResult.valid) return assetResult;
  const assetsById = new Map(assetResult.assets.map((asset) => [asset.id, asset]));
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > 64) return fail('nodes는 1–64개 배열이어야 합니다.');
  if (!Array.isArray(graph.links) || graph.links.length > 160) return fail('links는 0–160개 배열이어야 합니다.');

  const nodes = new Map();
  for (const [index, node] of graph.nodes.entries()) {
    if (!isRecord(node) || typeof node.id !== 'string' || !/^[\w.-]{1,64}$/u.test(node.id)) return fail(`nodes[${index}]의 id 형식이 유효하지 않습니다.`);
    if (nodes.has(node.id)) return fail(`중복 node id: ${node.id}`);
    if (!SUPPORTED_NODE_TYPES.has(node.type)) return fail(`지원하지 않는 노드입니다: ${String(node.type || '(type 없음)')}`);
    if (!isRecord(node.params)) return fail(`${node.id}.params 객체가 필요합니다.`);
    if (!validateKeyframes(node.params)) return fail(`${node.id}에 잘못된 키프레임이 있습니다.`);
    nodes.set(node.id, node);
    if (node.type === 'Sprite') {
      const asset = assetsById.get(node.params.assetId);
      if (!asset) return fail(node.id + ': assets에 없는 PNG를 참조합니다.');
      const frames = isRecord(asset.frames) ? asset.frames : {};
      const count = Number.isInteger(frames.count) ? frames.count : (Number.isInteger(frames.columns) ? frames.columns : 1) * (Number.isInteger(frames.rows) ? frames.rows : 1);
      if (node.params.frame >= count) return fail(node.id + ': frame이 참조한 PNG의 프레임 수를 벗어났습니다.');
      const spriteEnd = node.params.start + node.params.duration;
      if (spriteEnd > settings.frames / settings.fps + 0.001) return fail(node.id + ': Sprite 시간이 그래프 길이를 넘습니다.');
    }
    const nodeProblem = validateNodeParams(node);
    if (nodeProblem) return fail(`${node.id}: ${nodeProblem}`);
  }

  const outputs = graph.nodes.filter((node) => node.type === 'Output');
  if (outputs.length !== 1) return fail('Output 노드는 정확히 하나여야 합니다.');
  const inputLinks = new Map();
  const edgesFrom = new Map();
  const seenLinks = new Set();
  for (const [index, link] of graph.links.entries()) {
    if (!isRecord(link) || typeof link.f !== 'string' || typeof link.t !== 'string' || !Number.isInteger(link.p) || link.p < 0 || link.p > 15) return fail(`links[${index}]의 f, t, p 값이 유효하지 않습니다.`);
    if (!nodes.has(link.f) || !nodes.has(link.t)) return fail(`links[${index}]에서 존재하지 않는 노드를 참조합니다.`);
    if (link.f === link.t) return fail(`자기 자신을 연결하는 링크가 있습니다: ${link.f}`);
    const linkKey = `${link.f}>${link.t}:${link.p}`;
    const inputKey = `${link.t}:${link.p}`;
    if (seenLinks.has(linkKey)) return fail(`중복 링크가 있습니다: ${linkKey}`);
    if (inputLinks.has(inputKey)) return fail(`${link.t}의 입력 ${link.p}가 두 번 연결되었습니다.`);
    seenLinks.add(linkKey);
    inputLinks.set(inputKey, link.f);
    if (!edgesFrom.has(link.f)) edgesFrom.set(link.f, []);
    edgesFrom.get(link.f).push(link.t);
  }
  if (!graph.links.some((link) => link.t === outputs[0].id)) return fail('Output 입력에 연결된 그래프가 없습니다.');

  const visitState = new Map();
  const visit = (id) => {
    if (visitState.get(id) === 1) return false;
    if (visitState.get(id) === 2) return true;
    visitState.set(id, 1);
    for (const next of edgesFrom.get(id) || []) if (!visit(next)) return false;
    visitState.set(id, 2);
    return true;
  };
  for (const id of nodes.keys()) if (!visit(id)) return fail('그래프에 순환 링크가 있습니다.');

  const reachesOutput = new Set([outputs[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of graph.links) {
      if (reachesOutput.has(link.t) && !reachesOutput.has(link.f)) {
        reachesOutput.add(link.f);
        changed = true;
      }
    }
  }
  const unused = graph.nodes.find((node) => !reachesOutput.has(node.id));
  if (unused) return fail(`${unused.id} 노드가 Output에 연결되지 않았습니다.`);
  return { valid: true, value: graph };
}

function validateGraphDocument(value) {
  const fail = (message) => ({ valid: false, message });
  if (isRecord(value) && value.schemaVersion === 3) {
    const converted = convertEmbeddedSpriteGraph(value);
    if (!converted.valid) return converted;
    const result = validateGraph(converted.value);
    return result.valid ? { valid: true, value: [converted.value], collection: false, sourceFormat: 'VFX Lab sprite graph' } : result;
  }
  if (isRecord(value) && value.format === 'pxf.graph@1') {
    const result = validateGraph(value);
    return result.valid ? { valid: true, value: [value], collection: false } : result;
  }
  if (!isRecord(value) || value.format !== 'vfxlab.variations@1') return fail('지원하지 않는 JSON 형식입니다. pxf.graph@1, PNG 프레임 그래프(schemaVersion 3), 또는 vfxlab.variations@1 묶음을 입력하세요.');
  if (!Array.isArray(value.effects) || value.effects.length < 2 || value.effects.length > 3) return fail('effects는 서로 다른 후보 2–3개 배열이어야 합니다.');
  const names = new Set();
  const signatures = new Set();
  for (const [index, graph] of value.effects.entries()) {
    const result = validateGraph(graph);
    if (!result.valid) return fail(`후보 ${index + 1}: ${result.message}`);
    const name = graph.name.trim().toLowerCase();
    if (names.has(name)) return fail('후보 이름이 중복됩니다. 각 그래프에 서로 다른 name을 지정하세요.');
    names.add(name);
    const signature = graphVariationSignature(graph);
    if (signatures.has(signature)) return fail('후보가 색상 차이만 있거나 그래프 구조가 중복됩니다. 실루엣·움직임·구조·타이밍을 다르게 만드세요.');
    signatures.add(signature);
  }
  return { valid: true, value: value.effects, collection: true, sourceFormat: 'PXF variations' };
}

async function prepareGraphAssets(graph) {
  const assets = Array.isArray(graph.assets) ? graph.assets : [];
  if (!assets.length) {
    graphAssetRuntime.set(graph, { images: new Map(), records: new Map() });
    return;
  }
  const cached = graphAssetRuntime.get(graph);
  if (cached && cached.images.size === assets.length) return;
  const images = new Map();
  const records = new Map();
  try {
    for (const asset of assets) {
      let image;
      if (typeof createImageBitmap === 'function') {
        const response = await fetch(asset.dataUrl);
        if (!response.ok) throw new Error('PNG 프레임 데이터를 읽지 못했습니다.');
        const blob = await response.blob();
        if (blob.size > MAX_EMBEDDED_ASSET_BYTES) throw new Error('PNG 프레임은 한 장당 8MiB 이하여야 합니다.');
        image = await createImageBitmap(blob);
      } else {
        image = await decodeImageElement(asset.dataUrl);
      }
      if (image.width !== asset.width || image.height !== asset.height) {
        image.close?.();
        throw new Error((asset.name || asset.id) + ' PNG 크기와 JSON 메타데이터가 다릅니다.');
      }
      images.set(asset.id, image);
      records.set(asset.id, asset);
    }
    graphAssetRuntime.set(graph, { images, records });
  } catch (error) {
    for (const image of images.values()) image.close?.();
    throw error;
  }
}

function releaseGraphAssets(graph) {
  const runtime = graphAssetRuntime.get(graph);
  if (!runtime) return;
  for (const image of runtime.images.values()) image.close?.();
  graphAssetRuntime.delete(graph);
}

function validateAssets(value) {
  const fail = (message) => ({ valid: false, message });
  if (value == null) return { valid: true, assets: [] };
  if (!Array.isArray(value) || value.length > MAX_EMBEDDED_ASSETS) return fail('assets는 최대 64개 PNG 배열이어야 합니다.');
  const ids = new Set();
  let totalBytes = 0;
  let totalPixels = 0;
  for (const [index, asset] of value.entries()) {
    if (!isRecord(asset) || typeof asset.id !== 'string' || !/^[\w.-]{1,64}$/u.test(asset.id)) return fail('assets[' + index + ']의 id 형식이 유효하지 않습니다.');
    if (ids.has(asset.id)) return fail('중복 asset id: ' + asset.id);
    ids.add(asset.id);
    if (asset.mimeType !== 'image/png') return fail(asset.id + '은 PNG 이미지여야 합니다.');
    if (!Number.isInteger(asset.width) || asset.width < 1 || asset.width > 4096 || !Number.isInteger(asset.height) || asset.height < 1 || asset.height > 4096) return fail(asset.id + '의 PNG 크기는 1–4096px여야 합니다.');
    totalPixels += asset.width * asset.height;
    if (totalPixels > MAX_EMBEDDED_TOTAL_PIXELS) return fail('내장 PNG 전체 해상도는 약 3,200만 픽셀 이하여야 합니다.');
    if (typeof asset.dataUrl !== 'string' || !asset.dataUrl.startsWith('data:image/png;base64,')) return fail(asset.id + '의 PNG 데이터가 내장되어 있지 않습니다. 외부 URL은 사용할 수 없습니다.');
    const encoded = asset.dataUrl.slice('data:image/png;base64,'.length);
    if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail(asset.id + '의 Base64 PNG 데이터가 유효하지 않습니다.');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.floor(encoded.length / 4) * 3 - padding;
    if (decodedBytes > MAX_EMBEDDED_ASSET_BYTES) return fail(asset.id + ' PNG는 한 장당 8MiB 이하여야 합니다.');
    totalBytes += decodedBytes;
    const frames = isRecord(asset.frames) ? asset.frames : {};
    const frameWidth = Number.isInteger(frames.width) ? frames.width : asset.width;
    const frameHeight = Number.isInteger(frames.height) ? frames.height : asset.height;
    const columns = Number.isInteger(frames.columns) ? frames.columns : 1;
    const rows = Number.isInteger(frames.rows) ? frames.rows : 1;
    const count = Number.isInteger(frames.count) ? frames.count : columns * rows;
    const fps = Number.isFinite(frames.fps) ? frames.fps : 0;
    if (frameWidth < 1 || frameHeight < 1 || columns < 1 || rows < 1 || count < 1 || count > columns * rows || columns * frameWidth > asset.width || rows * frameHeight > asset.height || fps < 0 || fps > 60) return fail(asset.id + '의 스프라이트 프레임 정보가 유효하지 않습니다.');
    if (asset.pivot != null && (!isRecord(asset.pivot) || !finiteIn(asset.pivot.x, 0, 1) || !finiteIn(asset.pivot.y, 0, 1))) return fail(asset.id + '의 pivot은 0–1 좌표여야 합니다.');
  }
  if (totalBytes > MAX_EMBEDDED_TOTAL_BYTES) return fail('내장 PNG 전체 크기는 20MiB 이하여야 합니다.');
  return { valid: true, assets: value };
}

function convertEmbeddedSpriteGraph(value) {
  const fail = (message) => ({ valid: false, message });
  const sourceGraph = value.graph;
  if (!isRecord(sourceGraph) || sourceGraph.graphVersion !== 1 || !Array.isArray(sourceGraph.nodes) || !Array.isArray(sourceGraph.edges)) return fail('schemaVersion 3 그래프에 graphVersion 1, nodes, edges가 필요합니다.');
  if (sourceGraph.nodes.length < 1 || sourceGraph.nodes.length > 64 || sourceGraph.edges.length > 160) return fail('노드는 1–64개, 연결은 160개 이하여야 합니다.');
  const duration = Number(value.duration);
  if (!finiteIn(duration, 0.04, 6)) return fail('duration은 0.04–6초 사이여야 합니다.');
  const name = String(value.displayName || value.id || 'PNG 프레임 효과').trim().slice(0, 80);
  if (!name) return fail('효과 이름이 필요합니다.');
  if (!Array.isArray(value.embeddedAssets) || !value.embeddedAssets.length) return fail('PNG 프레임 그래프에 embeddedAssets가 없습니다.');
  const assets = value.embeddedAssets.map((asset) => ({
    ...asset,
    mimeType: asset.mimeType || 'image/png',
    dataUrl: asset.dataUrl || asset.data || '',
  }));
  const assetResult = validateAssets(assets);
  if (!assetResult.valid) return assetResult;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const nodesById = new Map();
  for (const node of sourceGraph.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || nodesById.has(node.id)) return fail('그래프 노드 id가 없거나 중복되었습니다.');
    nodesById.set(node.id, node);
  }
  const flowOut = new Map();
  for (const edge of sourceGraph.edges) {
    if (!isRecord(edge) || !isRecord(edge.from) || !isRecord(edge.to) || !nodesById.has(edge.from.nodeId) || !nodesById.has(edge.to.nodeId)) return fail('그래프 연결에서 존재하지 않는 노드를 참조합니다.');
    if (edge.from.port === 'flow' && edge.to.port === 'flow') {
      if (!flowOut.has(edge.from.nodeId)) flowOut.set(edge.from.nodeId, []);
      flowOut.get(edge.from.nodeId).push(edge.to.nodeId);
    } else if (edge.to.port !== 'alpha' || edge.from.port !== 'alpha' || nodesById.get(edge.from.nodeId).type !== 'AlphaOverLife' || nodesById.get(edge.to.nodeId).type !== 'SpriteRenderer') {
      return fail('이 로컬 미리보기는 flow와 AlphaOverLife → SpriteRenderer alpha 연결만 지원합니다.');
    }
  }
  const eventNodes = sourceGraph.nodes.filter((node) => node.type === 'Event' && node.params?.event === sourceGraph.event);
  if (eventNodes.length !== 1) return fail('그래프에는 event와 일치하는 Event 노드가 하나 있어야 합니다.');
  const spriteInstances = [];
  const visit = (nodeId, state, path) => {
    if (path.has(nodeId)) throw new Error('그래프에 순환 flow가 있습니다.');
    const node = nodesById.get(nodeId);
    if (!node) throw new Error('그래프 노드를 찾을 수 없습니다: ' + nodeId);
    const params = isRecord(node.params) ? node.params : {};
    const nextPath = new Set(path);
    nextPath.add(nodeId);
    const children = flowOut.get(nodeId) || [];
    if (node.type === 'Event') {
      for (const child of children) visit(child, state, nextPath);
      return;
    }
    if (node.type === 'Delay') {
      if (!finiteIn(params.seconds, 0, 6)) throw new Error(node.id + '의 delay 값이 유효하지 않습니다.');
      const delayed = { ...state, start: state.start + params.seconds };
      for (const child of children) visit(child, delayed, nextPath);
      return;
    }
    if (node.type === 'Sequence') {
      const steps = Number.isInteger(params.steps) ? params.steps : children.length;
      const stepGap = Number.isFinite(params.stepGap) ? params.stepGap : 0.16;
      if (steps < 1 || steps > 32 || !finiteIn(stepGap, 0, 6) || !children.length) throw new Error(node.id + '의 Sequence 설정이 유효하지 않습니다.');
      for (let index = 0; index < steps; index += 1) {
        visit(children[index % children.length], { ...state, start: state.start + index * stepGap }, nextPath);
      }
      return;
    }
    if (node.type === 'AlphaOverLife') {
      if (!finiteIn(params.from, 0, 1) || !finiteIn(params.to, 0, 1) || !['linear', 'easeOut', 'easeInOut'].includes(params.curve)) throw new Error(node.id + '의 AlphaOverLife 설정이 유효하지 않습니다.');
      const faded = { ...state, alphaFrom: params.from, alphaTo: params.to, alphaCurve: params.curve };
      for (const child of children) visit(child, faded, nextPath);
      return;
    }
    if (node.type === 'Transform') {
      const transformed = {
        ...state,
        anchor: SPRITE_ANCHORS.has(params.anchor) ? params.anchor : state.anchor,
        x: state.x + (Number(params.x) || 0),
        y: state.y + (Number(params.y) || 0),
        scaleX: state.scaleX * (Number(params.scaleX) || 1),
        scaleY: state.scaleY * (Number(params.scaleY) || 1),
        rotation: state.rotation + (Number(params.rotation) || 0),
      };
      for (const child of children) visit(child, transformed, nextPath);
      return;
    }
    if (node.type === 'SpriteRenderer') {
      const asset = assetById.get(params.assetId);
      if (!asset) throw new Error(node.id + '이 embeddedAssets에 없는 PNG를 참조합니다.');
      const frame = Number.isInteger(params.frame) ? params.frame : 0;
      const frames = isRecord(asset.frames) ? asset.frames : {};
      const count = Number.isInteger(frames.count) ? frames.count : 1;
      const startOffset = Number.isFinite(params.startOffset) ? params.startOffset : 0;
      const start = state.start + startOffset;
      const layerDuration = Number(params.duration);
      if (frame < 0 || frame >= count || !finiteIn(params.scaleX, 0.1, 4) || !finiteIn(params.scaleY, 0.1, 4) || !finiteIn(startOffset, 0, 6) || !finiteIn(layerDuration, 0.04, 6) || !finiteIn(start, 0, duration) || start + layerDuration > duration + 0.001) throw new Error(node.id + '의 SpriteRenderer 시간 또는 크기 값이 범위를 벗어났습니다.');
      const alphaEdge = sourceGraph.edges.find((edge) => edge.to?.nodeId === node.id && edge.to?.port === 'alpha');
      const alphaNode = alphaEdge ? nodesById.get(alphaEdge.from.nodeId) : null;
      if (alphaEdge && alphaNode?.type !== 'AlphaOverLife') throw new Error(node.id + '의 alpha 입력은 AlphaOverLife에서 연결되어야 합니다.');
      const alphaParams = alphaNode?.type === 'AlphaOverLife' ? alphaNode.params : null;
      spriteInstances.push({
        sourceId: node.id,
        assetId: params.assetId,
        frame,
        anchor: SPRITE_ANCHORS.has(params.anchor) ? params.anchor : (state.anchor || 'impact'),
        x: state.x + (Number(params.x) || 0),
        y: state.y + (Number(params.y) || 0),
        scaleX: (Number(params.scaleX) || 0.18) * state.scaleX,
        scaleY: (Number(params.scaleY) || 0.18) * state.scaleY,
        rotation: (Number(params.rotation) || 0) + state.rotation,
        sorting: Number.isFinite(params.sorting) ? params.sorting : 0,
        start,
        duration: layerDuration,
        visible: params.visible !== false,
        alphaFrom: alphaParams?.from ?? state.alphaFrom ?? 1,
        alphaTo: alphaParams?.to ?? state.alphaTo ?? 1,
        alphaCurve: alphaParams?.curve ?? state.alphaCurve ?? 'linear',
      });
      return;
    }
    throw new Error('VFX Lab 프레임 그래프에서 지원하지 않는 노드입니다: ' + String(node.type || '(type 없음)'));
  };
  try {
    visit(eventNodes[0].id, { start: 0, anchor: 'impact', x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alphaFrom: 1, alphaTo: 1, alphaCurve: 'linear' }, new Set());
  } catch (error) {
    return fail(error.message || 'VFX Lab 프레임 그래프를 변환하지 못했습니다.');
  }
  if (!spriteInstances.length) return fail('그래프에서 SpriteRenderer를 찾지 못했습니다.');
  if (spriteInstances.length > 16) return fail('한 그래프에 SpriteRenderer 인스턴스를 16개 넘게 넣을 수 없습니다.');
  spriteInstances.sort((a, b) => a.sorting - b.sorting || a.start - b.start);
  const spriteNodes = spriteInstances.map((instance, index) => ({
    id: 'sprite-' + String(index + 1).padStart(2, '0'),
    type: 'Sprite',
    params: {
      assetId: instance.assetId,
      frame: instance.frame,
      fps: 0,
      loop: false,
      anchor: instance.anchor,
      x: instance.x,
      y: instance.y,
      scaleX: instance.scaleX,
      scaleY: instance.scaleY,
      rotation: instance.rotation,
      sorting: instance.sorting,
      start: instance.start,
      duration: instance.duration,
      visible: instance.visible,
      alphaFrom: instance.alphaFrom,
      alphaTo: instance.alphaTo,
      alphaCurve: instance.alphaCurve,
    },
  }));
  const composite = { id: 'sprite-composite', type: 'Blend', params: { mode: 'normal' } };
  const output = { id: 'output', type: 'Output', params: { alpha: 'soft', threshold: 0.01 } };
  const links = spriteNodes.map((node, index) => ({ f: node.id, t: composite.id, p: index }));
  links.push({ f: composite.id, t: output.id, p: 0 });
  const anchors = isRecord(value.anchors) ? value.anchors : {};
  const normalizedAnchors = {
    source: validPoint(anchors.source) ? anchors.source : { x: 0.32, y: 0.62 },
    impact: validPoint(anchors.impact) ? anchors.impact : { x: 0.68, y: 0.63 },
  };
  normalizedAnchors.midpoint = { x: (normalizedAnchors.source.x + normalizedAnchors.impact.x) / 2, y: (normalizedAnchors.source.y + normalizedAnchors.impact.y) / 2 };
  normalizedAnchors.target = normalizedAnchors.impact;
  return {
    valid: true,
    value: {
      format: 'pxf.graph@1',
      name,
      settings: { size: 256, frames: Math.max(1, Math.min(180, Math.ceil(duration * 30))), fps: 30, loop: false },
      anchors: normalizedAnchors,
      referenceCharacterHeightPx: finiteIn(value.referenceCharacterHeightPx, 24, 240) ? value.referenceCharacterHeightPx : 64,
      assets,
      nodes: [...spriteNodes, composite, output],
      links,
    },
  };
}

function validPoint(value) {
  return isRecord(value) && finiteIn(value.x, 0, 1) && finiteIn(value.y, 0, 1);
}

async function decodeImageElement(dataUrl) {
  if (typeof Image !== 'function') throw new Error('이 브라우저에서는 PNG 프레임을 디코딩할 수 없습니다.');
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('내장 PNG 프레임을 디코딩하지 못했습니다.'));
    image.src = dataUrl;
  });
}

function renderGraphFrame(graph, frameIndex) {
  const size = graph.settings.size;
  const frame = Math.max(0, Math.min(graph.settings.frames - 1, Math.floor(frameIndex)));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const inputs = new Map();
  for (const link of graph.links) {
    if (!inputs.has(link.t)) inputs.set(link.t, []);
    inputs.get(link.t).push({ port: link.p, from: link.f });
  }
  for (const links of inputs.values()) links.sort((a, b) => a.port - b.port);
  const cache = new Map();
  const stack = new Set();

  const evaluate = (id) => {
    if (cache.has(id)) return cache.get(id);
    if (stack.has(id)) throw new Error('그래프에 순환 링크가 있습니다.');
    const node = nodeById.get(id);
    if (!node) throw new Error(`노드를 찾을 수 없습니다: ${id}`);
    stack.add(id);
    const sources = (inputs.get(id) || []).map((edge) => evaluate(edge.from));
    let result;
    switch (node.type) {
      case 'Shape': result = renderShape(node, size, frame); break;
      case 'Stroke': result = renderStroke(node, size, frame); break;
      case 'Particles': result = renderParticles(node, size, frame, graph.settings.fps); break;
      case 'Blend': result = mergeCanvases(sources, size, node.params.mode || 'max', node.params.opacity); break;
      case 'Repeat': result = repeatCanvas(sources[0], size, node.params); break;
      case 'Glow': result = glowCanvas(sources[0], size, node.params); break;
      case 'Palette': result = paletteCanvas(sources[0], size, node.params, frame); break;
      case 'Tint': result = tintCanvas(sources[0], size, node.params, frame); break;
      case 'Sprite': result = renderSprite(node, graph, size, frame); break;
      case 'Output': result = outputCanvas(sources[0], size, node.params); break;
      default: throw new Error(`지원하지 않는 노드입니다: ${node.type}`);
    }
    stack.delete(id);
    cache.set(id, result);
    return result;
  };

  const output = graph.nodes.find((node) => node.type === 'Output');
  return evaluate(output.id);
}

function graphDescription(graph) {
  const seconds = graph.settings.frames / graph.settings.fps;
  return `${graph.settings.size}×${graph.settings.size} · ${graph.settings.frames}프레임 · ${graph.settings.fps}fps · ${seconds.toFixed(2)}초`;
}

function validateNodeParams(node) {
  const p = node.params;
  switch (node.type) {
    case 'Shape':
      if (p.shape != null && !SHAPE_TYPES.has(p.shape)) return `지원하지 않는 Shape 모양: ${p.shape}`;
      if (p.points != null && (!Number.isInteger(p.points) || p.points < 3 || p.points > 24)) return 'points는 3–24 정수여야 합니다.';
      if (p.colors != null && !validColors(p.colors, 16)) return 'colors는 2–16개의 6자리 HEX 색상 배열이어야 합니다.';
      break;
    case 'Stroke':
      if (p.width != null && !finiteIn(p.width, 0.1, 64)) return 'width는 0.1–64 사이여야 합니다.';
      if (p.from != null && !finiteIn(p.from, 0, 1)) return 'from은 0–1 사이여야 합니다.';
      if (p.to != null && !finiteIn(p.to, 0, 1)) return 'to는 0–1 사이여야 합니다.';
      break;
    case 'Particles':
      if (p.count != null && (!Number.isInteger(p.count) || p.count < 0 || p.count > 100)) return 'count는 0–100 정수여야 합니다.';
      if (p.life != null && !finiteIn(p.life, 0.01, 20)) return 'life는 0.01–20초 사이여야 합니다.';
      if (p.pshape != null && !SHAPE_TYPES.has(p.pshape) && p.pshape !== 'streak') return `지원하지 않는 particle 모양: ${p.pshape}`;
      break;
    case 'Repeat':
      if (p.count != null && (!Number.isInteger(p.count) || p.count < 1 || p.count > 32)) return 'count는 1–32 정수여야 합니다.';
      break;
    case 'Blend':
      if (p.mode != null && !BLEND_MODES.has(p.mode)) return `지원하지 않는 Blend 모드: ${p.mode}`;
      break;
    case 'Glow':
      if (p.radius != null && !finiteIn(p.radius, 0, 24)) return 'radius는 0–24 사이여야 합니다.';
      if (p.strength != null && !finiteIn(p.strength, 0, 2)) return 'strength는 0–2 사이여야 합니다.';
      break;
    case 'Palette':
      if (!validColors(p.colors, 16)) return 'colors는 2–16개의 6자리 HEX 색상 배열이어야 합니다.';
      break;
    case 'Tint':
      if (p.color != null && (typeof p.color !== 'string' || !COLOR_PATTERN.test(p.color))) return 'color는 6자리 HEX 색상이어야 합니다.';
      break;
    case 'Sprite':
      if (typeof p.assetId !== 'string' || !p.assetId) return 'assetId가 필요합니다.';
      if (!Number.isInteger(p.frame) || p.frame < 0 || p.frame > 4095) return 'frame은 0–4095 정수여야 합니다.';
      if (p.fps != null && !finiteIn(p.fps, 0, 60)) return 'fps는 0–60 사이여야 합니다.';
      if (p.loop != null && typeof p.loop !== 'boolean') return 'loop은 true 또는 false여야 합니다.';
      if (!SPRITE_ANCHORS.has(p.anchor)) return 'anchor는 source, impact, midpoint, target 중 하나여야 합니다.';
      if (!finiteIn(p.scaleX, 0.1, 4) || !finiteIn(p.scaleY, 0.1, 4)) return 'scaleX와 scaleY는 0.1–4 사이여야 합니다.';
      if (!finiteIn(p.rotation, -3600, 3600) || !finiteIn(p.sorting, -1000, 1000)) return 'rotation 또는 sorting 값이 범위를 벗어났습니다.';
      if (!finiteIn(p.start, 0, 6) || !finiteIn(p.duration, 0.04, 6)) return 'start와 duration 값이 범위를 벗어났습니다.';
      if (typeof p.visible !== 'boolean') return 'visible은 true 또는 false여야 합니다.';
      if (!finiteIn(p.alphaFrom, 0, 1) || !finiteIn(p.alphaTo, 0, 1)) return 'alphaFrom과 alphaTo는 0–1 사이여야 합니다.';
      if (!['linear', 'easeOut', 'easeInOut'].includes(p.alphaCurve)) return 'alphaCurve는 linear, easeOut, easeInOut 중 하나여야 합니다.';
      break;
  }
  return '';
}

function renderSprite(node, graph, size, frame) {
  const canvas = makeCanvas(size);
  const p = node.params;
  const runtime = graphAssetRuntime.get(graph);
  const image = runtime?.images.get(p.assetId);
  const asset = runtime?.records.get(p.assetId);
  if (!image || !asset || p.visible === false) return canvas;
  const time = frame / graph.settings.fps;
  const start = finite(p.start, 0);
  const duration = Math.max(.04, finite(p.duration, .3));
  if (time < start || time > start + duration) return canvas;
  const progress = clamp((time - start) / duration, 0, 1);
  const ease = sampleEase(progress, p.alphaCurve);
  const alpha = clamp(finite(p.alphaFrom, 1) + (finite(p.alphaTo, 1) - finite(p.alphaFrom, 1)) * ease, 0, 1);
  if (alpha <= .001) return canvas;
  const frames = isRecord(asset.frames) ? asset.frames : {};
  const frameWidth = Number.isInteger(frames.width) ? frames.width : asset.width;
  const frameHeight = Number.isInteger(frames.height) ? frames.height : asset.height;
  const columns = Number.isInteger(frames.columns) ? frames.columns : 1;
  const rows = Number.isInteger(frames.rows) ? frames.rows : 1;
  const count = Number.isInteger(frames.count) ? frames.count : columns * rows;
  const firstFrame = clamp(finite(p.frame, 0), 0, count - 1);
  const fps = clamp(finite(p.fps, finite(frames.fps, 0)), 0, 60);
  const frameOffset = Math.floor(progress * duration * fps);
  const loops = p.loop == null ? frames.loop === true : p.loop === true;
  const frameIndex = loops ? (firstFrame + frameOffset) % count : clamp(firstFrame + frameOffset, 0, count - 1);
  const sx = (frameIndex % columns) * frameWidth;
  const sy = Math.floor(frameIndex / columns) * frameHeight;
  const anchor = resolveGraphAnchor(graph, p.anchor);
  const referenceScale = clamp(finite(graph.referenceCharacterHeightPx, 64) / 64, .375, 3.75);
  const introScale = .86 + sampleEase(progress, 'easeOut') * .14;
  const worldScale = (size / 960) * referenceScale * introScale;
  const width = frameWidth * worldScale * finite(p.scaleX, .18);
  const height = frameHeight * worldScale * finite(p.scaleY, .18);
  const pivot = isRecord(asset.pivot) ? asset.pivot : { x: .5, y: .5 };
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.globalAlpha = alpha * (.96 - progress * .38);
  ctx.translate(anchor.x * size + finite(p.x, 0) * size, anchor.y * size + finite(p.y, 0) * size);
  ctx.rotate((finite(p.rotation, 0) * Math.PI) / 180);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, frameWidth, frameHeight, -pivot.x * width, -pivot.y * height, width, height);
  ctx.restore();
  return canvas;
}

function resolveGraphAnchor(graph, name) {
  const anchors = isRecord(graph.anchors) ? graph.anchors : {};
  if (name === 'midpoint' && validPoint(anchors.source) && validPoint(anchors.impact)) {
    return { x: (anchors.source.x + anchors.impact.x) / 2, y: (anchors.source.y + anchors.impact.y) / 2 };
  }
  if (name === 'target') name = 'impact';
  return validPoint(anchors[name]) ? anchors[name] : { x: .5, y: .5 };
}

function sampleEase(value, curve) {
  const t = clamp(value, 0, 1);
  if (curve === 'easeOut') return 1 - (1 - t) ** 2;
  if (curve === 'easeInOut') return t < .5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  return t;
}

function renderShape(node, size, frame) {
  const p = node.params;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const radius = clamp(evalValue(p.size, frame, 10), 0, size * .49);
  const intensity = clamp(evalValue(p.intensity, frame, 1), 0, 1);
  if (radius <= .01 || intensity <= .001) return canvas;
  ctx.save();
  ctx.translate(clamp(finite(p.x, .5), 0, 1) * size, clamp(finite(p.y, .5), 0, 1) * size);
  ctx.rotate((finite(p.rot, 0) * Math.PI) / 180);
  ctx.globalAlpha = intensity;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  const shape = p.shape || 'circle';
  if (shape === 'ring') {
    ctx.lineWidth = clamp(radius * finite(p.size2, .12), 1, Math.max(1, radius * .7));
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(.1, radius - ctx.lineWidth / 2), 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape === 'circle') {
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
  } else if (shape === 'ellipse') {
    ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * clamp(finite(p.size2, .55), .1, 1), 0, 0, Math.PI * 2); ctx.fill();
  } else if (shape === 'square') {
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  } else if (shape === 'cross') {
    const width = Math.max(1, radius * clamp(finite(p.size2, .22), .08, .7));
    ctx.fillRect(-width / 2, -radius, width, radius * 2);
    ctx.fillRect(-radius, -width / 2, radius * 2, width);
  } else {
    const count = shape === 'diamond' ? 4 : shape === 'burst' ? clamp(Math.round(finite(p.points, 8)), 4, 24) * 2 : clamp(Math.round(finite(p.points, 5)), 3, 24) * 2;
    const innerRadius = shape === 'diamond' ? radius * clamp(finite(p.size2, .55), .15, .95) : radius * clamp(finite(p.size2, .25), .05, .95);
    ctx.beginPath();
    for (let index = 0; index < count; index += 1) {
      const angle = -Math.PI / 2 + (index * Math.PI) / count;
      const r = index % 2 === 0 ? radius : innerRadius;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  return canvas;
}

function renderStroke(node, size, frame) {
  const p = node.params;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const points = [
    { x: finite(p.x0, .5), y: finite(p.y0, .5) },
    { x: finite(p.x1, .5), y: finite(p.y1, .42) },
    { x: finite(p.x2, .5), y: finite(p.y2, .31) },
    { x: finite(p.x3, .5), y: finite(p.y3, .22) },
  ];
  const start = clamp(finite(p.from, 0), 0, 1);
  const end = clamp(finite(p.to, 1), start, 1);
  const steps = 32;
  const samplePoint = (t) => {
    const mt = 1 - t;
    return {
      x: (mt ** 3) * points[0].x + 3 * (mt ** 2) * t * points[1].x + 3 * mt * (t ** 2) * points[2].x + (t ** 3) * points[3].x,
      y: (mt ** 3) * points[0].y + 3 * (mt ** 2) * t * points[1].y + 3 * mt * (t ** 2) * points[2].y + (t ** 3) * points[3].y,
    };
  };
  const intensity = clamp(evalValue(p.intensity, frame, 1), 0, 1);
  if (intensity <= .001 || end - start <= .001) return canvas;
  const count = Math.max(1, Math.ceil((end - start) * steps));
  const width = clamp(finite(p.width, 2), .25, size * .4);
  const taper = clamp(finite(p.taper, 0), 0, 1);
  const valueAt = (t) => {
    const a = clamp(finite(p.vA, 1), 0, 1);
    const m = clamp(finite(p.vM, .7), 0, 1);
    const b = clamp(finite(p.vB, 0), 0, 1);
    return t < .55 ? a + (m - a) * (t / .55) : m + (b - m) * ((t - .55) / .45);
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let index = 0; index < count; index += 1) {
    const t0 = start + ((end - start) * index) / count;
    const t1 = start + ((end - start) * (index + 1)) / count;
    const a = samplePoint(t0); const b = samplePoint(t1);
    const mid = (t0 + t1) / 2;
    const localProgress = (mid - start) / (end - start);
    ctx.globalAlpha = intensity * valueAt(mid);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(.25, width * (1 - taper * localProgress));
    ctx.beginPath(); ctx.moveTo(a.x * size, a.y * size); ctx.lineTo(b.x * size, b.y * size); ctx.stroke();
  }
  return canvas;
}

function renderParticles(node, size, frame, fps) {
  const p = node.params;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const seconds = frame / fps;
  const start = Math.max(0, finite(p.start, 0));
  const life = Math.max(.01, finite(p.life, .5));
  const variation = clamp(finite(p.lifeVar, 0), 0, .95);
  const count = clamp(Math.round(finite(p.count, 8)), 0, 100);
  const seed = Math.floor(finite(p.seed, 1));
  const originX = clamp(finite(p.x, .5), 0, 1) * size;
  const originY = clamp(finite(p.y, .5), 0, 1) * size;
  const areaW = clamp(finite(p.aw, 0), 0, size);
  const areaH = clamp(finite(p.ah, areaW), 0, size);
  const baseSpeed = finite(p.speed, 1);
  const speedVar = clamp(finite(p.speedVar, 0), 0, .95);
  const drag = clamp(finite(p.drag, 0), 0, 1);
  const sizeA = clamp(finite(p.sizeA, 2), 0, size * .2);
  const sizeB = clamp(finite(p.sizeB, .5), 0, size * .2);
  const brightness = clamp(finite(p.bright, 1), 0, 2);
  const particleShape = p.pshape || 'diamond';

  for (let index = 0; index < count; index += 1) {
    const random = seededRandom(seed + index * 997);
    const randomLife = life * (1 + (random() * 2 - 1) * variation);
    const age = seconds - start;
    if (age < 0 || age >= randomLife) continue;
    const normalizedAge = age / randomLife;
    const areaAngle = random() * Math.PI * 2;
    const areaRadius = String(p.area || 'point').toLowerCase() === 'circle' ? Math.sqrt(random()) : String(p.area || 'point').toLowerCase() === 'ring' ? .65 + random() * .35 : random();
    const sx = originX + Math.cos(areaAngle) * areaW * .5 * areaRadius;
    const sy = originY + Math.sin(areaAngle) * areaH * .5 * areaRadius;
    let direction = areaAngle;
    const directionMode = p.dirMode || 'outward';
    if (directionMode === 'random') direction = random() * Math.PI * 2;
    else if (directionMode === 'up') direction = -Math.PI / 2 + (random() - .5) * .7;
    else if (directionMode === 'down') direction = Math.PI / 2 + (random() - .5) * .7;
    else if (directionMode === 'inward') direction += Math.PI;
    const speed = baseSpeed * (1 + (random() * 2 - 1) * speedVar) * fps;
    const travel = speed * age * (1 - drag * .45 * normalizedAge);
    const x = sx + Math.cos(direction) * travel;
    const y = sy + Math.sin(direction) * travel;
    const particleSize = Math.max(.25, sizeA + (sizeB - sizeA) * normalizedAge);
    const fade = p.fade === 'in' ? normalizedAge : p.fade === 'inOut' ? Math.sin(Math.PI * normalizedAge) : 1 - normalizedAge;
    const alpha = clamp(fade * brightness, 0, 1);
    if (x < -particleSize || y < -particleSize || x > size + particleSize || y > size + particleSize || alpha <= .001) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(direction);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    if (particleShape === 'streak') {
      const stretch = clamp(finite(p.stretch, 2), 1, 16);
      ctx.fillRect(-particleSize * stretch, -Math.max(.5, particleSize * .22), particleSize * stretch * 2, Math.max(1, particleSize * .44));
    } else if (particleShape === 'ring') {
      ctx.lineWidth = Math.max(.6, particleSize * .35);
      ctx.beginPath(); ctx.arc(0, 0, particleSize, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.stroke();
    } else if (particleShape === 'circle') {
      ctx.beginPath(); ctx.arc(0, 0, particleSize, 0, Math.PI * 2); ctx.fill();
    } else if (particleShape === 'square') {
      ctx.fillRect(-particleSize, -particleSize, particleSize * 2, particleSize * 2);
    } else {
      ctx.beginPath(); ctx.moveTo(0, -particleSize); ctx.lineTo(particleSize * .72, 0); ctx.lineTo(0, particleSize); ctx.lineTo(-particleSize * .72, 0); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  return canvas;
}

function mergeCanvases(canvases, size, mode, opacityValue) {
  const output = makeCanvas(size);
  if (!canvases.length) return output;
  const ctx = output.getContext('2d', { willReadFrequently: true });
  const result = ctx.createImageData(size, size);
  const opacity = clamp(finite(opacityValue, 1), 0, 1);
  for (const canvas of canvases) {
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
    for (let index = 0; index < src.length; index += 4) {
      const sa = (src[index + 3] / 255) * opacity;
      if (sa <= 0) continue;
      const da = result.data[index + 3] / 255;
      if (mode === 'max') {
        if (sa >= da) {
          result.data[index] = src[index]; result.data[index + 1] = src[index + 1]; result.data[index + 2] = src[index + 2];
          result.data[index + 3] = Math.round(Math.max(sa, da) * 255);
        }
      } else if (mode === 'add') {
        const outA = Math.min(1, da + sa);
        for (let channel = 0; channel < 3; channel += 1) {
          const premul = result.data[index + channel] / 255 * da + src[index + channel] / 255 * sa;
          result.data[index + channel] = outA ? Math.round(Math.min(1, premul / outA) * 255) : 0;
        }
        result.data[index + 3] = Math.round(outA * 255);
      } else if (mode === 'screen') {
        const outA = 1 - (1 - da) * (1 - sa);
        for (let channel = 0; channel < 3; channel += 1) result.data[index + channel] = Math.max(result.data[index + channel], src[index + channel]);
        result.data[index + 3] = Math.round(outA * 255);
      } else {
        const outA = sa + da * (1 - sa);
        for (let channel = 0; channel < 3; channel += 1) {
          const premul = src[index + channel] / 255 * sa + result.data[index + channel] / 255 * da * (1 - sa);
          result.data[index + channel] = outA ? Math.round(premul / outA * 255) : 0;
        }
        result.data[index + 3] = Math.round(outA * 255);
      }
    }
  }
  ctx.putImageData(result, 0, 0);
  return output;
}

function repeatCanvas(source, size, params) {
  const output = makeCanvas(size);
  if (!source) return output;
  const ctx = output.getContext('2d');
  const count = clamp(Math.round(finite(params.count, 2)), 1, 32);
  const px = clamp(finite(params.px, .5), 0, 1) * size;
  const py = clamp(finite(params.py, .5), 0, 1) * size;
  const angle0 = finite(params.angle0, 0);
  const angleStep = finite(params.angleStep, 360 / count);
  for (let index = 0; index < count; index += 1) {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(((angle0 + angleStep * index) * Math.PI) / 180);
    ctx.drawImage(source, -px, -py);
    ctx.restore();
  }
  return output;
}

function glowCanvas(source, size, params) {
  const output = makeCanvas(size);
  if (!source) return output;
  const ctx = output.getContext('2d');
  const radius = clamp(finite(params.radius, 2), 0, 24);
  const strength = clamp(finite(params.strength, .5), 0, 2);
  if (radius > 0 && strength > 0) {
    ctx.save();
    ctx.filter = `blur(${radius}px)`;
    ctx.globalAlpha = Math.min(1, strength);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(source, 0, 0); ctx.restore();
  return output;
}

function paletteCanvas(source, size, params, frame) {
  const output = makeCanvas(size);
  if (!source) return output;
  const colors = params.colors.map(hexToRgb);
  const src = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size);
  const pixels = src.data;
  const cutoff = clamp(finite(params.cutoff, 0), 0, 1);
  const opacity = clamp(evalValue(params.opacity, frame, 1), 0, 1);
  const key = params.key || 'alpha';
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha < cutoff || alpha <= 0) { pixels[index + 3] = 0; continue; }
    const luminance = (pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722) / 255;
    const value = clamp(key === 'luminance' || key === 'luma' ? luminance : alpha, 0, .999999);
    const colorIndex = Math.min(colors.length - 1, Math.floor(value * colors.length));
    const color = colors[colorIndex];
    pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2];
    pixels[index + 3] = Math.round(alpha * opacity * 255);
  }
  output.getContext('2d').putImageData(src, 0, 0);
  return output;
}

function tintCanvas(source, size, params, frame) {
  const output = makeCanvas(size);
  if (!source) return output;
  const image = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size);
  const amount = clamp(evalValue(params.amount, frame, 0), 0, 1);
  const opacity = clamp(evalValue(params.opacity, frame, 1), 0, 1);
  const tint = typeof params.color === 'string' && COLOR_PATTERN.test(params.color) ? hexToRgb(params.color) : [255, 255, 255];
  for (let index = 0; index < image.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) image.data[index + channel] = Math.round(image.data[index + channel] * (1 - amount) + tint[channel] * amount);
    image.data[index + 3] = Math.round(image.data[index + 3] * opacity);
  }
  output.getContext('2d').putImageData(image, 0, 0);
  return output;
}

function outputCanvas(source, size, params) {
  const output = makeCanvas(size);
  if (!source) return output;
  const image = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size);
  const threshold = clamp(finite(params.threshold, 0), 0, 1) * 255;
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] < threshold) image.data[index] = params.alpha === 'hard' ? 0 : Math.round(image.data[index] * image.data[index] / Math.max(1, threshold));
  }
  output.getContext('2d').putImageData(image, 0, 0);
  return output;
}

function evalValue(value, frame, fallback) {
  if (!isRecord(value) || !Array.isArray(value.k) || !value.k.length) return finite(value, fallback);
  const keys = value.k;
  if (frame <= keys[0][0]) return keys[0][1];
  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index]; const right = keys[index + 1];
    if (frame <= right[0]) {
      const span = Math.max(.000001, right[0] - left[0]);
      let t = clamp((frame - left[0]) / span, 0, 1);
      const easing = right[2] || 'linear';
      if (easing === 'out' || easing === 'out2') t = 1 - (1 - t) ** 2;
      else if (easing === 'out3') t = 1 - (1 - t) ** 3;
      else if (easing === 'in') t = t * t;
      else if (easing === 'in3') t = t ** 3;
      else if (easing === 'inOut') t = t < .5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      return left[1] + (right[1] - left[1]) * t;
    }
  }
  return keys[keys.length - 1][1];
}

function validateKeyframes(value) {
  if (!isRecord(value)) return true;
  if (Array.isArray(value.k)) {
    if (value.k.length > 128) return false;
    let last = -Infinity;
    for (const key of value.k) {
      if (!Array.isArray(key) || key.length < 2 || key.length > 3 || !Number.isFinite(key[0]) || !Number.isFinite(key[1]) || key[0] <= last) return false;
      if (key[2] != null && typeof key[2] !== 'string') return false;
      last = key[0];
    }
    return true;
  }
  return Object.values(value).every(validateKeyframes);
}

function graphVariationSignature(graph) {
  const normalizedNodes = graph.nodes.map((node) => {
    const params = structuredCloneSafe(node.params);
    if (node.type === 'Palette') {
      delete params.colors;
      delete params.cutoff;
      delete params.mode;
      delete params.key;
    }
    if (node.type === 'Tint') {
      delete params.color;
      delete params.amount;
    }
    return { originalId: node.id, type: node.type, params };
  }).map((node) => ({ ...node, key: stableStringify({ type: node.type, params: node.params }) }));
  normalizedNodes.sort((a, b) => a.key.localeCompare(b.key));
  const idMap = new Map();
  const occurrences = new Map();
  normalizedNodes.forEach((node) => {
    const ordinal = occurrences.get(node.key) || 0;
    occurrences.set(node.key, ordinal + 1);
    idMap.set(node.originalId, `${node.key}#${ordinal}`);
    delete node.originalId;
  });
  const links = graph.links.map((link) => ({ from: idMap.get(link.f), to: idMap.get(link.t), port: link.p }))
    .sort((a, b) => `${a.from}:${a.port}:${a.to}`.localeCompare(`${b.from}:${b.port}:${b.to}`));
  return stableStringify({ settings: graph.settings, nodes: normalizedNodes.map(({ type, params }) => ({ type, params })), links });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value)); }

function seededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  return canvas;
}
function isRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function finite(value, fallback) { return Number.isFinite(value) ? value : fallback; }
function finiteIn(value, low, high) { return Number.isFinite(value) && value >= low && value <= high; }
function clamp(value, low, high) { return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low)); }
function validColors(value, max) { return Array.isArray(value) && value.length >= 2 && value.length <= max && value.every((color) => typeof color === 'string' && COLOR_PATTERN.test(color)); }
function hexToRgb(hex) { return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)); }

  globalThis.PXFGraphRenderer = Object.freeze({ validateGraph, validateGraphDocument, prepareGraphAssets, releaseGraphAssets, renderGraphFrame, graphDescription });
})();
