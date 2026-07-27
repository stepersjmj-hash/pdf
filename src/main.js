import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

/* ────────────────────────────────────────────
   상태
   ──────────────────────────────────────────── */
const state = {
  srcDocs: [],   // { pdfjsDoc, bytes, libDoc(lazy) }
  pages: [],     // { src, idx, rot, checked, annos: [] }
  current: 0,
  zoom: 1,
  tool: 'select',
  selectedAnno: null,
  fileName: 'document.pdf',
};

// anno 형태:
// { type:'text', fx, fy, text, size, color }         size: 페이지 포인트 단위
// { type:'rect'|'hl', fx, fy, fw, fh, color }        모두 회전된 표시 기준 비율 좌표

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('file-input'), appendInput: $('append-input'),
  dropzone: $('dropzone'), viewer: $('viewer'), pageWrap: $('page-wrap'),
  canvas: $('page-canvas'), overlay: $('overlay'),
  sidebar: $('sidebar'), thumbs: $('thumbs'), toolbar: $('toolbar'),
  zoomLabel: $('zoom-label'), pageLabel: $('page-label'),
  toast: $('toast'), checkAll: $('check-all'),
  annoColor: $('anno-color'), annoSize: $('anno-size'),
};

/* ────────────────────────────────────────────
   유틸
   ──────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2500);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function mod360(d) { return ((d % 360) + 360) % 360; }

async function getLibDoc(src) {
  if (!src.libDoc) src.libDoc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
  return src.libDoc;
}

async function totalRotation(pageEntry) {
  const page = await state.srcDocs[pageEntry.src].pdfjsDoc.getPage(pageEntry.idx + 1);
  return mod360(page.rotate + pageEntry.rot);
}

/* 표시 좌표(회전 반영, 포인트 단위, 좌상단 원점) → PDF 사용자 좌표(회전 전, 좌하단 원점) */
function displayToPdf(dx, dy, W, H, R) {
  switch (R) {
    case 90:  return { x: dy, y: dx };
    case 180: return { x: W - dx, y: dy };
    case 270: return { x: W - dy, y: H - dx };
    default:  return { x: dx, y: H - dy };
  }
}

/* ────────────────────────────────────────────
   파일 열기 / 병합
   ──────────────────────────────────────────── */
async function loadSource(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf).slice();
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  state.srcDocs.push({ pdfjsDoc, bytes, libDoc: null });
  return { srcIndex: state.srcDocs.length - 1, numPages: pdfjsDoc.numPages };
}

async function openFile(file) {
  try {
    state.srcDocs = []; state.pages = []; state.current = 0; state.selectedAnno = null;
    const { srcIndex, numPages } = await loadSource(file);
    for (let i = 0; i < numPages; i++) {
      state.pages.push({ src: srcIndex, idx: i, rot: 0, checked: false, annos: [] });
    }
    state.fileName = file.name.replace(/\.pdf$/i, '') || 'document';
    els.dropzone.classList.add('hidden');
    els.viewer.classList.remove('hidden');
    els.sidebar.classList.remove('hidden');
    els.toolbar.classList.remove('hidden');
    ['btn-append', 'btn-extract', 'btn-save'].forEach((id) => { $(id).disabled = false; });
    await fitWidth();
    await rebuildThumbs();
    await renderCurrent();
    toast(`"${file.name}" 열림 (${numPages}쪽)`);
  } catch (e) {
    console.error(e);
    toast('PDF를 열 수 없습니다. 파일이 손상되었거나 암호로 보호되어 있을 수 있습니다.');
  }
}

async function appendFile(file) {
  try {
    const { srcIndex, numPages } = await loadSource(file);
    for (let i = 0; i < numPages; i++) {
      state.pages.push({ src: srcIndex, idx: i, rot: 0, checked: false, annos: [] });
    }
    await rebuildThumbs();
    updatePageLabel();
    toast(`"${file.name}" ${numPages}쪽이 뒤에 추가되었습니다`);
  } catch (e) {
    console.error(e);
    toast('PDF를 추가할 수 없습니다.');
  }
}

