// ============================================================
// แสดงตำแหน่งกรอบลายเซ็นที่พนักงานวางไว้ล่วงหน้า — ใช้ฝั่งผู้บริหาร (sign.html)
// เป็นแบบดูอย่างเดียว (ลาก/ย่อ-ขยายไม่ได้แล้ว เพราะพนักงานกำหนดตำแหน่งมาก่อนส่ง)
// เซ็นครั้งเดียวแต่ลายเซ็นจะไปโผล่ทุกไฟล์ที่แนบมา — จึงอาจมีกรอบมากกว่า 1 จุด
// (คนละหน้ากัน) เปิดมาจะเลื่อนไปหน้าแรกที่มีกรอบให้อัตโนมัติ แต่ยังเลื่อนดูหน้า
// อื่นๆ ได้ตามปกติ กรอบจะโผล่เองตามหน้าที่มีการวางไว้
// ============================================================

import { createPdfPageViewer } from "./pdf-page-viewer.js";

let els = null;
let placements = []; // [{ pageIndex, xRatio, yRatio, wRatio, hRatio }, ...]

/**
 * files: [{ storage_path, sort_order }] เรียงตาม sort_order แล้ว
 * getFileUrl: (storage_path) => publicUrl
 * approverPlacements: [{ pageIndex, xRatio, yRatio, wRatio, hRatio }, ...] ที่พนักงานวางไว้
 */
export async function initSigBox(fileEls, files, getFileUrl, approverPlacements) {
  els = fileEls;
  placements = approverPlacements || [];

  const getBytes = (f) => fetch(getFileUrl(f.storage_path)).then((r) => r.arrayBuffer());
  const viewer = await createPdfPageViewer(fileEls, files, getBytes, (index, canvasWidth, canvasHeight) => {
    const match = placements.find((p) => p.pageIndex === index);
    els.box.style.display = match ? "flex" : "none";
    if (match) {
      els.box.style.left = match.xRatio * canvasWidth + "px";
      els.box.style.top = match.yRatio * canvasHeight + "px";
      els.box.style.width = match.wRatio * canvasWidth + "px";
      els.box.style.height = match.hRatio * canvasHeight + "px";
    }
  });

  els.resizeHandle.style.display = "none";
  els.box.style.cursor = "default";

  if (placements.length && placements[0].pageIndex !== viewer.getCurrentIndex()) {
    await viewer.goToPage(placements[0].pageIndex);
  }
}

export function setSigBoxPreview(dataUrl) {
  if (!els) return;
  els.boxImg.style.backgroundImage = `url(${dataUrl})`;
  els.boxLabel.style.display = "none";
}

export function hasSigBoxPlacement() {
  return placements.length > 0;
}
