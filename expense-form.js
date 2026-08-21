// ============================================================
// สร้างไฟล์ PDF "ใบเบิกเงิน" / "ใบเบิกเงินสดย่อย" อัตโนมัติ
// โดยใช้รูปพื้นหลังที่ตัดมาจากแม่แบบจริงของร้าน (assets/expense-form-*-bg.png)
// แล้วพิมพ์ชื่อผู้เบิก/วันที่/รายการ/ยอดรวมทับลงไปด้วย pdf-lib
//
// พิกัดทั้งหมดวัดจากไฟล์แม่แบบจริงด้วย PyMuPDF (หน่วย pt, จุดกำเนิดซ้ายบน
// แล้วแปลงเป็นระบบพิกัด pdf-lib ที่จุดกำเนิดซ้ายล่างผ่าน toPageY)
//
// ทุกช่องที่พิมพ์ทับ (ชื่อ/วันที่) ต้องวาดกล่องสีขาวปิดเส้นประเดิมก่อน
// (maskBox) แล้วค่อยพิมพ์ตัวหนังสือทับ ไม่งั้นจะเห็นเส้นประเดิมแทรกปนกับ
// ตัวหนังสือใหม่ (เพราะเส้นประเป็นส่วนหนึ่งของภาพพื้นหลัง ไม่ใช่เส้นใต้ตัวอักษร)
// ============================================================

const TEMPLATE_PAGE_WIDTH = 595.5;

// การ์ด "ใบเบิกเงิน" ตัดจากครึ่งบนของแม่แบบ (fitz y เดิม: 0-396)
const ADVANCE_CARD = {
  bgPath: "assets/expense-form-advance-bg.png",
  height: 396,
  name: { maskX: 90, maskWidth: 148, maskFitzTop: 104, maskFitzBottom: 128, textX: 96, textFitzY: 121 },
  date: { maskX: 426, maskWidth: 110, maskFitzTop: 104, maskFitzBottom: 128, textX: 432, textFitzY: 121 },
  colNoX: [35.6, 86.7],
  colDescX: [86.7, 465.2],
  colAmountX: [465.2, 559.9],
  rowFitzY: [
    [172.59, 199.63],
    [199.63, 223.17],
    [223.17, 246.70],
    [246.70, 270.24],
  ],
  totalRowFitzY: [270.24, 310.75],
  toPageY: (fitzY) => 396 - fitzY,
  // ตำแหน่งเส้นเซ็น "ผู้อนุมัติ" (ฝั่งขวา) — ใช้ตอนประทับลายเซ็นจริงลงบนฟอร์ม
  approverSigBox: { x: 390, right: 493, fitzTop: 296, fitzBottom: 342 },
  approverInfo: { maskX: 386, maskWidth: 130, maskFitzTop: 366, maskFitzBottom: 390, nameFitzY: 376, tsFitzY: 386 },
  // ตำแหน่งเส้นเซ็น "ผู้เบิก" (ฝั่งซ้าย) — ใช้ตอนแนบลายเซ็นผู้ขออนุมัติ (ถ้ามี)
  requesterSigBox: { x: 65, right: 178, fitzTop: 296, fitzBottom: 342 },
};

// การ์ด "ใบเบิกเงินสดย่อย" ตัดจากครึ่งล่างของแม่แบบ (fitz y เดิม: 396-842.25)
const PETTY_CASH_CARD = {
  bgPath: "assets/expense-form-pettycash-bg.png",
  height: 446.25,
  name: { maskX: 86, maskWidth: 148, maskFitzTop: 499, maskFitzBottom: 523, textX: 92, textFitzY: 516 },
  date: { maskX: 426, maskWidth: 110, maskFitzTop: 499, maskFitzBottom: 523, textX: 432, textFitzY: 516 },
  colNoX: [34.6, 85.7],
  colDescX: [85.7, 464.2],
  colAmountX: [464.2, 558.9],
  rowFitzY: [
    [566.4, 593.5],
    [593.5, 617.0],
    [617.0, 640.5],
    [640.5, 663.8],
    [663.8, 687.1],
  ],
  totalRowFitzY: [687.1, 744.1],
  toPageY: (fitzY) => 842.25 - fitzY,
  // ตำแหน่งเส้นเซ็น "ผู้อนุมัติ" (ฝั่งขวา) — ใช้ตอนประทับลายเซ็นจริงลงบนฟอร์ม
  approverSigBox: { x: 390, right: 493, fitzTop: 735, fitzBottom: 781 },
  approverInfo: { maskX: 386, maskWidth: 130, maskFitzTop: 805, maskFitzBottom: 829, nameFitzY: 815, tsFitzY: 825 },
  // ตำแหน่งเส้นเซ็น "ผู้เบิก" (ฝั่งซ้าย) — ใช้ตอนแนบลายเซ็นผู้ขออนุมัติ (ถ้ามี)
  requesterSigBox: { x: 65, right: 178, fitzTop: 735, fitzBottom: 781 },
};

