// ============================================================
// ระบบขออนุมัติเอกสาร — หน้าเซ็นเอกสารสาธารณะ (sign.html)
// เข้าถึงผ่าน sign.html?token=xxxxx ไม่ต้องล็อกอิน
// ============================================================

import { initSigBox, setSigBoxPreview, hasSigBoxPlacement } from "./sig-box.js";

const sb = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

const FILES_BUCKET = "esign-files";
const SIGNATURES_BUCKET = "esign-signatures";

let approverRow = null;
let requestRow = null;
let hasDrawn = false;
let isDrawing = false;
let lastPoint = null;

function getPublicUrl(bucket, path) {
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}
function filesPublicUrl(path) {
  return getPublicUrl(FILES_BUCKET, path);
}

function showScreen(id) {
  ["loading-screen", "error-screen", "already-signed-screen", "sign-screen", "success-screen"].forEach((s) => {
    document.getElementById(s).style.display = s === id ? (s === "sign-screen" ? "block" : "flex") : "none";
  });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) + " น.";
}

function requestTypeLabel(req) {
  if (req.request_type === "quotation") return "ใบเสนอราคา";
  if (req.request_type === "po") return "ใบสั่งซื้อ (PO)";
  if (req.request_type === "expense") {
    return "ค่าใช้จ่าย · " + (req.expense_subtype === "petty_cash" ? "เบิกเงินสดย่อย" : "เบิกเงิน");
  }
  return req.request_type;
}

// ---------- โหลดข้อมูลคำขอจาก token ----------

async function init() {
  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) {
    showError("ไม่พบลิงก์ที่ถูกต้อง");
    return;
  }

  const { data: approver, error: approverErr } = await sb
    .from("request_approvers")
    .select("*")
    .eq("sign_token", token)
    .single();

  if (approverErr || !approver) {
    showError("ลิงก์นี้ไม่ถูกต้องหรือถูกลบไปแล้ว");
    return;
  }
  approverRow = approver;

  const { data: request, error: requestErr } = await sb
    .from("requests")
    .select("*, request_files(*), request_approvers(*)")
    .eq("id", approver.request_id)
    .single();

  if (requestErr || !request) {
    showError("ไม่พบคำขออนุมัติที่เกี่ยวข้องกับลิงก์นี้");
    return;
  }
  requestRow = request;

  if (approver.status === "signed") {
    renderAlreadySigned();
    return;
  }

  await renderSignScreen();
}

function showError(msg) {
  document.getElementById("error-text").textContent = msg;
  showScreen("error-screen");
}

function renderAlreadySigned() {
  document.getElementById("already-signed-text").textContent =
    `คุณ (${approverRow.approver_name}) เซ็นเอกสาร "${requestRow.title}" ไปแล้วเมื่อ ${formatDateTime(approverRow.signed_at)}`;
  const dl = document.getElementById("already-signed-download");
  if (requestRow.signed_pdf_path) {
    dl.href = filesPublicUrl(requestRow.signed_pdf_path);
    dl.style.display = "inline-block";
  }
  showScreen("already-signed-screen");
}

// ---------- แสดงหน้าฟอร์มเซ็น ----------

