// ============================================================
// ระบบขออนุมัติเอกสาร — หน้าพนักงาน (index.html)
// ============================================================

import { createSigBoxEditor } from "./sig-box-editor.js";

const sb = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

const FILES_BUCKET = "esign-files";
const SIGNATURES_BUCKET = "esign-signatures";

let selectedFiles = []; // File[]
let selectedFileLabels = []; // string[] — ป้ายกำกับต่อไฟล์ ตำแหน่งตรงกับ selectedFiles (ว่างได้ ไม่บังคับ)
let expenseItems = []; // [{ description, amount }]
let requesterSignatureBlob = null; // Blob (PNG, พื้นหลังลบแล้ว) หรือ null — ผู้เบิก (ค่าใช้จ่าย)
let preparerSignatureBlob = null; // ผู้จัดทำ (เอกสารอื่นๆ)
let reviewerSignatureBlob = null; // ผู้ตรวจสอบ (เอกสารอื่นๆ)
let selectedApproverIds = new Set();
let rosterCache = []; // approvers_roster rows (active only, for select)
let rosterAllCache = []; // approvers_roster rows (all, for management table)
let sigBoxEditor = null; // handle จาก createSigBoxEditor (สร้างใหม่ทุกครั้งที่ไฟล์แนบเปลี่ยน)
let activeSigApproverId = null; // id ผู้อนุมัติที่กำลังวาง/แก้ตำแหน่งกรอบอยู่ (ใช้กับปุ่ม "ใช้กับทุกไฟล์")
let activeSigApproverName = "";
let sigBoxEditorFilesKey = ""; // เอาไว้เช็คว่าไฟล์แนบเปลี่ยนจริงไหม จะได้ไม่ต้องโหลด pdf.js ซ้ำ

// ---------- ยูทิลิตี้ ----------

function baht(n) {
  if (n === null || n === undefined || n === "") return "-";
  return "฿" + Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

function requestTypeLabel(req) {
  if (req.request_type === "quotation") return "ใบเสนอราคา";
  if (req.request_type === "po") return "ใบสั่งซื้อ (PO)";
  if (req.request_type === "expense") {
    return req.expense_subtype === "petty_cash" ? "ค่าใช้จ่าย · เบิกเงินสดย่อย" : "ค่าใช้จ่าย · เบิกเงิน";
  }
  return req.request_type;
}

function sanitizeForStorageKey(fileName) {
  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx > -1 ? fileName.slice(dotIdx + 1).replace(/[^a-zA-Z0-9]/g, "") : "";
  const base = (dotIdx > -1 ? fileName.slice(0, dotIdx) : fileName)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (base || "file") + (ext ? "." + ext : "");
}

function signLinkFor(token) {
  const base = window.location.href.replace(/index\.html.*$/, "").replace(/\/?(\?.*)?$/, "/");
  return base + "sign.html?token=" + token;
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = "คัดลอกแล้ว ✓";
    setTimeout(() => (btn.textContent = original), 1500);
  });
}

// ---------- Tabs ----------

document.querySelectorAll("nav.tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs .tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
    document.getElementById("tab-" + tab).style.display = "block";
    if (tab === "request-list") loadRequestList();
    if (tab === "roster") loadRosterTable();
  });
});

function initAppData() {
  loadApproverSelect();
  loadRequestList();
  loadRosterTable();
}

initAppData();
expenseItems = [{ description: "", amount: "" }];
renderExpenseItems();

// ---------- ฟอร์มสร้างคำขอ: ประเภทคำขอ / ประเภทค่าใช้จ่าย (radio pill) ----------

function setupPillGroup(groupId, onChange) {
  const group = document.getElementById(groupId);
  group.querySelectorAll(".radio-pill, .checkbox-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const input = pill.querySelector("input");
      if (input.type === "radio") {
        group.querySelectorAll(".radio-pill").forEach((p) => p.classList.remove("selected"));
        input.checked = true;
        pill.classList.add("selected");
      } else {
        input.checked = !input.checked;
        pill.classList.toggle("selected", input.checked);
      }
      if (onChange) onChange(input);
    });
  });
}

setupPillGroup("request-type-group", (input) => {
  const isExpense = input.value === "expense";
  const isPo = input.value === "po";
  document.getElementById("expense-subtype-block").style.display = isExpense ? "block" : "none";
  document.getElementById("expense-items-block").style.display = isExpense ? "block" : "none";
  // PO มักแนบเอกสารหลายชุด ไม่มียอดเงินรวมเดียวที่สื่อความหมาย จึงไม่ต้องมีช่องนี้
  document.getElementById("amount-block").style.display = isExpense || isPo ? "none" : "block";
  document.getElementById("fixed-sig-block").style.display = isExpense ? "none" : "block";
  if (isExpense && !expenseItems.length) addExpenseItemRow();
  refreshSigPlacementUI();
});
setupPillGroup("expense-subtype-group");