/* ────────────────────────────────────────────
   렌더링 (본문)
   ──────────────────────────────────────────── */
let renderSeq = 0;

async function fitWidth() {
  if (!state.pages.length) return;
  const entry = state.pages[state.current];
  const page = await state.srcDocs[entry.src].pdfjsDoc.getPage(entry.idx + 1);
  const vp = page.getViewport({ scale: 1, rotation: mod360(page.rotate + entry.rot) });
  const avail = els.viewer.clientWidth - 64;
  state.zoom = Math.min(1.6, Math.max(0.3, avail / vp.width));
}

async function renderCurrent() {
  if (!state.pages.length) return;
  const seq = ++renderSeq;
  const entry = state.pages[state.current];
  const page = await state.srcDocs[entry.src].pdfjsDoc.getPage(entry.idx + 1);
  const rotation = mod360(page.rotate + entry.rot);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: state.zoom * dpr, rotation });
  if (seq !== renderSeq) return;

  const canvas = els.canvas;
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const cssW = vp.width / dpr, cssH = vp.height / dpr;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  els.pageWrap.style.width = cssW + 'px';
  els.pageWrap.style.height = cssH + 'px';

  // intent:'print' — rAF에 의존하지 않아 백그라운드 탭에서도 렌더링이 완료됨
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
  if (seq !== renderSeq) return;

  renderOverlay();
  updatePageLabel();
  els.zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
}

function updatePageLabel() {
  els.pageLabel.textContent = state.pages.length
    ? `${state.current + 1} / ${state.pages.length}` : '- / -';
}

/* ────────────────────────────────────────────
   섬네일
   ──────────────────────────────────────────── */
async function rebuildThumbs() {
  els.thumbs.innerHTML = '';
  for (let i = 0; i < state.pages.length; i++) {
    els.thumbs.appendChild(makeThumbEl(i));
  }
  // 순차 렌더 (비동기, 실패 무시)
  for (let i = 0; i < state.pages.length; i++) {
    await renderThumbCanvas(i).catch(() => {});
  }
}

function makeThumbEl(i) {
  const entry = state.pages[i];
  const div = document.createElement('div');
  div.className = 'thumb' + (i === state.current ? ' current' : '');
  div.dataset.index = i;
  div.draggable = true;

  const canvas = document.createElement('canvas');
  div.appendChild(canvas);

  const foot = document.createElement('div');
  foot.className = 'thumb-foot';

  const left = document.createElement('span');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'thumb-check';
  check.checked = entry.checked;
  check.title = '추출할 페이지 선택';
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => { entry.checked = check.checked; });
  const num = document.createElement('span');
  num.className = 'thumb-num';
  num.textContent = ' ' + (i + 1);
  left.appendChild(check);
  left.appendChild(num);

  const actions = document.createElement('div');
  actions.className = 'thumb-actions';
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  actions.appendChild(mkBtn('↻', '오른쪽으로 회전', () => rotatePage(i, 90)));
  actions.appendChild(mkBtn('🗑', '페이지 삭제', () => deletePage(i)));

  foot.appendChild(left);
  foot.appendChild(actions);
  div.appendChild(foot);

  div.addEventListener('click', () => { goToPage(i); });

  // 드래그 순서 변경
  div.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(i));
    e.dataTransfer.effectAllowed = 'move';
  });
  div.addEventListener('dragover', (e) => { e.preventDefault(); div.classList.add('drag-over'); });
  div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
  div.addEventListener('drop', async (e) => {
    e.preventDefault();
    div.classList.remove('drag-over');
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const to = parseInt(div.dataset.index, 10);
    if (isNaN(from) || from === to) return;
    const currentEntry = state.pages[state.current];
    const [moved] = state.pages.splice(from, 1);
    state.pages.splice(to, 0, moved);
    state.current = state.pages.indexOf(currentEntry);
    await rebuildThumbs();
    updatePageLabel();
  });

  return div;
}

