// ============================================================
// กรอบลายเซ็นที่ลาก-ย้าย-ย่อ-ขยายได้ วางทับบนหน้าเอกสาร PDF
// ใช้เฉพาะคำขอที่ไม่ใช่ประเภทค่าใช้จ่าย (ใบเสนอราคา ฯลฯ) ซึ่งไม่มีเส้นเซ็นตายตัว
// เรนเดอร์หน้า PDF ด้วย pdf.js แล้ววางกรอบ HTML ทับด้วยพิกัดสัดส่วน (0-1)
// ของขนาดหน้า เพื่อให้แปลงกลับเป็นตำแหน่งจริงตอนแสตมป์ด้วย pdf-lib ได้ง่าย
// ============================================================

import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

const MIN_BOX_W = 60;
const MIN_BOX_H = 30;
const DEFAULT_RATIO = { xRatio: 0.32, yRatio: 0.78, wRatio: 0.34, hRatio: 0.12 };

let flatPages = []; // [{ pdfDoc, pageNumInFile }]
let currentIndex = 0;
let box = { ...DEFAULT_RATIO };
let els = null;
let canvasWidth = 0;
let canvasHeight = 0;

/**
 * files: [{ storage_path, sort_order }] เรียงตาม sort_order แล้ว
 * getFileUrl: (storage_path) => publicUrl
 */
export async function initSigBox(fileEls, files, getFileUrl) {
  els = fileEls;
  flatPages = [];
  for (const f of files) {
    const bytes = await fetch(getFileUrl(f.storage_path)).then((r) => r.arrayBuffer());
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      flatPages.push({ pdfDoc, pageNumInFile: p });
    }
  }
  currentIndex = flatPages.length - 1; // เริ่มที่หน้าสุดท้าย (ปกติเป็นที่เซ็น)
  box = { ...DEFAULT_RATIO };

  els.prevBtn.addEventListener("click", () => changePage(-1));
  els.nextBtn.addEventListener("click", () => changePage(1));
  wireDrag();
  wireResize();

  await renderCurrentPage();
}

async function changePage(delta) {
  const next = currentIndex + delta;
  if (next < 0 || next >= flatPages.length) return;
  currentIndex = next;
  await renderCurrentPage();
}

async function renderCurrentPage() {
  const { pdfDoc, pageNumInFile } = flatPages[currentIndex];
  const page = await pdfDoc.getPage(pageNumInFile);
  const containerWidth = els.viewport.clientWidth || 500;
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = containerWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const canvas = els.canvas;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  els.viewport.style.height = viewport.height + "px";
  canvasWidth = viewport.width;
  canvasHeight = viewport.height;

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  els.indicator.textContent = `หน้า ${currentIndex + 1} / ${flatPages.length}`;
  applyBoxStyle();
}

function applyBoxStyle() {
  els.box.style.left = box.xRatio * canvasWidth + "px";
  els.box.style.top = box.yRatio * canvasHeight + "px";
  els.box.style.width = box.wRatio * canvasWidth + "px";
  els.box.style.height = box.hRatio * canvasHeight + "px";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function wireDrag() {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  els.box.addEventListener("pointerdown", (e) => {
    if (e.target === els.resizeHandle) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = box.xRatio * canvasWidth;
    startTop = box.yRatio * canvasHeight;
    els.box.setPointerCapture(e.pointerId);
  });
  els.box.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const boxW = box.wRatio * canvasWidth;
    const boxH = box.hRatio * canvasHeight;
    const newLeft = clamp(startLeft + (e.clientX - startX), 0, canvasWidth - boxW);
    const newTop = clamp(startTop + (e.clientY - startY), 0, canvasHeight - boxH);
    box.xRatio = newLeft / canvasWidth;
    box.yRatio = newTop / canvasHeight;
    applyBoxStyle();
  });
  const stopDrag = () => (dragging = false);
  els.box.addEventListener("pointerup", stopDrag);
  els.box.addEventListener("pointercancel", stopDrag);
}

function wireResize() {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  els.resizeHandle.addEventListener("pointerdown", (e) => {
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = box.wRatio * canvasWidth;
    startH = box.hRatio * canvasHeight;
    els.resizeHandle.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  els.resizeHandle.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const left = box.xRatio * canvasWidth;
    const top = box.yRatio * canvasHeight;
    const newW = clamp(startW + (e.clientX - startX), MIN_BOX_W, canvasWidth - left);
    const newH = clamp(startH + (e.clientY - startY), MIN_BOX_H, canvasHeight - top);
    box.wRatio = newW / canvasWidth;
    box.hRatio = newH / canvasHeight;
    applyBoxStyle();
    e.stopPropagation();
  });
  const stopResize = (e) => {
    resizing = false;
    e.stopPropagation();
  };
  els.resizeHandle.addEventListener("pointerup", stopResize);
  els.resizeHandle.addEventListener("pointercancel", stopResize);
}

export function setSigBoxPreview(dataUrl) {
  if (!els) return;
  els.boxImg.style.backgroundImage = `url(${dataUrl})`;
  els.boxLabel.style.display = "none";
}

export function getSigBoxPlacement() {
  return {
    pageIndex: currentIndex,
    xRatio: box.xRatio,
    yRatio: box.yRatio,
    wRatio: box.wRatio,
    hRatio: box.hRatio,
  };
}