function getSelectedRequestType() {
  const input = document.querySelector("#request-type-group input:checked");
  return input ? input.value : null;
}

// ---------- ฟอร์มสร้างคำขอ: วางตำแหน่งลายเซ็นแยกต่อผู้อนุมัติ (เฉพาะที่ไม่ใช่ค่าใช้จ่าย) ----------

// เลือกไฟล์/เลือกผู้อนุมัติเร็วๆ ติดกัน อาจเรียก refreshSigPlacementUI ซ้อนกันได้
// (เช่น pdf.js render หน้าเดิมค้างอยู่ตอนคำขอใหม่มาถึง) ต้องเข้าคิวทีละครั้งเสมอ
// ไม่งั้น pdf.js จะ error "Cannot use the same canvas during multiple render() operations"
let sigPlacementRefreshChain = Promise.resolve();

function refreshSigPlacementUI() {
  sigPlacementRefreshChain = sigPlacementRefreshChain
    .then(() => refreshSigPlacementUIInner())
    .catch((err) => console.error("refreshSigPlacementUI failed:", err));
  return sigPlacementRefreshChain;
}

async function refreshSigPlacementUIInner() {
  const block = document.getElementById("req-sig-placement-block");
  const type = getSelectedRequestType();
  const eligible = type && type !== "expense" && selectedFiles.length > 0 && selectedApproverIds.size > 0;
  if (!eligible) {
    block.style.display = "none";
    return;
  }
  block.style.display = "block";

  const filesKey = selectedFiles.map((f) => f.name + "_" + f.size).join("|");
  if (!sigBoxEditor || sigBoxEditorFilesKey !== filesKey) {
    sigBoxEditorFilesKey = filesKey;
    sigBoxEditor = await createSigBoxEditor(
      {
        viewport: document.getElementById("req-sig-page-viewport"),
        canvas: document.getElementById("req-sig-page-canvas"),
        indicator: document.getElementById("req-sig-page-indicator"),
        prevBtn: document.getElementById("req-sig-page-prev"),
        nextBtn: document.getElementById("req-sig-page-next"),
      },
      {
        box: document.getElementById("req-sig-box"),
        boxImg: document.getElementById("req-sig-box-img"),
        boxLabel: document.getElementById("req-sig-box-label"),
        resizeHandle: document.getElementById("req-sig-box-resize"),
      },
      selectedFiles
    );
    activeSigApproverId = null;
    activeSigApproverName = "";
  }

  renderSigApproverTabs();
  renderSigFileJumpButtons();
  updateApplyAllButton();
}

function updateApplyAllButton() {
  const btn = document.getElementById("req-sig-apply-all-btn");
  const status = document.getElementById("req-sig-apply-all-status");
  const nameSpan = document.getElementById("req-sig-apply-all-name");
  const show = sigBoxEditor && sigBoxEditor.getFileCount() > 1 && activeSigApproverId;
  btn.style.display = show ? "inline-block" : "none";
  status.style.display = "none";
  if (show) nameSpan.textContent = ` ${activeSigApproverName}`;
}

document.getElementById("req-sig-apply-all-btn").addEventListener("click", () => {
  sigPlacementRefreshChain = sigPlacementRefreshChain
    .then(() => {
      const count = sigBoxEditor.applyCurrentBoxToAllFiles();
      const status = document.getElementById("req-sig-apply-all-status");
      status.textContent = `✅ ใช้ตำแหน่งนี้กับอีก ${count} ไฟล์เรียบร้อย`;
      status.style.display = "block";
    })
    .catch((err) => console.error("applyCurrentBoxToAllFiles failed:", err));
});