function bahtNumber(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * subtype: 'advance' (เบิกเงิน) | 'petty_cash' (เบิกเงินสดย่อย)
 * requesterName: string
 * dateStr: string (แสดงผลตรงๆ เช่น "20 สิงหาคม 2569")
 * items: [{ description, amount }]
 * requesterSignaturePngBytes: ArrayBuffer/Uint8Array ของรูปลายเซ็นผู้เบิก (ไม่บังคับ)
 * คืนค่า Uint8Array ของไฟล์ PDF หน้าเดียว
 */
async function buildExpenseFormPdf({ subtype, requesterName, dateStr, items, requesterSignaturePngBytes }) {
  const { PDFDocument, rgb } = PDFLib;
  const card = subtype === "petty_cash" ? PETTY_CASH_CARD : ADVANCE_CARD;

  const bgBytes = await fetchArrayBuffer(card.bgPath);

  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(window.fontkit);
  const thaiFontBytes = await fetchArrayBuffer(THAI_FONT_PATH);
  const thaiFont = await outDoc.embedFont(thaiFontBytes, { subset: true });
  const bgImage = await outDoc.embedPng(bgBytes);

  const page = outDoc.addPage([TEMPLATE_PAGE_WIDTH, card.height]);
  page.drawImage(bgImage, { x: 0, y: 0, width: TEMPLATE_PAGE_WIDTH, height: card.height });

  if (requesterSignaturePngBytes) {
    const reqSigImage = await outDoc.embedPng(requesterSignaturePngBytes);
    stampRequesterSignatureOnPage(page, subtype, reqSigImage);
  }

  const drawField = (field, text) => {
    page.drawRectangle({
      x: field.maskX,
      y: card.toPageY(field.maskFitzBottom),
      width: field.maskWidth,
      height: field.maskFitzBottom - field.maskFitzTop,
      color: rgb(1, 1, 1),
    });
    page.drawText(text, {
      x: field.textX,
      y: card.toPageY(field.textFitzY),
      font: thaiFont,
      size: 11,
      color: rgb(0.1, 0.15, 0.2),
    });
  };

  const drawText = (text, x, fitzY, opts) => {
    page.drawText(text, { x, y: card.toPageY(fitzY), font: thaiFont, size: 11, color: rgb(0.1, 0.15, 0.2), ...opts });
  };

  drawField(card.name, requesterName || "-");
  drawField(card.date, dateStr || "-");

  let total = 0;
  items.slice(0, card.rowFitzY.length).forEach((item, i) => {
    const [rowTop, rowBottom] = card.rowFitzY[i];
    const rowFitzY = rowTop + (rowBottom - rowTop) * 0.68;
    total += Number(item.amount) || 0;
    drawText(String(i + 1), card.colNoX[0] + 18, rowFitzY, { size: 10 });
    drawText(item.description || "", card.colDescX[0] + 8, rowFitzY, { size: 10 });
    const amountText = bahtNumber(item.amount);
    const amountWidth = thaiFont.widthOfTextAtSize(amountText, 10);
    drawText(amountText, card.colAmountX[1] - 10 - amountWidth, rowFitzY, { size: 10 });
  });

  const [totalRowTop, totalRowBottom] = card.totalRowFitzY;
  const totalFitzY = totalRowTop + (totalRowBottom - totalRowTop) * 0.42;
  const totalText = bahtNumber(total) + " บาท";
  const totalWidth = thaiFont.widthOfTextAtSize(totalText, 11);
  drawText(totalText, card.colAmountX[1] - 10 - totalWidth, totalFitzY, { size: 11 });

  return await outDoc.save();
}

function drawSignatureIntoBox(page, sigImage, box, toPageY) {
  const maxWidth = box.right - box.x;
  const maxHeight = box.fitzBottom - box.fitzTop;
  const scaled = sigImage.scaleToFit(maxWidth, maxHeight);
  const sigYTop = toPageY(box.fitzTop);
  page.drawImage(sigImage, {
    x: box.x + (maxWidth - scaled.width) / 2,
    y: sigYTop - scaled.height,
    width: scaled.width,
    height: scaled.height,
  });
}

/**
 * ประทับลายเซ็นจริง (ของผู้อนุมัติ) + ชื่อ + ตำแหน่ง + เวลาที่เซ็น ลงบนเส้น
 * "ผู้อนุมัติ" ของฟอร์มใบเบิกเงิน/ใบเบิกเงินสดย่อยที่สร้างไว้แล้ว — ฟอร์มนี้ต้อง
 * เป็นหน้าแรก (page index 0) ของเอกสาร PDF ที่ merge เสร็จแล้ว
 *
 * mergedDoc: PDFDocument (จาก PDFLib.PDFDocument.load ของไฟล์ที่ merge แล้ว)
 * subtype: 'advance' | 'petty_cash'
 * sigPngBytes: ArrayBuffer/Uint8Array ของรูปลายเซ็น (PNG)
 * approverName, approverPosition: ชื่อ-ตำแหน่งผู้อนุมัติ
 * signedAtISO: เวลาที่เซ็น (ISO string)
 */
async function stampApproverOnExpenseForm(mergedDoc, subtype, sigPngBytes, approverName, approverPosition, signedAtISO) {
  const { rgb } = PDFLib;
  const card = subtype === "petty_cash" ? PETTY_CASH_CARD : ADVANCE_CARD;

  mergedDoc.registerFontkit(window.fontkit);
  const thaiFontBytes = await fetchArrayBuffer(THAI_FONT_PATH);
  const thaiFont = await mergedDoc.embedFont(thaiFontBytes, { subset: true });

  const page = mergedDoc.getPage(0);
  const sigImage = await mergedDoc.embedPng(sigPngBytes);
  drawSignatureIntoBox(page, sigImage, card.approverSigBox, card.toPageY);

  const info = card.approverInfo;
  page.drawRectangle({
    x: info.maskX,
    y: card.toPageY(info.maskFitzBottom),
    width: info.maskWidth,
    height: info.maskFitzBottom - info.maskFitzTop,
    color: rgb(1, 1, 1),
  });
  page.drawText(`${approverName} (${approverPosition})`, {
    x: info.maskX,
    y: card.toPageY(info.nameFitzY),
    font: thaiFont,
    size: 8.5,
    color: rgb(0.1, 0.15, 0.2),
  });
  page.drawText(`ลงนามเมื่อ: ${formatThaiDateTime(signedAtISO)}`, {
    x: info.maskX,
    y: card.toPageY(info.tsFitzY),
    font: thaiFont,
    size: 7.5,
    color: rgb(0.35, 0.4, 0.47),
  });
}

/**
 * แนบลายเซ็นของผู้เบิก (ผู้ขออนุมัติ) ลงบนเส้น "ผู้เบิก" ของฟอร์มใบเบิกเงิน/
 * ใบเบิกเงินสดย่อย — เรียกตอนสร้างคำขอ ก่อน merge เข้ากับไฟล์อื่น (ทำงานบน
 * outDoc ของ buildExpenseFormPdf โดยตรง ก่อน save)
 */
function stampRequesterSignatureOnPage(page, subtype, sigImage) {
  const card = subtype === "petty_cash" ? PETTY_CASH_CARD : ADVANCE_CARD;
  drawSignatureIntoBox(page, sigImage, card.requesterSigBox, card.toPageY);
}
