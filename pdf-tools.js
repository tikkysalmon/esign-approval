// ============================================================
// เครื่องมือรวม/แสตมป์ไฟล์ PDF ด้วย pdf-lib (ใช้ใน sign.js)
// รวมไฟล์ PDF ต้นฉบับทั้งหมด + ต่อท้ายด้วย "หน้าสรุปการอนุมัติ"
// ที่มีลายเซ็น + ชื่อ + ตำแหน่ง + วันเวลาที่เซ็นของผู้อนุมัติแต่ละคน
// ============================================================

const THAI_FONT_PATH = "lib/NotoSansThai-Regular.ttf";

async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("โหลดไฟล์ไม่สำเร็จ: " + url);
  return await res.arrayBuffer();
}

function formatThaiDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) + " น.";
}

/**
 * request: { title, request_type, expense_subtype, description, amount }
 * files: [{ file_name, storage_path, sort_order }]  (ไฟล์ PDF ต้นฉบับ เรียงตาม sort_order — อยู่ใน bucket esign-files)
 * signedApprovers: [{ approver_name, approver_position, signature_image_path, signed_at }]
 * getFileUrl: (storagePath) => publicUrl string (bucket esign-files)
 * getSignatureUrl: (storagePath) => publicUrl string (bucket esign-signatures — คนละ bucket กับไฟล์เอกสาร)
 * skipSummaryPage: ข้ามหน้าสรุปการอนุมัตินี้ไปเลย — ใช้ตอนเอกสารมีที่เซ็นในตัวอยู่แล้ว
 *   (เช่นฟอร์มใบเบิกเงิน/เงินสดย่อย ที่ประทับลายเซ็นลงบนฟอร์มโดยตรงแทน ไม่ต้องมีหน้าซ้ำ)
 * คืนค่า: Uint8Array ของไฟล์ PDF ที่รวม+แสตมป์แล้ว
 */
async function buildSignedPdf({ request, files, signedApprovers, getFileUrl, getSignatureUrl, skipSummaryPage }) {
  const { PDFDocument, rgb } = PDFLib;

  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(window.fontkit);

  const thaiFontBytes = await fetchArrayBuffer(THAI_FONT_PATH);
  const thaiFont = await outDoc.embedFont(thaiFontBytes, { subset: true });

  const sortedFiles = [...files].sort((a, b) => a.sort_order - b.sort_order);
  for (const f of sortedFiles) {
    const bytes = await fetchArrayBuffer(getFileUrl(f.storage_path));
    const srcDoc = await PDFDocument.load(bytes);
    const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    copiedPages.forEach((p) => outDoc.addPage(p));
  }

  if (skipSummaryPage) return await outDoc.save();

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 50;
  let page = outDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const drawText = (text, opts) => page.drawText(text, { font: thaiFont, ...opts });

  drawText("หน้าสรุปการอนุมัติเอกสาร", { x: margin, y, size: 18, color: rgb(0.09, 0.13, 0.18) });
  y -= 30;

  const typeLabel =
    request.request_type === "quotation"
      ? "ใบเสนอราคา"
      : "ค่าใช้จ่าย · " + (request.expense_subtype === "petty_cash" ? "เบิกเงินสดย่อย" : "เบิกเงิน");

  drawText(`เรื่อง: ${request.title}`, { x: margin, y, size: 12 });
  y -= 18;
  drawText(`ประเภท: ${typeLabel}`, { x: margin, y, size: 12 });
  y -= 18;
  if (request.amount !== null && request.amount !== undefined) {
    const amountText = Number(request.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 });
    drawText(`จำนวนเงิน: ${amountText} บาท`, { x: margin, y, size: 12 });
    y -= 18;
  }
  if (request.description) {
    const desc =
      request.description.length > 110 ? request.description.slice(0, 110) + "..." : request.description;
    drawText(`รายละเอียด: ${desc}`, { x: margin, y, size: 11, color: rgb(0.35, 0.4, 0.47) });
    y -= 24;
  } else {
    y -= 8;
  }

  drawText("ผู้อนุมัติ:", { x: margin, y, size: 13 });
  y -= 22;

  const sigBoxWidth = 180;
  const sigBoxHeight = 70;

  for (const a of signedApprovers) {
    if (y - sigBoxHeight - 46 < margin) {
      page = outDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }

    if (a.signature_image_path) {
      const sigBytes = await fetchArrayBuffer(getSignatureUrl(a.signature_image_path));
      const sigImage = await outDoc.embedPng(sigBytes);
      const scaled = sigImage.scaleToFit(sigBoxWidth, sigBoxHeight);
      page.drawImage(sigImage, {
        x: margin,
        y: y - scaled.height,
        width: scaled.width,
        height: scaled.height,
      });
      y -= scaled.height + 4;
    } else {
      y -= sigBoxHeight * 0.4;
    }

    drawText(`${a.approver_name}  (${a.approver_position})`, { x: margin, y, size: 12 });
    y -= 16;
    drawText(`ลงนามเมื่อ: ${formatThaiDateTime(a.signed_at)}`, {
      x: margin,
      y,
      size: 10,
      color: rgb(0.35, 0.4, 0.47),
    });
    y -= 28;
  }

  return await outDoc.save();
}