async function renderSignScreen() {
  document.getElementById("sign-req-title").textContent = requestRow.title;
  document.getElementById("sign-req-meta").textContent =
    requestTypeLabel(requestRow) + " · สร้างเมื่อ " + formatDateTime(requestRow.created_at);
  document.getElementById("sign-req-desc").textContent = requestRow.description || "";
  if (requestRow.amount !== null && requestRow.amount !== undefined) {
    document.getElementById("sign-req-amount").textContent =
      "จำนวนเงิน: ฿" + Number(requestRow.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 });
  }

  const fileListEl = document.getElementById("sign-file-list");
  fileListEl.innerHTML = "";
  renderGroupedFileList(fileListEl, requestRow.request_files, filesPublicUrl);

  const total = requestRow.request_approvers.length;
  const signed = requestRow.request_approvers.filter((a) => a.status === "signed").length;
  document.getElementById("sign-progress-hint").textContent = `ความคืบหน้าการเซ็น: ${signed}/${total} คน`;

  await loadApproverSelect();
  showScreen("sign-screen");
  setupSignaturePad();

  // คำขอที่ไม่ใช่ประเภทค่าใช้จ่าย ไม่มีเส้นเซ็นตายตัวในเอกสาร — พนักงานวางตำแหน่ง
  // กรอบลายเซ็นไว้ให้แล้วตั้งแต่ตอนสร้างคำขอ ที่นี่แค่แสดงตำแหน่งนั้นให้ดู (ดูหน้า
  // อื่นๆ ของเอกสารเพิ่มเติมได้ แต่ลาก/ย่อ-ขยายกรอบไม่ได้แล้ว)
  if (requestRow.request_type !== "expense") {
    document.getElementById("sig-placement-card").style.display = "block";
    const sortedFiles = [...requestRow.request_files].sort((a, b) => a.sort_order - b.sort_order);
    const placements = Array.isArray(approverRow.sig_boxes) ? approverRow.sig_boxes : [];
    await initSigBox(
      {
        viewport: document.getElementById("sig-page-viewport"),
        canvas: document.getElementById("sig-page-canvas"),
        box: document.getElementById("sig-box"),
        boxImg: document.getElementById("sig-box-img"),
        boxLabel: document.getElementById("sig-box-label"),
        resizeHandle: document.getElementById("sig-box-resize"),
        prevBtn: document.getElementById("sig-page-prev"),
        nextBtn: document.getElementById("sig-page-next"),
        indicator: document.getElementById("sig-page-indicator"),
      },
      sortedFiles,
      filesPublicUrl,
      placements
    );
    if (!hasSigBoxPlacement()) {
      document.getElementById("sig-placement-hint").textContent =
        "⚠️ ผู้ขออนุมัติยังไม่ได้วางตำแหน่งลายเซ็นไว้ ลายเซ็นของท่านจะไม่ถูกแนบลงเอกสาร";
    }
  }
}

async function loadApproverSelect() {
  const select = document.getElementById("approver-select");
  select.innerHTML = "";

  const { data: roster } = await sb.from("approvers_roster").select("*").eq("active", true).order("name");
  const options = roster || [];

  let matchFound = false;
  options.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = JSON.stringify({ name: a.name, position: a.position });
    opt.textContent = `${a.name} — ${a.position}`;
    if (a.name === approverRow.approver_name && a.position === approverRow.approver_position) {
      opt.selected = true;
      matchFound = true;
    }
    select.appendChild(opt);
  });

  if (!matchFound) {
    const opt = document.createElement("option");
    opt.value = JSON.stringify({ name: approverRow.approver_name, position: approverRow.approver_position });
    opt.textContent = `${approverRow.approver_name} — ${approverRow.approver_position}`;
    opt.selected = true;
    select.insertBefore(opt, select.firstChild);
  }
}

// ---------- Canvas ลายเซ็น ----------

function setupSignaturePad() {
  const canvas = document.getElementById("sig-pad");
  const ctx = canvas.getContext("2d");

  function resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#17222e";
  }
  resizeCanvas();

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", (e) => {
    isDrawing = true;
    hasDrawn = true;
    lastPoint = pointFromEvent(e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!isDrawing) return;
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint = p;
  });
  const stop = () => {
    isDrawing = false;
    if (hasDrawn && requestRow.request_type !== "expense") setSigBoxPreview(canvas.toDataURL("image/png"));
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointerleave", stop);
  canvas.addEventListener("pointercancel", stop);

  document.getElementById("clear-sig-btn").addEventListener("click", () => {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    hasDrawn = false;
  });
}

// ---------- ยืนยันเซ็น ----------

