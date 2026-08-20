// ============================================================
// สร้างไฟล์ PDF "ใบเบิกเงิน" / "ใบเบิกเงินสดย่อย" อัตโนมัติ
// โดยใช้รูปพื้นหลังที่ตัดมาจากแม่แบบจริงของร้าน (assets/expense-form-*-bg.png)
// แล้วพิมพ์ชื่อผู้เบิก/วันที่/รายการ/ยอดรวมทับลงไปด้วย pdf-lib
//
// พิกัดทั้งหมดวัดจากไฟล์แม่แบบจริงด้วย PyMuPDF (หน่วย pt, จุดกำเนิดซ้ายบน
// แล้วแปลงเป็นระบบพิกัด pdf-lib ที่จุดกำเนิดซ้ายล่างผ่าน toPageY)
// ============================================================

const TEMPLATE_PAGE_WIDTH = 595.5;

// การ์ด "ใบเบิกเงิน" ตัดจากครึ่งบนของแม่แบบ (fitz y เดิม: 0-396)
const ADVANCE_CARD = {
  bgPath: "assets/expense-form-advance-bg.png",
  height: 396,
  nameFitzY: 122,
  nameX: 96,
  dateFitzY: 122,
  dateX: 432,
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
};

// การ์ด "ใบเบิกเงินสดย่อย" ตัดจากครึ่งล่างของแม่แบบ (fitz y เดิม: 396-842.25)
const PETTY_CASH_CARD = {
  bgPath: "assets/expense-form-pettycash-bg.png",
  height: 446.25,
  nameFitzY: 517,
  nameX: 92,
  dateFitzY: 517,
  dateX: 432,
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
};

function bahtNumber(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * subtype: 'advance' (เบิกเงิน) | 'petty_cash' (เบิกเงินสดย่อย)
 * requesterName: string
 * dateStr: string (แสดงผลตรงๆ เช่น "20 สิงหาคม 2569")
 * items: [{ description, amount }]
 * คืนค่า Uint8Array ของไฟล์ PDF หน้าเดียว
 */
async function buildExpenseFormPdf({ subtype, requesterName, dateStr, items }) {
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

  const drawText = (text, x, fitzY, opts) => {
    page.drawText(text, { x, y: card.toPageY(fitzY), font: thaiFont, size: 11, color: rgb(0.1, 0.15, 0.2), ...opts });
  };

  drawText(requesterName || "-", card.nameX, card.nameFitzY);
  drawText(dateStr || "-", card.dateX, card.dateFitzY);

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
