// ============================================================
// ตัวแก้ไขตำแหน่งกรอบลายเซ็น — ใช้ฝั่งพนักงานตอนสร้างคำขอ (index.html)
// วางกรอบลายเซ็นแยกต่างหากให้ผู้อนุมัติแต่ละคนได้ ก่อนส่งลิงก์ไปให้เซ็น
// ผู้อนุมัติ 1 คน เซ็นครั้งเดียว แต่ลายเซ็นจะไปปรากฏบน "ทุกไฟล์" ที่แนบมา —
// จึงสร้างกรอบให้อัตโนมัติ 1 กรอบ/1 ไฟล์ (ที่หน้าสุดท้ายของแต่ละไฟล์) ทันทีที่
// เลือกผู้อนุมัติคนนั้น แล้วให้ปรับตำแหน่งแต่ละกรอบเพิ่มเติมได้ถ้าต้องการ
// ใช้เฉพาะคำขอที่ไม่ใช่ประเภทค่าใช้จ่าย (ซึ่งไม่มีเส้นเซ็นตายตัวในฟอร์ม)
// ============================================================

import { createPdfPageViewer } from "./pdf-page-viewer.js";

const MIN_BOX_W = 60;
const MIN_BOX_H = 30;
const DEFAULT_RATIO = { xRatio: 0.32, yRatio: 0.78, wRatio: 0.34, hRatio: 0.12 };

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
 *   selectApprover(key, label) — สลับไปดู/แก้ตำแหน่งกรอบทั้งหมดของผู้อนุมัติคนนี้
 *     (สร้างกรอบเริ่มต้นให้อัตโนมัติ 1 กรอบ/ไฟล์ ถ้ายังไม่เคยเลือกมาก่อน)
 *   setPreviewImage(dataUrl) — อัปเดตรูปตัวอย่างในกรอบของหน้าที่กำลังแสดงอยู่
 *   getPlacements(key) — คืนอาเรย์ตำแหน่งกรอบทั้งหมดของคนนั้น (หรือ null ถ้ายังไม่เคยเลือก)
 *   getFileCount() — จำนวนไฟล์ทั้งหมด (ใช้เช็คว่าวางกรอบครบทุกไฟล์ยัง)
 */