function showSignError(msg) {
  const el = document.getElementById("sign-error");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

document.getElementById("confirm-sign-btn").addEventListener("click", async () => {
  showSignError("");
  if (!hasDrawn) {
    showSignError("กรุณาวาดลายเซ็นก่อนกดยืนยัน");
    return;
  }

  const selectedOption = JSON.parse(document.getElementById("approver-select").value);
  const btn = document.getElementById("confirm-sign-btn");
  btn.disabled = true;
  btn.textContent = "กำลังบันทึกลายเซ็น...";

  try {
    const canvas = document.getElementById("sig-pad");
    const signatureBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

    const sigPath = `${requestRow.id}/${approverRow.id}_${Date.now()}.png`;
    const { error: upErr } = await sb.storage.from(SIGNATURES_BUCKET).upload(sigPath, signatureBlob, {
      contentType: "image/png",
      upsert: true,
    });
    if (upErr) throw upErr;

    const signedAt = new Date().toISOString();
    // ตำแหน่งกรอบลายเซ็น (sig_boxes) ผู้ขออนุมัติกำหนดไว้ล่วงหน้า
    // ตั้งแต่ตอนสร้างคำขอแล้ว ตรงนี้แค่บันทึกว่าเซ็นแล้ว ไม่ต้องเขียนตำแหน่งทับ
    const updatePayload = {
      approver_name: selectedOption.name,
      approver_position: selectedOption.position,
      status: "signed",
      signature_image_path: sigPath,
      signed_at: signedAt,
    };
    const { error: updErr } = await sb.from("request_approvers").update(updatePayload).eq("id", approverRow.id);
    if (updErr) throw updErr;

    btn.textContent = "กำลังสร้างไฟล์ PDF...";

    const { data: allApprovers, error: allApErr } = await sb
      .from("request_approvers")
      .select("*")
      .eq("request_id", requestRow.id);
    if (allApErr) throw allApErr;

    const signedApprovers = allApprovers
      .filter((a) => a.status === "signed")
      .sort((a, b) => new Date(a.signed_at) - new Date(b.signed_at));
    const allSigned = allApprovers.every((a) => a.status === "signed");

    let pdfBytes = await buildSignedPdf({
      request: requestRow,
      files: requestRow.request_files,
      signedApprovers,
      getFileUrl: filesPublicUrl,
      getSignatureUrl: (path) => getPublicUrl(SIGNATURES_BUCKET, path),
      // ฟอร์มใบเบิกเงิน/เงินสดย่อย และคำขออื่นๆ ที่วางกรอบลายเซ็นเองแล้ว มีที่เซ็น
      // อยู่บนเอกสารโดยตรงอยู่แล้ว ไม่ต้องมีหน้าสรุปแยกซ้ำอีกหน้า
      skipSummaryPage: true,
    });

    if (requestRow.request_type === "expense") {
      // ประทับลายเซ็นจริงลงบนเส้น "ผู้อนุมัติ" ของฟอร์มใบเบิกเงิน/ใบเบิกเงินสดย่อย
      // (หน้าแรกของเอกสาร) โดยตรง
      const mergedDoc = await PDFLib.PDFDocument.load(pdfBytes);
      const sigArrayBuffer = await signatureBlob.arrayBuffer();
      await stampApproverOnExpenseForm(
        mergedDoc,
        requestRow.expense_subtype,
        sigArrayBuffer,
        selectedOption.name,
        selectedOption.position,
        signedAt
      );
      pdfBytes = await mergedDoc.save();
    } else {
      // ประทับลายเซ็นของผู้อนุมัติทุกคนที่เซ็นแล้ว ลงบนตำแหน่งกรอบที่แต่ละคนวางไว้เอง
      // + ลายเซ็นผู้จัดทำ/ผู้ตรวจสอบ (ถ้าแนบไว้ตอนสร้างคำขอ) ทุกครั้งที่ pdf ถูกสร้างใหม่
      const mergedDoc = await PDFLib.PDFDocument.load(pdfBytes);
      const getSigUrl = (path) => getPublicUrl(SIGNATURES_BUCKET, path);
      await stampApproversAtBoxPositions(mergedDoc, signedApprovers, getSigUrl);
      await stampFixedSignature(mergedDoc, requestRow.preparer_signature_path, requestRow.preparer_sig_boxes, getSigUrl);
      await stampFixedSignature(mergedDoc, requestRow.reviewer_signature_path, requestRow.reviewer_sig_boxes, getSigUrl);
      pdfBytes = await mergedDoc.save();
    }

    const signedPdfPath = `${requestRow.id}/signed.pdf`;
    const { error: pdfUpErr } = await sb.storage.from(FILES_BUCKET).upload(signedPdfPath, new Blob([pdfBytes], { type: "application/pdf" }), {
      contentType: "application/pdf",
      upsert: true,
    });
    if (pdfUpErr) throw pdfUpErr;

    const { error: reqUpdErr } = await sb
      .from("requests")
      .update({ signed_pdf_path: signedPdfPath, status: allSigned ? "approved" : "pending" })
      .eq("id", requestRow.id);
    if (reqUpdErr) throw reqUpdErr;

    document.getElementById("success-text").textContent =
      `คุณ (${selectedOption.name}) เซ็นเอกสาร "${requestRow.title}" เรียบร้อยเมื่อ ${formatDateTime(signedAt)}`;
    showScreen("success-screen");
  } catch (err) {
    console.error("confirm-sign failed:", err);
    showSignError(err.message || "เกิดข้อผิดพลาด กรุณาลองใหม่");
    btn.disabled = false;
    btn.textContent = "ยืนยันเซ็นเอกสาร";
  }
});

init();
