// ============================================================
// ตัวแก้ไขตำแหน่งกรอบลายเซ็น — ใช้ฝั่งพนักงานตอนสร้างคำขอ (index.html)
// วางกรอบลายเซ็นแยกต่างหากให้ผู้อนุมัติแต่ละคนได้ ก่อนส่งลิงก์ไปให้เซ็น
// ใช้เฉพาะคำขอที่ไม่ใช่ประเภทค่าใช้จ่าย (ซึ่งไม่มีเส้นเซ็นตายตัวในฟอร์ม)
// ============================================================

import { createPdfPageViewer } from "./pdf-page-viewer.js";

const MIN_BOX_W = 60;
const MIN_BOX_H = 30;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * fileEls: { viewport, canvas, indicator, prevBtn, nextBtn }
 * boxEls: { box, boxImg, boxLabel, resizeHandle }
 * localFiles: [File, ...] ไฟล์ PDF ที่แนบไว้ในเครื่อง (ยังไม่อัปโหลด) เรียงตามลำดับ
 *   ที่จะถูกอัปโหลด/รวมกันตอนส่งคำขอ (index ในอาเรย์นี้ = sort_order)
 *
 * คืนค่า handle:
 *   selectApprover(key, label) — สลับไปวาง/แก้ตำแหน่งของผู้อนุมัติคนนี้
 *   setPreviewImage(dataUrl) — อัปเดตรูปตัวอย่างในกรอบของคนที่กำลังเลือกอยู่
 *   getPlacement(key) — คืนตำแหน่งที่วางไว้ของคนนั้น (หรือ null ถ้ายังไม่เคยเลือก)
 *   getAllKeys() — รายชื่อ key ทั้งหมดที่เคยวางตำแหน่งแล้ว
 */
export async function createSigBoxEditor(fileEls, boxEls, localFiles) {
  const placements = new Map(); // key -> { pageIndex, xRatio, yRatio, wRatio, hRatio, previewUrl }
  let activeKey = null;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let approverIndex = 0;

  function applyBoxStyle() {
    const p = placements.get(activeKey);
    if (!p) return;
    boxEls.box.style.left = p.xRatio * canvasWidth + "px";
    boxEls.box.style.top = p.yRatio * canvasHeight + "px";
    boxEls.box.style.width = p.wRatio * canvasWidth + "px";
    boxEls.box.style.height = p.hRatio * canvasHeight + "px";
    boxEls.boxImg.style.backgroundImage = p.previewUrl ? `url(${p.previewUrl})` : "none";
    boxEls.boxLabel.style.display = p.previewUrl ? "none" : "block";
    boxEls.boxLabel.textContent = p.label || "ลายเซ็น";
  }

  const getBytes = (file) => file.arrayBuffer();
  const viewer = await createPdfPageViewer(fileEls, localFiles, getBytes, (index, w, h) => {
    canvasWidth = w;
    canvasHeight = h;
    const p = activeKey && placements.get(activeKey);
    const visible = p && p.pageIndex === index;
    boxEls.box.style.display = visible ? "flex" : "none";
    if (visible) applyBoxStyle();
  });

  function defaultPlacementFor(label) {
    const stagger = (approverIndex % 3) * 0.09;
    approverIndex += 1;
    return {
      pageIndex: viewer.getPageCount() - 1,
      xRatio: 0.32,
      yRatio: clamp(0.62 + stagger, 0, 0.8),
      wRatio: 0.34,
      hRatio: 0.12,
      previewUrl: null,
      label,
    };
  }

  async function selectApprover(key, label) {
    activeKey = key;
    if (!placements.has(key)) {
      placements.set(key, defaultPlacementFor(label));
    } else {
      placements.get(key).label = label;
    }
    const p = placements.get(key);
    if (viewer.getCurrentIndex() !== p.pageIndex) {
      await viewer.goToPage(p.pageIndex);
    } else {
      boxEls.box.style.display = "flex";
      applyBoxStyle();
    }
  }

  function setPreviewImage(dataUrl) {
    if (!activeKey) return;
    const p = placements.get(activeKey);
    if (!p) return;
    p.previewUrl = dataUrl;
    applyBoxStyle();
  }

  // ---------- ลาก/ย่อ-ขยาย เฉพาะกรอบของคนที่กำลังเลือกอยู่ ----------

  let dragging = false;
  let dStartX = 0;
  let dStartY = 0;
  let dStartLeft = 0;
  let dStartTop = 0;

  boxEls.box.addEventListener("pointerdown", (e) => {
    if (e.target === boxEls.resizeHandle || !activeKey) return;
    const p = placements.get(activeKey);
    dragging = true;
    dStartX = e.clientX;
    dStartY = e.clientY;
    dStartLeft = p.xRatio * canvasWidth;
    dStartTop = p.yRatio * canvasHeight;
    boxEls.box.setPointerCapture(e.pointerId);
  });
  boxEls.box.addEventListener("pointermove", (e) => {
    if (!dragging || !activeKey) return;
    const p = placements.get(activeKey);
    const boxW = p.wRatio * canvasWidth;
    const boxH = p.hRatio * canvasHeight;
    const newLeft = clamp(dStartLeft + (e.clientX - dStartX), 0, canvasWidth - boxW);
    const newTop = clamp(dStartTop + (e.clientY - dStartY), 0, canvasHeight - boxH);
    p.xRatio = newLeft / canvasWidth;
    p.yRatio = newTop / canvasHeight;
    applyBoxStyle();
  });
  const stopDrag = () => (dragging = false);
  boxEls.box.addEventListener("pointerup", stopDrag);
  boxEls.box.addEventListener("pointercancel", stopDrag);

  let resizing = false;
  let rStartX = 0;
  let rStartY = 0;
  let rStartW = 0;
  let rStartH = 0;

  boxEls.resizeHandle.addEventListener("pointerdown", (e) => {
    if (!activeKey) return;
    const p = placements.get(activeKey);
    resizing = true;
    rStartX = e.clientX;
    rStartY = e.clientY;
    rStartW = p.wRatio * canvasWidth;
    rStartH = p.hRatio * canvasHeight;
    boxEls.resizeHandle.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  boxEls.resizeHandle.addEventListener("pointermove", (e) => {
    if (!resizing || !activeKey) return;
    const p = placements.get(activeKey);
    const left = p.xRatio * canvasWidth;
    const top = p.yRatio * canvasHeight;
    const newW = clamp(rStartW + (e.clientX - rStartX), MIN_BOX_W, canvasWidth - left);
    const newH = clamp(rStartH + (e.clientY - rStartY), MIN_BOX_H, canvasHeight - top);
    p.wRatio = newW / canvasWidth;
    p.hRatio = newH / canvasHeight;
    applyBoxStyle();
    e.stopPropagation();
  });
  const stopResize = (e) => {
    resizing = false;
    e.stopPropagation();
  };
  boxEls.resizeHandle.addEventListener("pointerup", stopResize);
  boxEls.resizeHandle.addEventListener("pointercancel", stopResize);

  return {
    selectApprover,
    setPreviewImage,
    getPlacement: (key) => {
      const p = placements.get(key);
      if (!p) return null;
      return { pageIndex: p.pageIndex, xRatio: p.xRatio, yRatio: p.yRatio, wRatio: p.wRatio, hRatio: p.hRatio };
    },
    getAllKeys: () => [...placements.keys()],
  };
}
