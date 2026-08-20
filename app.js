// ============================================================
// ระบบขออนุมัติเอกสาร — หน้าพนักงาน (index.html)
// ============================================================

const sb = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

const FILES_BUCKET = "esign-files";

let selectedFiles = []; // File[]
let expenseItems = []; // [{ description, amount }]
let selectedApproverIds = new Set();
let rosterCache = []; // approvers_roster rows (active only, for select)
let rosterAllCache = []; // approvers_roster rows (all, for management table)

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
  document.getElementById("expense-subtype-block").style.display = isExpense ? "block" : "none";
  document.getElementById("expense-items-block").style.display = isExpense ? "block" : "none";
  document.getElementById("amount-block").style.display = isExpense ? "none" : "block";
  if (isExpense && !expenseItems.length) addExpenseItemRow();
});
setupPillGroup("expense-subtype-group");

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
    if (!exists) selectedFiles.push(f);
  });
  renderFileList();
}

function renderFileList() {
  const el = document.getElementById("file-list");
  el.innerHTML = "";
  selectedFiles.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML =
      `<span>📄 ${f.name} (${(f.size / 1024).toFixed(0)} KB)</span>` +
      `<button class="btn-ghost" type="button" data-idx="${idx}">ลบ</button>`;
    row.querySelector("button").addEventListener("click", () => {
      selectedFiles.splice(idx, 1);
      renderFileList();
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
      });
      if (fileRowErr) throw fileRowErr;
    }

    const links = [];
    for (const approverId of selectedApproverIds) {
      const approver = rosterCache.find((a) => a.id === approverId);
      const { data: apRow, error: apErr } = await sb
        .from("request_approvers")
        .insert({
          request_id: requestId,
          approver_name: approver.name,
          approver_position: approver.position,
        })
        .select()
        .single();
      if (apErr) throw apErr;
      links.push({ name: approver.name, position: approver.position, token: apRow.sign_token });
    }

    showResultLinks(links);
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
  links.forEach((l) => {
    const url = signLinkFor(l.token);
    const row = document.createElement("div");
    row.className = "link-row";
    row.innerHTML =
      `<div><strong>${l.name}</strong> <span style="color:var(--text-muted); font-size:12px;">(${l.position})</span><br/><span class="link-text">${url}</span></div>` +
      `<button class="btn-secondary" type="button">คัดลอกลิงก์</button>`;
    row.querySelector("button").addEventListener("click", (e) => copyToClipboard(url, e.target));
    container.appendChild(row);
  });
  document.querySelector("#tab-new-request .card:first-child").style.display = "none";
  document.getElementById("result-card").style.display = "block";
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
  renderFileList();
  expenseItems = [{ description: "", amount: "" }];
  renderExpenseItems();
  loadApproverSelect();
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
    req.request_files
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach((f) => {
        const { data } = sb.storage.from(FILES_BUCKET).getPublicUrl(f.storage_path);
        html += `<div class="file-row"><span>📄 ${f.file_name}</span><a href="${data.publicUrl}" target="_blank" class="btn-ghost" style="text-decoration:none; padding:4px 10px;">เปิดดู</a></div>`;
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
  showRosterError("");
  if (!name || !position) return showRosterError("กรอกชื่อและตำแหน่งให้ครบ");

  const btn = document.getElementById("add-roster-btn");
  btn.disabled = true;
  try {
    const { error } = await sb.from("approvers_roster").insert({ name, position });
    if (error) throw error;
    document.getElementById("roster-name").value = "";
    document.getElementById("roster-position").value = "";
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
  table.innerHTML = "<thead><tr><th>ชื่อ</th><th>ตำแหน่ง</th><th>สถานะ</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  rosterAllCache.forEach((a) => {
    const tr = document.createElement("tr");
    const statusPill = a.active
      ? `<span class="pill pill-approved">ใช้งานอยู่</span>`
      : `<span class="pill" style="background:#eee; color:#888;">ปิดใช้งาน</span>`;
    tr.innerHTML = `<td>${a.name}</td><td>${a.position}</td><td>${statusPill}</td><td></td>`;
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