function renderSigFileJumpButtons() {
  const wrap = document.getElementById("req-sig-file-jump");
  wrap.innerHTML = "";
  if (!sigBoxEditor) return;
  for (let i = 0; i < sigBoxEditor.getFileCount(); i++) {
    const file = selectedFiles[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "checkbox-pill";
    btn.textContent = `📄 ${file ? file.name : "ไฟล์ " + (i + 1)}`;
    btn.addEventListener("click", () => {
      sigPlacementRefreshChain = sigPlacementRefreshChain
        .then(() => sigBoxEditor.goToFileLastPage(i))
        .catch((err) => console.error("goToFileLastPage failed:", err));
    });
    wrap.appendChild(btn);
  }
}

function makeSigTabChip(wrap, key, label, detectText) {
  if (!sigBoxEditor) return;
  const placed = sigBoxEditor.getPlacements(key) !== null;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "checkbox-pill" + (placed ? " selected" : "");
  chip.textContent = (placed ? "✓ " : "") + label;
  chip.addEventListener("click", () => {
    sigPlacementRefreshChain = sigPlacementRefreshChain
      .then(() => sigBoxEditor.selectApprover(key, label, detectText))
      .then(() => {
        activeSigApproverId = key;
        activeSigApproverName = label;
        renderSigApproverTabs();
        updateApplyAllButton();
      })
      .catch((err) => console.error("selectApprover failed:", err));
  });
  wrap.appendChild(chip);
}

function renderSigApproverTabs() {
  const wrap = document.getElementById("req-sig-approver-tabs");
  wrap.innerHTML = "";
  if (preparerSignatureBlob) makeSigTabChip(wrap, "__preparer", "🖊️ ผู้จัดทำ", "ผู้จัดทำ");
  if (reviewerSignatureBlob) makeSigTabChip(wrap, "__reviewer", "🖊️ ผู้ตรวจสอบ", "ผู้ตรวจสอบ");
  [...selectedApproverIds].forEach((id) => {
    const approver = rosterCache.find((a) => a.id === id);
    if (!approver || !sigBoxEditor) return;
    makeSigTabChip(wrap, id, approver.name, "ผู้อนุมัติ");
  });
}

// ---------- ฟอร์มสร้างคำขอ: รายการเบิก (เฉพาะประเภทค่าใช้จ่าย) ----------

function addExpenseItemRow() {
  expenseItems.push({ description: "", amount: "" });
  renderExpenseItems();
}

function renderExpenseItems() {
  const el = document.getElementById("expense-items-list");
  el.innerHTML = "";
  expenseItems.forEach((item, idx) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:8px; margin-bottom:8px; align-items:center;";
    row.innerHTML = `
      <input type="text" placeholder="รายละเอียด" data-field="description" style="flex:2;" value="${item.description.replace(/"/g, "&quot;")}" />
      <input type="number" placeholder="จำนวนเงิน" min="0" step="0.01" data-field="amount" style="flex:1;" value="${item.amount}" />
      <button class="btn-ghost" type="button" data-remove>ลบ</button>
    `;
    row.querySelector('[data-field="description"]').addEventListener("input", (e) => {
      expenseItems[idx].description = e.target.value;
    });
    row.querySelector('[data-field="amount"]').addEventListener("input", (e) => {
      expenseItems[idx].amount = e.target.value;
      updateExpenseItemsTotal();
    });
    row.querySelector("[data-remove]").addEventListener("click", () => {
      expenseItems.splice(idx, 1);
      if (!expenseItems.length) expenseItems.push({ description: "", amount: "" });
      renderExpenseItems();
      updateExpenseItemsTotal();
    });
    el.appendChild(row);
  });
  updateExpenseItemsTotal();
}

function updateExpenseItemsTotal() {
  const total = expenseItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  document.getElementById("expense-items-total").textContent = baht(total);
}

document.getElementById("add-item-row-btn").addEventListener("click", addExpenseItemRow);

// ---------- ฟอร์มสร้างคำขอ: ลายเซ็นแบบแนบรูป (ลบพื้นหลังอัตโนมัติ) — ใช้ร่วมกัน ----------
// ผู้เบิก (ค่าใช้จ่าย), ผู้จัดทำ/ผู้ตรวจสอบ (เอกสารอื่นๆ)

async function processSignatureImageToCanvas(file, canvas) {
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });

  const maxDim = 500;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // ลบพื้นหลังสีอ่อน/สีขาว ให้เหลือแต่เส้นลายเซ็น (ทำให้โปร่งใส)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const THRESHOLD = 200;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > THRESHOLD && g > THRESHOLD && b > THRESHOLD) {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function wireSignatureImageUpload({ dropId, inputId, canvasId, previewWrapId, clearBtnId, onChange }) {
  const drop = document.getElementById(dropId);
  const input = document.getElementById(inputId);
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const canvas = document.getElementById(canvasId);
    const blob = await processSignatureImageToCanvas(file, canvas);
    document.getElementById(previewWrapId).style.display = "block";
    onChange(blob);
  });
  document.getElementById(clearBtnId).addEventListener("click", () => {
    document.getElementById(previewWrapId).style.display = "none";
    onChange(null);
  });
}

wireSignatureImageUpload({
  dropId: "req-sig-drop",
  inputId: "req-sig-input",
  canvasId: "req-sig-preview",
  previewWrapId: "req-sig-preview-wrap",
  clearBtnId: "req-sig-clear-btn",
  onChange: (blob) => (requesterSignatureBlob = blob),
});

wireSignatureImageUpload({
  dropId: "preparer-sig-drop",
  inputId: "preparer-sig-input",
  canvasId: "preparer-sig-preview",
  previewWrapId: "preparer-sig-preview-wrap",
  clearBtnId: "preparer-sig-clear-btn",
  onChange: (blob) => {
    preparerSignatureBlob = blob;
    refreshSigPlacementUI();
  },
});