async function renderThumbCanvas(i) {
  const entry = state.pages[i];
  if (!entry) return;
  const el = els.thumbs.querySelector(`.thumb[data-index="${i}"] canvas`);
  if (!el) return;
  const page = await state.srcDocs[entry.src].pdfjsDoc.getPage(entry.idx + 1);
  const rotation = mod360(page.rotate + entry.rot);
  const vp1 = page.getViewport({ scale: 1, rotation });
  const scale = 140 / vp1.width;
  const vp = page.getViewport({ scale, rotation });
  el.width = Math.floor(vp.width);
  el.height = Math.floor(vp.height);
  await page.render({ canvasContext: el.getContext('2d'), viewport: vp, intent: 'print' }).promise;
}

function refreshThumbHighlights() {
  els.thumbs.querySelectorAll('.thumb').forEach((el) => {
    el.classList.toggle('current', parseInt(el.dataset.index, 10) === state.current);
  });
}

/* ────────────────────────────────────────────
   페이지 조작
   ──────────────────────────────────────────── */
async function goToPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  state.current = i;
  state.selectedAnno = null;
  refreshThumbHighlights();
  await renderCurrent();
}

function transformAnnosForRotation(entry, deltaCW) {
  // 표시 기준 비율 좌표를 회전에 맞춰 변환 (deltaCW: +90 또는 -90)
  for (const a of entry.annos) {
    if (a.type === 'text') {
      const { fx, fy } = a;
      if (deltaCW === 90) { a.fx = 1 - fy; a.fy = fx; }
      else { a.fx = fy; a.fy = 1 - fx; }
    } else {
      const { fx, fy, fw, fh } = a;
      if (deltaCW === 90) { a.fx = 1 - (fy + fh); a.fy = fx; }
      else { a.fx = fy; a.fy = 1 - (fx + fw); }
      a.fw = fh; a.fh = fw;
    }
  }
}

async function rotatePage(i, deltaCW) {
  const entry = state.pages[i];
  entry.rot = mod360(entry.rot + deltaCW);
  transformAnnosForRotation(entry, deltaCW === 90 ? 90 : -90);
  await renderThumbCanvas(i);
  if (i === state.current) await renderCurrent();
}

async function deletePage(i) {
  if (state.pages.length === 1) { toast('마지막 페이지는 삭제할 수 없습니다.'); return; }
  state.pages.splice(i, 1);
  if (state.current >= state.pages.length) state.current = state.pages.length - 1;
  else if (i < state.current) state.current--;
  await rebuildThumbs();
  await renderCurrent();
}

/* ────────────────────────────────────────────
   주석 오버레이
   ──────────────────────────────────────────── */
function renderOverlay() {
  const overlay = els.overlay;
  overlay.innerHTML = '';
  overlay.className = 'overlay tool-' + state.tool;
  const entry = state.pages[state.current];
  if (!entry) return;
  entry.annos.forEach((a, ai) => overlay.appendChild(makeAnnoEl(entry, a, ai)));
}

