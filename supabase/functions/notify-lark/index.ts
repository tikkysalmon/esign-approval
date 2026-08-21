// ============================================================
// Supabase Edge Function: ส่งแจ้งเตือนเข้า Lark chat ให้ผู้บริหาร
// เมื่อมีคำขอใหม่ให้เซ็นอนุมัติ
//
// วิธี deploy (ทำครั้งเดียว หลังได้ App ID/App Secret ของ Lark app แล้ว):
//   1. ติดตั้ง Supabase CLI: npm install -g supabase
//   2. supabase login
//   3. supabase link --project-ref <project-ref-จาก-Supabase-URL>
//   4. supabase secrets set LARK_APP_ID=xxx LARK_APP_SECRET=xxx
//   5. supabase functions deploy notify-lark --no-verify-jwt
//
// เว็บฝั่งพนักงาน (app.js) จะเรียก endpoint นี้เองอัตโนมัติหลังสร้างคำขอ
// (ดูฟังก์ชัน notifyApproversViaLark ใน app.js) — ถ้ายังไม่ deploy ฟังก์ชันนี้
// เว็บจะ fail แบบเงียบๆ ไม่กระทบการสร้างคำขอ
// ============================================================

const LARK_APP_ID = Deno.env.get("LARK_APP_ID");
const LARK_APP_SECRET = Deno.env.get("LARK_APP_SECRET");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getTenantAccessToken(): Promise<string> {
  const res = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
  });
  const data = await res.json();
  if (!data.tenant_access_token) throw new Error("ขอ tenant_access_token จาก Lark ไม่สำเร็จ: " + JSON.stringify(data));
  return data.tenant_access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return new Response(JSON.stringify({ error: "ยังไม่ได้ตั้งค่า LARK_APP_ID / LARK_APP_SECRET" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { larkUserId, requestTitle, requesterName, signLink } = await req.json();
    if (!larkUserId || !signLink) {
      return new Response(JSON.stringify({ error: "ขาด larkUserId หรือ signLink" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const token = await getTenantAccessToken();
    const text =
      `📝 มีคำขออนุมัติใหม่รอเซ็น\n` +
      `เรื่อง: ${requestTitle}\n` +
      (requesterName ? `ผู้เบิก: ${requesterName}\n` : "") +
      `เปิดดูและเซ็นเอกสารได้ที่ลิงก์นี้:\n${signLink}`;

    const sendRes = await fetch("https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        receive_id: larkUserId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
    const sendData = await sendRes.json();
    if (sendData.code !== 0) throw new Error("ส่งข้อความ Lark ไม่สำเร็จ: " + JSON.stringify(sendData));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