wireSignatureImageUpload({
  dropId: "reviewer-sig-drop",
  inputId: "reviewer-sig-input",
  canvasId: "reviewer-sig-preview",
  previewWrapId: "reviewer-sig-preview-wrap",
  clearBtnId: "reviewer-sig-clear-btn",
  onChange: (blob) => {
    reviewerSignatureBlob = blob;
    refreshSigPlacementUI();
  },
});

// ---------- ฟอร์มสร้างคำขอ: แนบไฟล์ PDF ----------

const fileDrop = document.getElementById("file-drop");
const fileInput = document.getElementById("file-input");

fileDrop.addEventListener("click", () => fileInput.click());
fileDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileDrop.style.borderColor = "var(--accent)";
});
fileDrop.addEventListener("dragleave", () => (fileDrop.style.borderColor = ""));
fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  fileDrop.style.borderColor = "";
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

function addFiles(fileList) {
  Array.from(fileList).forEach((f) => {
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) return;
    const exists = selectedFiles.some((sf) => sf.name === f.name && sf.size === f.size);
    if (!exists) {
      selectedFiles.push(f);
      selectedFileLabels.push("");
    }
  });
  renderFileList();
  refreshSigPlacementUI();
}

function renderFileList() {
  const el = document.getElementById("file-list");
  el.innerHTML = "";
  if (selectedFiles.length > 1) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.marginBottom = "6px";
    hint.textContent = "ถ้ามีหลายชุดปนกัน (เช่น ใบเสนอราคา + PO หลายใบ) ใส่ป้ายกำกับให้ไฟล์ที่เป็นชุดเดียวกัน ระบบจะจัดกลุ่มแสดงให้ผู้บริหารดูง่ายขึ้น";
    el.appendChild(hint);
  }
  selectedFiles.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "file-row";
    row.style.flexWrap = "wrap";
    row.innerHTML =
      `<span>📄 ${f.name} (${(f.size / 1024).toFixed(0)} KB)</span>` +
      `<button class="btn-ghost" type="button" data-idx="${idx}">ลบ</button>`;
    if (selectedFiles.length > 1) {
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.placeholder = "ป้ายกำกับชุด (ถ้ามี) เช่น PO #1";
      labelInput.value = selectedFileLabels[idx] || "";
      labelInput.style.cssText = "width:100%; margin-top:6px; font-size:13px; padding:6px 10px;";
      labelInput.addEventListener("input", (e) => {
        selectedFileLabels[idx] = e.target.value;
      });
      row.appendChild(labelInput);
    }
    row.querySelector("button").addEventListener("click", () => {
      selectedFiles.splice(idx, 1);
      selectedFileLabels.splice(idx, 1);
      renderFileList();
      refreshSigPlacementUI();
    });
    el.appendChild(row);
  });
}

// ---------- ฟอร์มสร้างคำขอ: เลือกผู้บริหาร ----------

async function loadApproverSelect() {
  const { data, error } = await sb
    .from("approvers_roster")
    .select("*")
    .eq("active", true)
    .order("name", { ascending: true });
  if (error) return;
  rosterCache = data || [];
  const group = document.getElementById("approver-select-group");
  const hint = document.getElementById("approver-select-hint");
  group.innerHTML = "";
  selectedApproverIds = new Set();
  if (!rosterCache.length) {
    hint.style.display = "block";
    return;
  }
  hint.style.display = "none";
  rosterCache.forEach((a) => {
    const pill = document.createElement("label");
    pill.className = "checkbox-pill";
    pill.innerHTML = `<input type="checkbox" value="${a.id}" /> ${a.name} — ${a.position}`;
    pill.addEventListener("click", () => {
      const input = pill.querySelector("input");
      input.checked = !input.checked;
      pill.classList.toggle("selected", input.checked);
      if (input.checked) selectedApproverIds.add(a.id);
      else selectedApproverIds.delete(a.id);
      refreshSigPlacementUI();
    });
    group.appendChild(pill);
  });
}

// ---------- ฟอร์มสร้างคำขอ: ยืนยันส่ง ----------