export async function createSigBoxEditor(fileEls, boxEls, localFiles) {
  // key -> [{ fileIndex, pageIndex, xRatio, yRatio, wRatio, hRatio, previewUrl, label }, ...]
  const placementsByApprover = new Map();
  let activeKey = null;
  let canvasWidth = 0;
  let canvasHeight = 0;

  function boxForCurrentPage() {
    if (!activeKey) return null;
    const list = placementsByApprover.get(activeKey);
    if (!list) return null;
    return list.find((b) => b.pageIndex === viewer.getCurrentIndex()) || null;
  }

  function applyBoxStyle() {
    const b = boxForCurrentPage();
    if (!b) {
      boxEls.box.style.display = "none";
      return;
    }
    boxEls.box.style.display = "flex";
    boxEls.box.style.left = b.xRatio * canvasWidth + "px";
    boxEls.box.style.top = b.yRatio * canvasHeight + "px";
    boxEls.box.style.width = b.wRatio * canvasWidth + "px";
    boxEls.box.style.height = b.hRatio * canvasHeight + "px";
    boxEls.boxImg.style.backgroundImage = b.previewUrl ? `url(${b.previewUrl})` : "none";
    boxEls.boxLabel.style.display = b.previewUrl ? "none" : "block";
    boxEls.boxLabel.textContent = b.label || "ลายเซ็น";
  }

  const viewer = await createPdfPageViewer(fileEls, localFiles, (f) => f.arrayBuffer(), (index, w, h) => {
    canvasWidth = w;
    canvasHeight = h;
    applyBoxStyle();
  });

  async function selectApprover(key, label, detectText) {
    activeKey = key;
    if (!placementsByApprover.has(key)) {
      const list = [];
      for (let fileIndex = 0; fileIndex < viewer.getFileCount(); fileIndex++) {
        const pageIndex = viewer.getLastPageIndexOfFile(fileIndex);
        // ลองหาป้ายกำกับ (เช่น "ผู้อนุมัติ") ในเอกสารก่อน ถ้าเจอใช้ตำแหน่งเหนือป้าย
        // นั้นเป็นค่าเริ่มต้นเลย แม่นกว่าเดากลางหน้า — ถ้าไม่เจอค่อย fallback
        const detected = detectText ? await viewer.findTextAnchorOnPage(pageIndex, detectText) : null;
        const ratio = detected || DEFAULT_RATIO;
        list.push({
          fileIndex,
          pageIndex,
          xRatio: ratio.xRatio,
          yRatio: ratio.yRatio,
          wRatio: ratio.wRatio,
          hRatio: ratio.hRatio,
          previewUrl: null,
          label,
        });
      }
      placementsByApprover.set(key, list);
    } else {
      placementsByApprover.get(key).forEach((b) => (b.label = label));
    }
    // พาไปหน้าสุดท้ายของไฟล์แรก จะได้เห็นกรอบทันที
    const firstBoxPage = placementsByApprover.get(key)[0]?.pageIndex ?? 0;
    if (viewer.getCurrentIndex() !== firstBoxPage) {
      await viewer.goToPage(firstBoxPage);
    } else {
      applyBoxStyle();
    }
  }

  // เอาตำแหน่ง/ขนาดของกรอบที่กำลังดูอยู่ (ของคนที่เลือกอยู่) ไปใช้กับทุกไฟล์ของคน
  // เดียวกันเลย — ช่วยตอนมีเอกสารเยอะๆ (สิบกว่าไฟล์) ไม่ต้องปรับทีละไฟล์
  function applyCurrentBoxToAllFiles() {
    const source = boxForCurrentPage();
    if (!source || !activeKey) return 0;
    const list = placementsByApprover.get(activeKey);
    let count = 0;
    list.forEach((b) => {
      if (b === source) return;
      b.xRatio = source.xRatio;
      b.yRatio = source.yRatio;
      b.wRatio = source.wRatio;
      b.hRatio = source.hRatio;
      count++;
    });
    return count;
  }

  function setPreviewImage(dataUrl) {
    const b = boxForCurrentPage();
    if (!b) return;
    b.previewUrl = dataUrl;
    // อัปเดตรูปตัวอย่างทุกกรอบของคนนี้ (จะได้เห็นว่าลายเซ็นเดียวกันไปอยู่ทุกไฟล์)
    placementsByApprover.get(activeKey).forEach((box) => (box.previewUrl = dataUrl));
    applyBoxStyle();
  }

  // ---------- ลาก/ย่อ-ขยาย เฉพาะกรอบของหน้าที่กำลังแสดงอยู่ (ของคนที่เลือกอยู่) ----------

  let dragging = false;
  let dStartX = 0;
  let dStartY = 0;
  let dStartLeft = 0;
  let dStartTop = 0;

  boxEls.box.addEventListener("pointerdown", (e) => {
    if (e.target === boxEls.resizeHandle) return;
    const b = boxForCurrentPage();
    if (!b) return;
    dragging = true;
    dStartX = e.clientX;
    dStartY = e.clientY;
    dStartLeft = b.xRatio * canvasWidth;
    dStartTop = b.yRatio * canvasHeight;
    boxEls.box.setPointerCapture(e.pointerId);
  });
  boxEls.box.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const b = boxForCurrentPage();
    if (!b) return;
    const boxW = b.wRatio * canvasWidth;
    const boxH = b.hRatio * canvasHeight;
    const newLeft = clamp(dStartLeft + (e.clientX - dStartX), 0, canvasWidth - boxW);
    const newTop = clamp(dStartTop + (e.clientY - dStartY), 0, canvasHeight - boxH);
    b.xRatio = newLeft / canvasWidth;
    b.yRatio = newTop / canvasHeight;
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
    const b = boxForCurrentPage();
    if (!b) return;
    resizing = true;
    rStartX = e.clientX;
    rStartY = e.clientY;
    rStartW = b.wRatio * canvasWidth;
    rStartH = b.hRatio * canvasHeight;
    boxEls.resizeHandle.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  boxEls.resizeHandle.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const b = boxForCurrentPage();
    if (!b) return;
    const left = b.xRatio * canvasWidth;
    const top = b.yRatio * canvasHeight;
    const newW = clamp(rStartW + (e.clientX - rStartX), MIN_BOX_W, canvasWidth - left);
    const newH = clamp(rStartH + (e.clientY - rStartY), MIN_BOX_H, canvasHeight - top);
    b.wRatio = newW / canvasWidth;
    b.hRatio = newH / canvasHeight;
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
    applyCurrentBoxToAllFiles,
    getPlacements: (key) => {
      const list = placementsByApprover.get(key);
      if (!list) return null;
      return list.map((b) => ({
        pageIndex: b.pageIndex,
        xRatio: b.xRatio,
        yRatio: b.yRatio,
        wRatio: b.wRatio,
        hRatio: b.hRatio,
      }));
    },
    getFileCount: () => viewer.getFileCount(),
    goToFileLastPage: (fileIndex) => viewer.goToPage(viewer.getLastPageIndexOfFile(fileIndex)),
  };
}
