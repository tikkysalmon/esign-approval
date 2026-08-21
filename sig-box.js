// ============================================================
// แสดงตำแหน่งกรอบลายเซ็นที่พนักงานวางไว้ล่วงหน้า — ใช้ฝั่งผู้บริหาร (sign.html)
// เป็นแบบดูอย่างเดียว (ลาก/ย่อ-ขยายไม่ได้แล้ว เพราะพนักงานกำหนดตำแหน่งมาก่อนส่ง)
// เปิดมาจะเลื่อนไปหน้าที่ต้องเซ็นให้อัตโนมัติ แต่ยังเลื่อนดูหน้าอื่นๆ ได้ตามปกติ
// ============================================================

import { createPdfPageViewer } from "./pdf-page-viewer.js";

let els = null;
let placement = null; // { pageIndex, xRatio, yRatio, wRatio, hRatio }

/**
 * files: [{ storage_path, sort_order }] เรียงตาม sort_order แล้ว
 * getFileUrl: (storage_path) => publicUrl
 * approverPlacement: { pageIndex, xRatio, yRatio, wRatio, hRatio } ที่พนักงานวางไว้
 */
export async function initSigBox(fileEls, files, getFileUrl, approverPlacement) {
  els = fileEls;
  placement = approverPlacement;

  const getBytes = (f) => fetch(getFileUrl(f.storage_path)).then((r) => r.arrayBuffer());
  const viewer = await createPdfPageViewer(fileEls, files, getBytes, (index, canvasWidth, canvasHeight) => {
    const onAssignedPage = placement && placement.pageIndex === index;
    els.box.style.display = onAssignedPage ? "flex" : "none";
    if (onAssignedPage) {
      els.box.style.left = placement.xRatio * canvasWidth + "px";
      els.box.style.top = placement.yRatio * canvasHeight + "px";
      els.box.style.width = placement.wRatio * canvasWidth + "px";
      els.box.style.height = placement.hRatio * canvasHeight + "px";
    }
  });

  els.resizeHandle.style.display = "none";
  els.box.style.cursor = "default";

  if (placement && placement.pageIndex !== viewer.getCurrentIndex()) {
    await viewer.goToPage(placement.pageIndex);
  }
}

export function setSigBoxPreview(dataUrl) {
  if (!els) return;
  els.boxImg.style.backgroundImage = `url(${dataUrl})`;
  els.boxLabel.style.display = "none";
}

export function hasSigBoxPlacement() {
  return !!placement;
}