/**
 * ประทับลายเซ็นของผู้อนุมัติแต่ละคนลงบนทุกตำแหน่งกรอบที่แต่ละคนวางไว้เอง พร้อม
 * วันเวลาที่เซ็นอยู่ใต้ลายเซ็นทุกจุด (สำหรับคำขอที่ไม่ใช่ประเภทค่าใช้จ่าย เช่นใบเสนอ
 * ราคา ซึ่งไม่มีเส้นเซ็นตายตัวในเอกสาร) — 1 คนเซ็นครั้งเดียว แต่ลายเซ็นเดียวกันนั้น
 * จะไปโผล่ทุกไฟล์ที่แนบมา จึงมีได้มากกว่า 1 กรอบต่อคน (sig_boxes เป็นอาเรย์)
 * ต้องเรียกซ้ำทุกคนที่เซ็นแล้วทุกครั้งที่มีคนเซ็นเพิ่ม เพราะ mergedDoc ถูกสร้างใหม่
 * จากไฟล์ต้นฉบับทุกครั้ง (ไม่งั้นลายเซ็นของคนก่อนหน้าจะหายไป)
 *
 * mergedDoc: PDFDocument (จาก PDFLib.PDFDocument.load ของไฟล์ที่ merge แล้ว)
 * signedApprovers: [{ signature_image_path, signed_at,
 *   sig_boxes: [{ pageIndex, xRatio, yRatio, wRatio, hRatio }, ...] }]
 * getSignatureUrl: (storagePath) => publicUrl string (bucket esign-signatures)
 */
async function stampApproversAtBoxPositions(mergedDoc, signedApprovers, getSignatureUrl) {
  const { rgb } = PDFLib;
  const withPlacement = signedApprovers.filter((a) => Array.isArray(a.sig_boxes) && a.sig_boxes.length);
  if (!withPlacement.length) return;

  mergedDoc.registerFontkit(window.fontkit);
  const thaiFontBytes = await fetchArrayBuffer(THAI_FONT_PATH);
  const thaiFont = await mergedDoc.embedFont(thaiFontBytes, { subset: true });

  for (const a of withPlacement) {
    const sigBytes = await fetchArrayBuffer(getSignatureUrl(a.signature_image_path));
    const sigImage = await mergedDoc.embedPng(sigBytes);
    const timestampText = a.signed_at ? formatThaiDateTime(a.signed_at) : "";

    for (const box of a.sig_boxes) {
      if (box.pageIndex >= mergedDoc.getPageCount()) continue;
      const page = mergedDoc.getPage(box.pageIndex);
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();

      const boxLeft = box.xRatio * pageWidth;
      const boxWidth = box.wRatio * pageWidth;
      const boxHeight = box.hRatio * pageHeight;
      const boxBottom = pageHeight * (1 - box.yRatio - box.hRatio);

      // กันที่ด้านล่างกรอบไว้ 1 บรรทัดสำหรับ timestamp เสมอ ที่เหลือค่อยเป็นลายเซ็น
      const timestampFontSize = Math.max(6, Math.min(9, boxWidth / 22));
      const timestampLineHeight = timestampFontSize + 4;
      const sigMaxHeight = Math.max(boxHeight - timestampLineHeight, boxHeight * 0.5);

      const scaled = sigImage.scaleToFit(boxWidth, sigMaxHeight);
      const sigY = boxBottom + timestampLineHeight + (sigMaxHeight - scaled.height) / 2;
      page.drawImage(sigImage, {
        x: boxLeft + (boxWidth - scaled.width) / 2,
        y: sigY,
        width: scaled.width,
        height: scaled.height,
      });

      if (timestampText) {
        const textWidth = thaiFont.widthOfTextAtSize(timestampText, timestampFontSize);
        page.drawText(timestampText, {
          x: boxLeft + Math.max(0, (boxWidth - textWidth) / 2),
          y: boxBottom + (timestampLineHeight - timestampFontSize) / 2,
          font: thaiFont,
          size: timestampFontSize,
          color: rgb(0.35, 0.4, 0.47),
        });
      }
    }
  }
}