function makeAnnoEl(entry, a, ai) {
  const overlay = els.overlay;
  const W = overlay.clientWidth, H = overlay.clientHeight;
  const el = document.createElement('div');
  el.className = 'anno';
  el.dataset.ai = ai;

  if (a.type === 'text') {
    el.classList.add('anno-text');
    el.textContent = a.text;
    el.style.left = a.fx * 100 + '%';
    el.style.top = a.fy * 100 + '%';
    el.style.fontSize = a.size * state.zoom + 'px';
    el.style.color = a.color;
    el.style.fontFamily = '"Noto Sans KR", "Malgun Gothic", sans-serif';
  } else {
    el.style.left = a.fx * 100 + '%';
    el.style.top = a.fy * 100 + '%';
    el.style.width = a.fw * 100 + '%';
    el.style.height = a.fh * 100 + '%';
    if (a.type === 'rect') {
      el.classList.add('anno-rect');
      el.style.borderColor = a.color;
      el.style.borderWidth = Math.max(1, 2 * state.zoom) + 'px';
    } else {
      el.classList.add('anno-hl');
      el.style.background = a.color;
      el.style.opacity = '0.4';
    }
  }

  const del = document.createElement('button');
  del.className = 'anno-del';
  del.textContent = '✕';
  del.title = '삭제';
  del.addEventListener('mousedown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = entry.annos.indexOf(a);
    if (i >= 0) entry.annos.splice(i, 1);
    state.selectedAnno = null;
    renderOverlay();
  });
  el.appendChild(del);

  if (state.selectedAnno === a) el.classList.add('selected');

  // 선택 + 드래그 이동 (오버레이를 다시 만들지 않고 스타일만 갱신 — 더블클릭이 끊기지 않도록)
  el.addEventListener('mousedown', (e) => {
    if (state.tool !== 'select') return;
    if (el.getAttribute('contenteditable') === 'true') return;
    e.stopPropagation();
    e.preventDefault();
    const editing = els.overlay.querySelector('[contenteditable="true"]');
    if (editing && editing !== el) editing.blur();
    state.selectedAnno = a;
    els.overlay.querySelectorAll('.anno.selected').forEach((n) => n.classList.remove('selected'));
    el.classList.add('selected');
    const startX = e.clientX, startY = e.clientY;
    const origFx = a.fx, origFy = a.fy;
    const onMove = (ev) => {
      a.fx = origFx + (ev.clientX - startX) / W;
      a.fy = origFy + (ev.clientY - startY) / H;
      el.style.left = a.fx * 100 + '%';
      el.style.top = a.fy * 100 + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 텍스트 더블클릭 편집
  if (a.type === 'text') {
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startTextEdit(el, entry, a);
    });
  }

  return el;
}

function startTextEdit(el, entry, a) {
  // 편집 중에는 ✕ 버튼을 상자 밖으로 — innerText에 섞이지 않도록
  const delBtn = el.querySelector('.anno-del');
  if (delBtn) delBtn.remove();
  el.classList.remove('selected');
  el.setAttribute('contenteditable', 'true');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const finish = () => {
    el.removeAttribute('contenteditable');
    a.text = el.innerText.replace(/\n+$/, '');
    if (!a.text.trim()) {
      const i = entry.annos.indexOf(a);
      if (i >= 0) entry.annos.splice(i, 1);
      if (state.selectedAnno === a) state.selectedAnno = null;
      el.remove();
    } else {
      // 노드를 유지한 채 내용만 갱신 (다른 상호작용을 방해하지 않도록 전체 재렌더 안 함)
      el.textContent = a.text;
      if (delBtn) el.appendChild(delBtn);
    }
  };
  el.addEventListener('blur', finish, { once: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
    e.stopPropagation();
  });
}