function showNewRequestError(msg) {
  const el = document.getElementById("new-request-error");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

document.getElementById("submit-request-btn").addEventListener("click", async () => {
  showNewRequestError("");
  const typeInput = document.querySelector('#request-type-group input:checked');
  const subtypeInput = document.querySelector('#expense-subtype-group input:checked');
  const title = document.getElementById("req-title").value.trim();
  const requesterName = document.getElementById("req-requester").value.trim();
  const description = document.getElementById("req-desc").value.trim();
  const amountRaw = document.getElementById("req-amount").value;
  const isExpense = typeInput && typeInput.value === "expense";

  const cleanItems = isExpense
    ? expenseItems
        .map((it) => ({ description: it.description.trim(), amount: Number(it.amount) || 0 }))
        .filter((it) => it.description && it.amount > 0)
    : [];

  if (!typeInput) return showNewRequestError("กรุณาเลือกประเภทคำขอ");
  if (isExpense && !subtypeInput) return showNewRequestError("กรุณาเลือกประเภทค่าใช้จ่าย");
  if (!title) return showNewRequestError("กรุณากรอกหัวข้อ");
  if (!requesterName) return showNewRequestError("กรุณากรอกชื่อผู้เบิก/ผู้ขออนุมัติ");
  if (isExpense && !cleanItems.length) return showNewRequestError("กรุณากรอกรายการเบิกอย่างน้อย 1 รายการ (มีทั้งรายละเอียดและจำนวนเงิน)");
  if (!isExpense && !selectedFiles.length) return showNewRequestError("กรุณาแนบไฟล์ PDF อย่างน้อย 1 ไฟล์");
  if (!selectedApproverIds.size) return showNewRequestError("กรุณาเลือกผู้บริหารอย่างน้อย 1 คน");
  if (!isExpense && sigBoxEditor) {
    const missing = [...selectedApproverIds].filter((id) => !sigBoxEditor.getPlacements(id));
    if (missing.length) return showNewRequestError("กรุณาวางตำแหน่งลายเซ็นให้ครบทุกคนที่เลือกไว้ก่อนส่งคำขอ");
    if (preparerSignatureBlob && !sigBoxEditor.getPlacements("__preparer")) {
      return showNewRequestError("กรุณาวางตำแหน่งลายเซ็นผู้จัดทำก่อนส่งคำขอ (คลิกที่แท็บ 🖊️ ผู้จัดทำ)");
    }
    if (reviewerSignatureBlob && !sigBoxEditor.getPlacements("__reviewer")) {
      return showNewRequestError("กรุณาวางตำแหน่งลายเซ็นผู้ตรวจสอบก่อนส่งคำขอ (คลิกที่แท็บ 🖊️ ผู้ตรวจสอบ)");
    }
  }

  const btn = document.getElementById("submit-request-btn");
  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";

  try {
    const computedTotal = cleanItems.reduce((sum, it) => sum + it.amount, 0);
    const { data: reqRow, error: reqErr } = await sb
      .from("requests")
      .insert({
        request_type: typeInput.value,
        expense_subtype: isExpense ? subtypeInput.value : null,
        title,
        requester_name: requesterName,
        description: description || null,
        amount: isExpense ? computedTotal : amountRaw ? Number(amountRaw) : null,
        expense_items: cleanItems,
      })
      .select()
      .single();
    if (reqErr) throw reqErr;
    const requestId = reqRow.id;

    let sortOrder = 0;

    if (isExpense) {
      const formLabel = subtypeInput.value === "petty_cash" ? "ใบเบิกเงินสดย่อย" : "ใบเบิกเงิน";
      const dateStr = new Date().toLocaleDateString("th-TH", { dateStyle: "long" });
      const formPdfBytes = await buildExpenseFormPdf({
        subtype: subtypeInput.value,
        requesterName,
        dateStr,
        items: cleanItems,
        requesterSignaturePngBytes: requesterSignatureBlob ? await requesterSignatureBlob.arrayBuffer() : null,
      });
      const formPath = `${requestId}/${Date.now()}_0_${sanitizeForStorageKey(formLabel + ".pdf")}`;
      const { error: formUpErr } = await sb.storage
        .from(FILES_BUCKET)
        .upload(formPath, new Blob([formPdfBytes], { type: "application/pdf" }), { contentType: "application/pdf" });
      if (formUpErr) throw formUpErr;
      const { error: formRowErr } = await sb.from("request_files").insert({
        request_id: requestId,
        file_name: formLabel + ".pdf",
        storage_path: formPath,
        sort_order: sortOrder++,
      });
      if (formRowErr) throw formRowErr;
    }

    for (let i = 0; i < selectedFiles.length; i++) {
      const f = selectedFiles[i];
      const path = `${requestId}/${Date.now()}_${sortOrder}_${sanitizeForStorageKey(f.name)}`;
      const { error: upErr } = await sb.storage.from(FILES_BUCKET).upload(path, f, {
        contentType: "application/pdf",
      });
      if (upErr) throw upErr;
      const { error: fileRowErr } = await sb.from("request_files").insert({
        request_id: requestId,
        file_name: f.name,
        storage_path: path,
        sort_order: sortOrder++,
        group_label: selectedFileLabels[i] ? selectedFileLabels[i].trim() || null : null,
      });
      if (fileRowErr) throw fileRowErr;
    }

    if (!isExpense && (preparerSignatureBlob || reviewerSignatureBlob)) {
      const fixedSigUpdate = {};
      if (preparerSignatureBlob) {
        const path = `${requestId}/preparer_${Date.now()}.png`;
        const { error: upErr } = await sb.storage.from(SIGNATURES_BUCKET).upload(path, preparerSignatureBlob, {
          contentType: "image/png",
        });
        if (upErr) throw upErr;
        fixedSigUpdate.preparer_signature_path = path;
        fixedSigUpdate.preparer_sig_boxes = sigBoxEditor.getPlacements("__preparer") || [];
      }
      if (reviewerSignatureBlob) {
        const path = `${requestId}/reviewer_${Date.now()}.png`;
        const { error: upErr } = await sb.storage.from(SIGNATURES_BUCKET).upload(path, reviewerSignatureBlob, {
          contentType: "image/png",
        });
        if (upErr) throw upErr;
        fixedSigUpdate.reviewer_signature_path = path;
        fixedSigUpdate.reviewer_sig_boxes = sigBoxEditor.getPlacements("__reviewer") || [];
      }
      const { error: fixedSigErr } = await sb.from("requests").update(fixedSigUpdate).eq("id", requestId);
      if (fixedSigErr) throw fixedSigErr;
    }

    const links = [];
    for (const approverId of selectedApproverIds) {
      const approver = rosterCache.find((a) => a.id === approverId);
      const approverPayload = {
        request_id: requestId,
        approver_name: approver.name,
        approver_position: approver.position,
      };
      if (!isExpense && sigBoxEditor) {
        approverPayload.sig_boxes = sigBoxEditor.getPlacements(approverId);
      }
      const { data: apRow, error: apErr } = await sb
        .from("request_approvers")
        .insert(approverPayload)
        .select()
        .single();
      if (apErr) throw apErr;
      links.push({
        name: approver.name,
        position: approver.position,
        token: apRow.sign_token,
        larkUserId: approver.lark_user_id || null,
      });
    }

    showResultLinks(links);
    notifyApproversViaLark(links, title, requesterName);
    resetNewRequestForm();
  } catch (err) {
    showNewRequestError(err.message || "เกิดข้อผิดพลาด กรุณาลองใหม่");
  } finally {
    btn.disabled = false;
    btn.textContent = "ยืนยันสร้างคำขอ";
  }
});

function showResultLinks(links) {
  const container = document.getElementById("result-links");
  container.innerHTML = "";
  links.forEach((l, idx) => {
    const url = signLinkFor(l.token);
    const row = document.createElement("div");
    row.className = "link-row";
    const larkNote = l.larkUserId ? `<div class="hint" id="lark-status-${idx}">🔔 กำลังส่งแจ้งเตือนเข้า Lark...</div>` : "";
    row.innerHTML =
      `<div><strong>${l.name}</strong> <span style="color:var(--text-muted); font-size:12px;">(${l.position})</span><br/><span class="link-text">${url}</span>${larkNote}</div>` +
      `<button class="btn-secondary" type="button">คัดลอกลิงก์</button>`;
    row.querySelector("button").addEventListener("click", (e) => copyToClipboard(url, e.target));
    container.appendChild(row);
  });
  document.querySelector("#tab-new-request .card:first-child").style.display = "none";
  document.getElementById("result-card").style.display = "block";
}

// ---------- แจ้งเตือนเข้า Lark chat (ถ้าผู้อนุมัติมี lark_user_id ในระบบ) ----------

async function notifyApproversViaLark(links, requestTitle, requesterName) {
  const projectRef = window.SUPABASE_CONFIG.url.replace(/^https?:\/\//, "").replace(/\.supabase\.co\/?$/, "");
  const fnUrl = `https://${projectRef}.supabase.co/functions/v1/notify-lark`;

  links.forEach(async (l, idx) => {
    if (!l.larkUserId) return;
    const statusEl = document.getElementById(`lark-status-${idx}`);
    try {
      const res = await fetch(fnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: window.SUPABASE_CONFIG.anonKey },
        body: JSON.stringify({
          larkUserId: l.larkUserId,
          requestTitle,
          requesterName,
          signLink: signLinkFor(l.token),
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (statusEl) statusEl.textContent = "✅ ส่งแจ้งเตือนเข้า Lark แล้ว";
    } catch (err) {
      console.warn("notify-lark failed (ระบบแจ้งเตือน Lark อาจยังไม่ได้ตั้งค่า):", err);
      if (statusEl) statusEl.textContent = "⚠️ ส่งแจ้งเตือน Lark ไม่สำเร็จ — ส่งลิงก์เองแทนได้";
    }
  });
}

document.getElementById("create-another-btn").addEventListener("click", () => {
  document.getElementById("result-card").style.display = "none";
  document.querySelector("#tab-new-request .card:first-child").style.display = "block";
});

function resetNewRequestForm() {
  document.getElementById("req-title").value = "";
  document.getElementById("req-requester").value = "";
  document.getElementById("req-desc").value = "";
  document.getElementById("req-amount").value = "";
  document.querySelectorAll('#request-type-group .radio-pill, #expense-subtype-group .radio-pill').forEach((p) =>
    p.classList.remove("selected")
  );
  document.querySelectorAll('#request-type-group input, #expense-subtype-group input').forEach((i) => (i.checked = false));
  document.getElementById("expense-subtype-block").style.display = "none";
  document.getElementById("expense-items-block").style.display = "none";
  document.getElementById("amount-block").style.display = "block";
  selectedFiles = [];
  selectedFileLabels = [];
  renderFileList();
  expenseItems = [{ description: "", amount: "" }];
  renderExpenseItems();
  requesterSignatureBlob = null;
  document.getElementById("req-sig-preview-wrap").style.display = "none";
  preparerSignatureBlob = null;
  document.getElementById("preparer-sig-preview-wrap").style.display = "none";
  reviewerSignatureBlob = null;
  document.getElementById("reviewer-sig-preview-wrap").style.display = "none";
  sigBoxEditor = null;
  sigBoxEditorFilesKey = "";
  activeSigApproverId = null;
  activeSigApproverName = "";
  document.getElementById("req-sig-placement-block").style.display = "none";
  loadApproverSelect(); // จะไปเรียก refreshSigPlacementUI ต่อผ่าน selectedApproverIds = new Set()
}

// ---------- รายการคำขอ ----------

async function loadRequestList() {
  const body = document.getElementById("request-list-body");
  body.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
  const { data, error } = await sb
    .from("requests")
    .select("*, request_approvers(*), request_files(*)")
    .order("created_at", { ascending: false });
  if (error) {
    body.innerHTML = `<div class="error-msg">โหลดรายการไม่สำเร็จ: ${error.message}</div>`;
    return;
  }
  if (!data.length) {
    body.innerHTML = '<div class="empty-state">ยังไม่มีคำขออนุมัติ</div>';
    return;
  }
  body.innerHTML = "";
  data.forEach((req) => body.appendChild(renderRequestItem(req)));
}

function renderRequestItem(req) {
  const total = req.request_approvers.length;
  const signed = req.request_approvers.filter((a) => a.status === "signed").length;
  const isApproved = req.status === "approved" || (total > 0 && signed === total);

  const item = document.createElement("div");
  item.className = "req-item";

  const pillHtml = isApproved
    ? `<span class="pill pill-approved">อนุมัติแล้ว</span>`
    : `<span class="pill pill-pending">รอเซ็น ${signed}/${total}</span>`;

  item.innerHTML = `
    <div class="req-head">
      <div>
        <div class="req-title">${req.title}</div>
        <div class="req-meta">${requestTypeLabel(req)}${req.requester_name ? " · ผู้เบิก " + req.requester_name : ""} · สร้างเมื่อ ${formatDateTime(req.created_at)}</div>
      </div>
      <div class="req-amount">${baht(req.amount)}<br/>${pillHtml}</div>
    </div>
    <div class="req-detail"></div>
  `;

  const head = item.querySelector(".req-head");
  const detail = item.querySelector(".req-detail");
  head.addEventListener("click", () => {
    detail.classList.toggle("open");
    if (detail.classList.contains("open") && !detail.dataset.rendered) {
      renderRequestDetail(detail, req, isApproved);
      detail.dataset.rendered = "1";
    }
  });

  return item;
}

function renderRequestDetail(detail, req, isApproved) {
  let html = "";
  if (req.description) {
    html += `<p style="margin-top:0; font-size:14px; color:var(--text-muted);">${req.description}</p>`;
  }

  if (req.request_files.length) {
    html += `<div class="hint" style="margin-bottom:6px;">ไฟล์แนบ:</div>`;
    const sortedFiles = [...req.request_files].sort((a, b) => a.sort_order - b.sort_order);
    const groups = new Map();
    sortedFiles.forEach((f) => {
      const label = f.group_label && f.group_label.trim() ? f.group_label.trim() : null;
      const key = label || `__single_${f.id}`;
      if (!groups.has(key)) groups.set(key, { label, files: [] });
      groups.get(key).files.push(f);
    });
    groups.forEach((group) => {
      if (group.label) {
        html += `<div style="font-weight:600; font-size:13px; margin:8px 0 2px;">📁 ${group.label}</div>`;
      }
      group.files.forEach((f) => {
        const { data } = sb.storage.from(FILES_BUCKET).getPublicUrl(f.storage_path);
        html += `<div class="file-row"><span>📄 ${f.file_name}</span><a href="${data.publicUrl}" target="_blank" class="btn-ghost" style="text-decoration:none; padding:4px 10px;">เปิดดู</a></div>`;
      });
    });
  }

  html += `<div class="hint" style="margin:12px 0 4px;">ผู้อนุมัติ:</div>`;
  detail.innerHTML = html;

  req.request_approvers.forEach((a) => {
    const row = document.createElement("div");
    row.className = "approver-row";
    if (a.status === "signed") {
      row.innerHTML = `<div><span class="name">${a.approver_name}</span> <span class="pos">${a.approver_position}</span></div><span class="pill pill-approved">เซ็นแล้ว ${formatDateTime(a.signed_at)}</span>`;
    } else {
      const url = signLinkFor(a.sign_token);
      row.innerHTML = `<div><span class="name">${a.approver_name}</span> <span class="pos">${a.approver_position}</span></div>`;
      const btn = document.createElement("button");
      btn.className = "btn-secondary";
      btn.textContent = "คัดลอกลิงก์เซ็น";
      btn.addEventListener("click", () => copyToClipboard(url, btn));
      row.appendChild(btn);
    }
    detail.appendChild(row);
  });

  if (isApproved && req.signed_pdf_path) {
    const { data } = sb.storage.from(FILES_BUCKET).getPublicUrl(req.signed_pdf_path);
    const dl = document.createElement("a");
    dl.href = data.publicUrl;
    dl.target = "_blank";
    dl.className = "btn-primary";
    dl.style.cssText = "display:inline-block; text-decoration:none; margin-top:12px;";
    dl.textContent = "📥 ดาวน์โหลด PDF ที่เซ็นแล้ว";
    detail.appendChild(dl);
  }
}

// ---------- จัดการผู้บริหาร ----------

function showRosterError(msg) {
  const el = document.getElementById("roster-error");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

document.getElementById("add-roster-btn").addEventListener("click", async () => {
  const name = document.getElementById("roster-name").value.trim();
  const position = document.getElementById("roster-position").value.trim();
  const larkUserId = document.getElementById("roster-lark-id").value.trim();
  showRosterError("");
  if (!name || !position) return showRosterError("กรอกชื่อและตำแหน่งให้ครบ");

  const btn = document.getElementById("add-roster-btn");
  btn.disabled = true;
  try {
    const { error } = await sb.from("approvers_roster").insert({ name, position, lark_user_id: larkUserId || null });
    if (error) throw error;
    document.getElementById("roster-name").value = "";
    document.getElementById("roster-position").value = "";
    document.getElementById("roster-lark-id").value = "";
    loadRosterTable();
    loadApproverSelect();
  } catch (err) {
    showRosterError(err.message || "เกิดข้อผิดพลาด");
  } finally {
    btn.disabled = false;
  }
});

async function loadRosterTable() {
  const body = document.getElementById("roster-table-body");
  body.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
  const { data, error } = await sb.from("approvers_roster").select("*").order("name", { ascending: true });
  if (error) {
    body.innerHTML = `<div class="error-msg">โหลดรายชื่อไม่สำเร็จ: ${error.message}</div>`;
    return;
  }
  rosterAllCache = data || [];
  if (!rosterAllCache.length) {
    body.innerHTML = '<div class="empty-state">ยังไม่มีรายชื่อผู้บริหาร</div>';
    return;
  }
  const table = document.createElement("table");
  table.className = "roster-table";
  table.innerHTML = "<thead><tr><th>ชื่อ</th><th>ตำแหน่ง</th><th>อีเมล Lark</th><th>สถานะ</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  rosterAllCache.forEach((a) => {
    const tr = document.createElement("tr");
    const statusPill = a.active
      ? `<span class="pill pill-approved">ใช้งานอยู่</span>`
      : `<span class="pill" style="background:#eee; color:#888;">ปิดใช้งาน</span>`;
    tr.innerHTML = `<td>${a.name}</td><td>${a.position}</td><td></td><td>${statusPill}</td><td></td>`;

    const larkCell = tr.children[2];
    larkCell.style.cssText = "display:flex; gap:6px; align-items:center;";
    const larkInput = document.createElement("input");
    larkInput.type = "email";
    larkInput.value = a.lark_user_id || "";
    larkInput.placeholder = "อีเมล Lark";
    larkInput.style.cssText = "font-size:12px; padding:6px 8px;";
    const larkSaveBtn = document.createElement("button");
    larkSaveBtn.className = "btn-ghost";
    larkSaveBtn.textContent = "บันทึก";
    larkSaveBtn.addEventListener("click", async () => {
      larkSaveBtn.disabled = true;
      await sb.from("approvers_roster").update({ lark_user_id: larkInput.value.trim() || null }).eq("id", a.id);
      larkSaveBtn.textContent = "บันทึกแล้ว ✓";
      setTimeout(() => (larkSaveBtn.textContent = "บันทึก"), 1500);
      larkSaveBtn.disabled = false;
    });
    larkCell.appendChild(larkInput);
    larkCell.appendChild(larkSaveBtn);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = a.active ? "btn-danger" : "btn-secondary";
    toggleBtn.textContent = a.active ? "ปิดใช้งาน" : "เปิดใช้งาน";
    toggleBtn.addEventListener("click", async () => {
      toggleBtn.disabled = true;
      await sb.from("approvers_roster").update({ active: !a.active }).eq("id", a.id);
      loadRosterTable();
      loadApproverSelect();
    });
    tr.lastElementChild.appendChild(toggleBtn);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  body.innerHTML = "";
  body.appendChild(table);
}
