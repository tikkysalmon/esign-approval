// ============================================================
// ตัวเรนเดอร์หน้า PDF ด้วย pdf.js ใช้ร่วมกันทั้งฝั่งพนักงาน (วางกรอบลายเซ็น)
// และฝั่งผู้บริหาร (ดูตำแหน่งที่ต้องเซ็น) — ไม่รู้เรื่องกรอบลายเซ็นเลย
// รู้แค่เรื่องโหลดไฟล์ + เรนเดอร์หน้าเป็น canvas + เปลี่ยนหน้า
// ============================================================

import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

// PDF บางไฟล์ (เช่นที่ export จาก Odoo) เข้ารหัสสระอำแบบแยกส่วน (นิคหิต + สระอา)
// แทนที่จะเป็นอักขระ "ำ" ตัวเดียว — ต้องแปลงให้ตรงกันก่อนค้นหาข้อความ ไม่งั้นหาไม่เจอ
function normalizeThai(s) {
  return s.replace(/ํา/g, "ำ");
}

/**
 * ลองหาเลขที่เอกสาร (เช่น "P00001" จาก "ใบสั่งซื้อ #P00001") จากหน้าแรกของไฟล์
 * ใช้รูปแบบเลข "#XXXXX" หรือ "PO XXXXX" เป็นตัวจับ — ไม่พึ่งข้อความภาษาไทยที่หน้าฟอร์ม
 * แต่ละบริษัทเขียนไม่เหมือนกัน (และบางทีสระผสมเพี้ยนตอนแตกไฟล์) จึงมั่นใจกว่า
 * bytes: ArrayBuffer ของไฟล์ PDF
 * คืนค่า string (เช่น "P00001") หรือ null ถ้าหาไม่เจอ
 */
export async function detectDocumentNumber(bytes) {
  try {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");

    let m = text.match(/#\s*([A-Za-z0-9][\w\-\/]{2,})/);
    if (m) return m[1];
    m = text.match(/\bPO[\s:#-]*([0-9][\w\-\/]{3,})/i);
    if (m) return "PO" + m[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * ค้นหาข้อความ (เช่น "ผู้อนุมัติ") บนหน้าที่ระบุ แล้วแนะนำตำแหน่งกรอบลายเซ็นที่ควร
 * วางไว้ "เหนือ" ข้อความนั้น (แบบฟอร์มส่วนใหญ่จะมีเส้นให้เซ็นอยู่เหนือป้ายกำกับ)
 * คืนค่า { xRatio, yRatio, wRatio, hRatio } หรือ null ถ้าไม่เจอข้อความนั้นในหน้า
 */
async function findTextAnchorRatio(pdfDoc, pageNumInFile, searchText) {
  const page = await pdfDoc.getPage(pageNumInFile);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  let normText = "";
  const ranges = [];
  for (const item of content.items) {
    const s = normalizeThai(item.str);
    const start = normText.length;
    normText += s;
    ranges.push({ item, start, end: normText.length });
  }
  const target = normalizeThai(searchText);
  const idx = normText.indexOf(target);
  if (idx === -1) return null;
  const range = ranges.find((r) => idx >= r.start && idx < r.end) || ranges.find((r) => idx <= r.start);
  if (!range) return null;

  const { transform, width: labelWidth, height: labelHeight } = range.item;
  const labelX = transform[4];
  const labelY = transform[5]; // พิกัด PDF (จุดกำเนิดล่างซ้าย, y ชี้ขึ้น)
  const approxLabelHeight = labelHeight || transform[0] || 12;

  const boxWidth = 150;
  const boxHeight = 42;
  const gapAboveLabel = 6;

  const boxBottomY = labelY + approxLabelHeight + gapAboveLabel;
  const boxTopY = boxBottomY + boxHeight;
  const boxCenterX = labelX + labelWidth / 2;
  const boxLeftX = boxCenterX - boxWidth / 2;

  const pageWidth = viewport.width;
  const pageHeight = viewport.height;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  return {
    xRatio: clamp(boxLeftX / pageWidth, 0, 1 - boxWidth / pageWidth),
    yRatio: clamp((pageHeight - boxTopY) / pageHeight, 0, 1 - boxHeight / pageHeight),
    wRatio: boxWidth / pageWidth,
    hRatio: boxHeight / pageHeight,
  };
}

/**
 * fileEls: { viewport, canvas, indicator, prevBtn, nextBtn }
 * items: [item, ...] เรียงตามลำดับที่จะรวมไฟล์แล้ว (item คืออะไรก็ได้ ขึ้นกับ getBytes)
 * getBytes: (item) => Promise<ArrayBuffer> — ดึงไบต์ของไฟล์นั้น (fetch จาก URL หรืออ่านจาก
 *   File object ในเครื่องก็ได้ แล้วแต่บริบทที่เรียกใช้)
 * onPageRendered: (index, canvasWidth, canvasHeight) => void — เรียกทุกครั้งหลังเรนเดอร์หน้าเสร็จ
 *
 * คืนค่า handle: { getPageCount, getCurrentIndex, goToPage(idx), getCanvasSize,
 *   getFileCount, getLastPageIndexOfFile(fileIndex), getFileIndexOfPage(pageIndex) }
 */
export async function createPdfPageViewer(fileEls, items, getBytes, onPageRendered) {
  const flatPages = []; // { pdfDoc, pageNumInFile, fileIndex }
  const lastPageIndexPerFile = []; // lastPageIndexPerFile[fileIndex] = flatIndex ของหน้าสุดท้ายของไฟล์นั้น
  for (let fileIndex = 0; fileIndex < items.length; fileIndex++) {
    const bytes = await getBytes(items[fileIndex]);
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      flatPages.push({ pdfDoc, pageNumInFile: p, fileIndex });
    }
    lastPageIndexPerFile.push(flatPages.length - 1);
  }

  let currentIndex = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;

  async function renderPage(index) {
    currentIndex = Math.max(0, Math.min(flatPages.length - 1, index));
    const { pdfDoc, pageNumInFile } = flatPages[currentIndex];
    const page = await pdfDoc.getPage(pageNumInFile);
    const containerWidth = fileEls.viewport.clientWidth || 500;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = containerWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = fileEls.canvas;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    fileEls.viewport.style.height = viewport.height + "px";
    canvasWidth = viewport.width;
    canvasHeight = viewport.height;

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    fileEls.indicator.textContent = `หน้า ${currentIndex + 1} / ${flatPages.length}`;
    if (onPageRendered) onPageRendered(currentIndex, canvasWidth, canvasHeight);
  }

  fileEls.prevBtn.addEventListener("click", () => renderPage(currentIndex - 1));
  fileEls.nextBtn.addEventListener("click", () => renderPage(currentIndex + 1));

  await renderPage(0);

  return {
    getPageCount: () => flatPages.length,
    getCurrentIndex: () => currentIndex,
    goToPage: (idx) => renderPage(idx),
    getCanvasSize: () => ({ width: canvasWidth, height: canvasHeight }),
    getFileCount: () => items.length,
    getLastPageIndexOfFile: (fileIndex) => lastPageIndexPerFile[fileIndex],
    getFileIndexOfPage: (pageIndex) => flatPages[pageIndex]?.fileIndex,
    findTextAnchorOnPage: (pageIndex, searchText) => {
      const p = flatPages[pageIndex];
      if (!p) return Promise.resolve(null);
      return findTextAnchorRatio(p.pdfDoc, p.pageNumInFile, searchText);
    },
  };
}