/* 오버레이에서 도구 사용 (텍스트 추가 / 도형 그리기) */
els.overlay.addEventListener('mousedown', (e) => {
  const entry = state.pages[state.current];
  if (!entry) return;
  const overlay = els.overlay;

  // 텍스트 편집 중이면: 편집 상자 내부 클릭은 통과, 바깥 클릭은 편집 종료
  const editing = overlay.querySelector('[contenteditable="true"]');
  if (editing) {
    if (editing.contains(e.target)) return;
    editing.blur();
  }

  const rect = overlay.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;

  if (state.tool === 'select') {
    state.selectedAnno = null;
    overlay.querySelectorAll('.anno.selected').forEach((n) => n.classList.remove('selected'));
    return;
  }

  if (state.tool === 'text') {
    // mousedown 기본 동작(포커스 이동)을 막아야 편집 상자가 즉시 blur로 사라지지 않음
    e.preventDefault();
    const a = {
      type: 'text', fx, fy, text: '',
      size: parseInt(els.annoSize.value, 10),
      color: els.annoColor.value,
    };
    entry.annos.push(a);
    renderOverlay();
    const el = overlay.querySelector(`.anno[data-ai="${entry.annos.length - 1}"]`);
    if (el) startTextEdit(el, entry, a);
    return;
  }

  if (state.tool === 'rect' || state.tool === 'highlight') {
    const type = state.tool === 'rect' ? 'rect' : 'hl';
    const color = type === 'hl' ? '#ffe83d' : els.annoColor.value;
    const preview = document.createElement('div');
    preview.className = 'anno ' + (type === 'rect' ? 'anno-rect' : 'anno-hl');
    if (type === 'rect') {
      preview.style.borderColor = color;
      preview.style.borderWidth = '2px';
    } else {
      preview.style.background = color;
      preview.style.opacity = '0.4';
    }
    overlay.appendChild(preview);

    const onMove = (ev) => {
      const cx = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1);
      const cy = Math.min(Math.max((ev.clientY - rect.top) / rect.height, 0), 1);
      const x = Math.min(fx, cx), y = Math.min(fy, cy);
      const w = Math.abs(cx - fx), h = Math.abs(cy - fy);
      preview.style.left = x * 100 + '%';
      preview.style.top = y * 100 + '%';
      preview.style.width = w * 100 + '%';
      preview.style.height = h * 100 + '%';
      preview.dataset.geom = JSON.stringify({ x, y, w, h });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const geom = preview.dataset.geom ? JSON.parse(preview.dataset.geom) : null;
      preview.remove();
      if (geom && geom.w > 0.005 && geom.h > 0.005) {
        entry.annos.push({ type, fx: geom.x, fy: geom.y, fw: geom.w, fh: geom.h, color });
      }
      renderOverlay();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  const entry = state.pages[state.current];
  if (!entry || !state.selectedAnno) return;
  const i = entry.annos.indexOf(state.selectedAnno);
  if (i >= 0) {
    entry.annos.splice(i, 1);
    state.selectedAnno = null;
    renderOverlay();
  }
});

/* ────────────────────────────────────────────
   저장 / 추출 (pdf-lib)
   ──────────────────────────────────────────── */
let koreanFontBytes = null;
async function loadKoreanFont() {
  if (!koreanFontBytes) {
    const res = await fetch('/fonts/NotoSansKR-Regular.otf');
    if (!res.ok) throw new Error('font load failed');
    koreanFontBytes = await res.arrayBuffer();
  }
  return koreanFontBytes;
}

async function buildPdf(entries) {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);

  const needFont = entries.some((en) => en.annos.some((a) => a.type === 'text' && a.text.trim()));
  let font = null;
  if (needFont) {
    font = await out.embedFont(await loadKoreanFont(), { subset: true });
  }

  // 원본 문서별로 필요한 페이지를 한 번에 복사
  const copied = new Map(); // "src:idx" → PDFPage (복사본)
  for (const src of new Set(entries.map((en) => en.src))) {
    const libDoc = await getLibDoc(state.srcDocs[src]);
    const idxs = [...new Set(entries.filter((en) => en.src === src).map((en) => en.idx))];
    const pages = await out.copyPages(libDoc, idxs);
    idxs.forEach((idx, k) => copied.set(src + ':' + idx, pages[k]));
  }

  for (const en of entries) {
    let page = copied.get(en.src + ':' + en.idx);
    // 같은 페이지가 두 번 들어간 경우를 대비해 필요하면 다시 복사
    if (out.getPages().includes(page)) {
      const libDoc = await getLibDoc(state.srcDocs[en.src]);
      [page] = await out.copyPages(libDoc, [en.idx]);
    }
    out.addPage(page);

    const base = mod360(page.getRotation().angle);
    const R = mod360(base + en.rot);
    page.setRotation(degrees(R));

    const W = page.getWidth(), H = page.getHeight();      // 회전 전 크기
    const DW = R % 180 === 0 ? W : H;                      // 표시 기준 크기
    const DH = R % 180 === 0 ? H : W;

    for (const a of en.annos) {
      const color = hexToRgb(a.color);
      if (a.type === 'text') {
        if (!a.text.trim()) continue;
        const size = a.size;
        const lineH = size * 1.25;
        const ascent = size * 0.85;
        const lines = a.text.split('\n');
        lines.forEach((line, li) => {
          if (!line) return;
          const dx = a.fx * DW;
          const dy = a.fy * DH + li * lineH + ascent;
          const { x, y } = displayToPdf(dx, dy, W, H, R);
          page.drawText(line, { x, y, size, font, color, rotate: degrees(R) });
        });
      } else {
        const p1 = displayToPdf(a.fx * DW, a.fy * DH, W, H, R);
        const p2 = displayToPdf((a.fx + a.fw) * DW, (a.fy + a.fh) * DH, W, H, R);
        const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
        if (a.type === 'rect') {
          page.drawRectangle({ x, y, width: w, height: h, borderColor: color, borderWidth: 2 });
        } else {
          page.drawRectangle({ x, y, width: w, height: h, color, opacity: 0.4 });
        }
      }
    }
  }

  return out.save();
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function saveAll() {
  if (!state.pages.length) return;
  try {
    toast('PDF 생성 중...');
    const bytes = await buildPdf(state.pages);
    download(bytes, state.fileName + '_편집.pdf');
    toast('저장 완료! 다운로드를 확인하세요.');
  } catch (e) {
    console.error(e);
    toast('저장 중 오류가 발생했습니다.');
  }
}

async function extractChecked() {
  const selected = state.pages.filter((p) => p.checked);
  if (!selected.length) { toast('왼쪽 섬네일에서 추출할 페이지를 먼저 체크하세요.'); return; }
  try {
    toast('PDF 생성 중...');
    const bytes = await buildPdf(selected);
    download(bytes, state.fileName + `_${selected.length}쪽 추출.pdf`);
    toast(`${selected.length}쪽 추출 완료!`);
  } catch (e) {
    console.error(e);
    toast('추출 중 오류가 발생했습니다.');
  }
}

/* ────────────────────────────────────────────
   이벤트 연결
   ──────────────────────────────────────────── */
$('btn-open').addEventListener('click', () => els.fileInput.click());
$('btn-open-2').addEventListener('click', () => els.fileInput.click());
$('btn-append').addEventListener('click', () => els.appendInput.click());
$('btn-save').addEventListener('click', saveAll);
$('btn-extract').addEventListener('click', extractChecked);

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) openFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});
els.appendInput.addEventListener('change', () => {
  if (els.appendInput.files[0]) appendFile(els.appendInput.files[0]);
  els.appendInput.value = '';
});

