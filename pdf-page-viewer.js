// ============================================================
// ตัวเรนเดอร์หน้า PDF ด้วย pdf.js ใช้ร่วมกันทั้งฝั่งพนักงาน (วางกรอบลายเซ็น)
// และฝั่งผู้บริหาร (ดูตำแหน่งที่ต้องเซ็น) — ไม่รู้เรื่องกรอบลายเซ็นเลย
// รู้แค่เรื่องโหลดไฟล์ + เรนเดอร์หน้าเป็น canvas + เปลี่ยนหน้า
// ============================================================

import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

/**
 * fileEls: { viewport, canvas, indicator, prevBtn, nextBtn }
 * items: [item, ...] เรียงตามลำดับที่จะรวมไฟล์แล้ว (item คืออะไรก็ได้ ขึ้นกับ getBytes)
 * getBytes: (item) => Promise<ArrayBuffer> — ดึงไบต์ของไฟล์นั้น (fetch จาก URL หรืออ่านจาก
 *   File object ในเครื่องก็ได้ แล้วแต่บริบทที่เรียกใช้)
 * onPageRendered: (index, canvasWidth, canvasHeight) => void — เรียกทุกครั้งหลังเรนเดอร์หน้าเสร็จ
 *
 * คืนค่า handle: { getPageCount, getCurrentIndex, goToPage(idx), getCanvasSize }
 */
export async function createPdfPageViewer(fileEls, items, getBytes, onPageRendered) {
  const flatPages = [];
  for (const item of items) {
    const bytes = await getBytes(item);
    const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      flatPages.push({ pdfDoc, pageNumInFile: p });
    }
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
  };
}