// 드래그 앤 드롭으로 열기
['dragover', 'dragenter'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!els.dropzone.classList.contains('hidden')) els.dropzone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
  })
);
document.addEventListener('drop', (e) => {
  const file = [...(e.dataTransfer?.files || [])].find((f) => /\.pdf$/i.test(f.name));
  if (!file) return;
  if (state.pages.length) appendFile(file);
  else openFile(file);
});

// 도구 선택
document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tool = btn.dataset.tool;
    state.selectedAnno = null;
    renderOverlay();
  });
});

// 페이지 조작
$('btn-rotate-left').addEventListener('click', () => rotatePage(state.current, -90));
$('btn-rotate-right').addEventListener('click', () => rotatePage(state.current, 90));
$('btn-delete-page').addEventListener('click', () => deletePage(state.current));
$('btn-prev').addEventListener('click', () => goToPage(state.current - 1));
$('btn-next').addEventListener('click', () => goToPage(state.current + 1));

// 확대/축소
$('btn-zoom-in').addEventListener('click', async () => {
  state.zoom = Math.min(4, state.zoom * 1.2);
  await renderCurrent();
});
$('btn-zoom-out').addEventListener('click', async () => {
  state.zoom = Math.max(0.2, state.zoom / 1.2);
  await renderCurrent();
});

// 전체 선택
els.checkAll.addEventListener('change', () => {
  state.pages.forEach((p) => { p.checked = els.checkAll.checked; });
  els.thumbs.querySelectorAll('.thumb-check').forEach((c) => { c.checked = els.checkAll.checked; });
});

// 개발자 콘솔용 훅
window.__pdfApp = { state, buildPdf, rotatePage, deletePage, renderCurrent, renderOverlay, pdfjsLib };
