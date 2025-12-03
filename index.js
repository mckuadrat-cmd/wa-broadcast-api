// index.js
// MCKuadrat WA Broadcast API (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

const { Pool } = require("pg");

// Pool Postgres (Railway)
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ====== CONFIG DARI ENV ======
const WABA_ID    = process.env.WABA_ID;          // ID WhatsApp Business Account
const WA_TOKEN   = process.env.WA_TOKEN;         // Permanent token
const WA_VERSION = process.env.WA_VERSION || "v21.0";

// PHONE_NUMBER_ID default (kalau tidak dipilih dari dropdown di frontend)
const DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Token verifikasi webhook (untuk Facebook Developer → Webhooks)
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "MCKUADRAT_WEBHOOK_TOKEN";

// Optional: pesan & dokumen default untuk follow-up "Bersedia"
const FOLLOWUP_MESSAGE_TEXT =
  process.env.FOLLOWUP_MESSAGE_TEXT ||
  "Terima kasih, Bapak/Ibu sudah bersedia. Informasi lebih lanjut akan kami sampaikan melalui pesan ini.";

const FOLLOWUP_DOCUMENT_URL = process.env.FOLLOWUP_DOCUMENT_URL || "";

// PORT Railway otomatis pakai process.env.PORT
const PORT = process.env.PORT || 3000;

// Menyimpan konfigurasi follow-up terakhir dari frontend
let lastFollowupConfig = null;
// Menyimpan mapping nomor → row broadcast terakhir (untuk var & attachment per-orang)
let lastBroadcastRowsByPhone = {};

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());

// ====== ROOT SIMPLE CEK ONLINE ======
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

async function getTemplateParamCount(templateName) {
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/v19.0/${process.env.WABA_BUSINESS_ID}/message_templates`,
      {
        params: {
          name: templateName
        },
        headers: {
          Authorization: `Bearer ${process.env.WABA_TOKEN}`
        }
      }
    );

    const t = resp.data?.data?.[0];
    if (!t) return 1; // default 1 parameter

    // cari body template
    const bodyComponent = t.components?.find(c => c.type === "BODY");
    if (!bodyComponent || !bodyComponent.text) return 0;

    // hitung jumlah {{x}} dari body
    const matches = bodyComponent.text.match(/\{\{\d+\}\}/g);
    return matches ? matches.length : 0;
  } catch (err) {
    console.error("Gagal ambil template metadata:", err.response?.data || err);
    return 1; // fallback
  }
}

// =======================================================
// HELPER: Ambil daftar phone_numbers dari WABA
// =======================================================
async function getWabaPhoneNumbers() {
  if (!WABA_ID || !WA_TOKEN) {
    throw new Error("WABA_ID atau WA_TOKEN belum diset di server");
  }

  const url =
    `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/phone_numbers` +
    `?fields=id,display_phone_number,verified_name`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });

  return Array.isArray(resp.data?.data) ? resp.data.data : [];
}

// =======================================================
// 1) GET /kirimpesan/senders
//    Ambil daftar phone_number dari WABA (untuk dropdown Sender Number)
// =======================================================
app.get("/kirimpesan/senders", async (req, res) => {
  try {
    const rows = await getWabaPhoneNumbers();

    const senders = rows.map((r) => ({
      phone_number_id: r.id,
      phone: r.display_phone_number,
      label: `${r.display_phone_number} - ${(r.verified_name || r.display_phone_number)}`,
      name: r.verified_name || r.display_phone_number,
    }));

    res.json({
      status: "ok",
      count: senders.length,
      senders,
    });
  } catch (err) {
    console.error("Error /kirimpesan/senders:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// =======================================================
// 2) GET /kirimpesan/templates
//    Ambil daftar template dari Meta, filter status (default APPROVED)
// =======================================================
app.get("/kirimpesan/templates", async (req, res) => {
  try {
    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const status = req.query.status || "APPROVED";

    const url =
      `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates` +
      `?status=${encodeURIComponent(status)}`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });

    const templates = Array.isArray(resp.data?.data) ? resp.data.data : [];

    const simplified = templates.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      language: t.language,
      status: t.status,
      components: t.components,
    }));

    res.json({
      status: "ok",
      count: simplified.length,
      templates: simplified,
    });
  } catch (err) {
    console.error("Error /kirimpesan/templates:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// =======================================================
// 3) POST /kirimpesan/templates/create
//    Ajukan template baru ke Meta
//    Body JSON: { name, category, body_text, example_1, footer_text, buttons }
// =======================================================
app.post("/kirimpesan/templates/create", async (req, res) => {
  try {
    const {
      name,
      category,
      body_text,
      example_1,
      footer_text,
      buttons,
    } = req.body || {};

    if (!name || !category || !body_text) {
      return res.status(400).json({
        status: "error",
        error: "name, category, body_text wajib diisi",
      });
    }

    if (!WABA_ID || !WA_TOKEN) {
      return res
        .status(500)
        .json({ status: "error", error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`;

    const components = [
      {
        type: "BODY",
        text: body_text,
        ...(example_1 ? { example: { body_text: [[example_1]] } } : {}),
      },
    ];

    if (footer_text) {
      components.push({
        type: "FOOTER",
        text: footer_text,
      });
    }

    if (Array.isArray(buttons) && buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.slice(0, 3).map((label) => ({
          type: "QUICK_REPLY",
          text: label,
        })),
      });
    }

    const payload = {
      name,
      category, // "UTILITY" / "MARKETING" / "AUTHENTICATION"
      language: "en", // sementara pakai English (en)
      components,
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    res.json({
      status: "submitted",
      meta_response: resp.data,
    });
  } catch (err) {
    console.error("Error /kirimpesan/templates/create:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// =======================================================
// 4) Helper: kirim 1 WA template
//    arg: { phone, templateName, vars, phone_number_id }
// =======================================================
async function sendWaTemplate({ phone, templateName, vars, phone_number_id }) {
  const phoneId = phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId) {
    throw new Error("PHONE_NUMBER_ID belum diset");
  }

  const url = `https://graph.facebook.com/${WA_VERSION}/${phoneId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" }, // samakan dengan language template
      components: [
        {
          type: "body",
          parameters: (vars && vars.length > 0 ? vars : [""]).map((v) => ({
            type: "text",
            text: String(v ?? ""),
          })),
        },
      ],
    },
  };

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  const data = resp.data;

  return {
    phone,
    ok: true,
    status: resp.status,
    messageId: data?.messages?.[0]?.id ?? null,
    error: null,
  };
}

// =======================================================
// 5) Helper: kirim pesan custom (text + optional media)
//    arg: { to, text, media, phone_number_id }
// =======================================================
async function sendCustomMessage({ to, text, media, phone_number_id }) {
  const phoneId = phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId) {
    throw new Error("PHONE_NUMBER_ID belum diset");
  }

  const url = `https://graph.facebook.com/${WA_VERSION}/${phoneId}/messages`;

  let body;

  if (media && media.type && media.link) {
    const mType = media.type.toLowerCase(); // "document", "image", "video", "audio"

    const baseMediaPayload = {
      link: media.link,
    };

    if (text) {
      baseMediaPayload.caption = text;
    }

    // === khusus document: set filename supaya di WA muncul nama & format ===
    if (mType === "document") {
    
        // baca filename dari media.filename (frontend / webhook)
        let filename = media.filename;
    
        // fallback: coba ambil nama file dari URL
        if (!filename) {
          try {
            const urlObj   = new URL(media.link);
            const pathname = urlObj.pathname || "";
            const lastSeg  = pathname.split("/").filter(Boolean).pop() || "";
            filename = lastSeg && lastSeg.includes(".") ? lastSeg : "document.pdf";
          } catch {
            filename = "document.pdf";
          }
        }
    
        // pastikan ada ekstensi .pdf
        if (!filename.toLowerCase().endsWith(".pdf")) {
          filename = filename + ".pdf";
        }
    
        baseMediaPayload.link = media.link;
    
        if (text) {
          baseMediaPayload.caption = text;
        }
    
        // 🔥 FIX PALING PENTING → masukkan filename ke payload
        baseMediaPayload.filename = filename;
    }

    body = {
      messaging_product: "whatsapp",
      to,
      type: mType,
      [mType]: baseMediaPayload,
    };
  } else {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        preview_url: false,
        body: text || "",
      },
    };
  }

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return resp.data;
}

// =======================================================
// 6) POST /kirimpesan/broadcast  (PAKAI POSTGRES + SCHEDULE)
// =======================================================
app.post("/kirimpesan/broadcast", async (req, res) => {
  try {
    const {
      template_name,
      rows,
      phone_number_id,
      sender_phone,
      followup,
      scheduled_at
    } = req.body || {};

    if (!template_name) {
      return res.status(400).json({ status: "error", error: "template_name wajib diisi" });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", error: "rows harus array minimal 1" });
    }

    // --- cek apakah ini broadcast terjadwal? ---
    const JAKARTA_OFFSET_MIN = 7 * 60; // +07:00

    function parseJakartaLocalToUtc(str) {
      // str contoh: "2025-12-02T13:20" dari <input type="datetime-local">
      const dLocal = new Date(str);
      if (isNaN(dLocal.getTime())) return null;

      const localMs = dLocal.getTime();
      // konversi "jam Jakarta" → UTC
      const utcMs = localMs - JAKARTA_OFFSET_MIN * 60 * 1000;
      return new Date(utcMs);
    }

    let scheduledDate = null;
    let isScheduled = false;

    if (scheduled_at) {
      const dUtc = parseJakartaLocalToUtc(scheduled_at);
      if (dUtc) {
        scheduledDate = dUtc;

        // kalau jadwal lebih dari 15 detik ke depan → dianggap scheduled
        if (dUtc.getTime() > Date.now() + 15 * 1000) {
          isScheduled = true;
        }
      }
    }

    // === FOLLOW-UP CONFIG DARI FRONTEND (masih in-memory untuk webhook) ===
    if (followup && followup.text) {
      lastFollowupConfig = followup;
      lastBroadcastRowsByPhone = {};
      console.log("Updated followup config:", lastFollowupConfig);
    } else {
      lastFollowupConfig = null;
      lastBroadcastRowsByPhone = {};
      console.log("Followup disabled for this broadcast.");
    }

    // Buat ID unik untuk broadcast ini
    const broadcastId =
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

    // Resolve phone_number_id kalau cuma kirim sender_phone
    let effectivePhoneId = phone_number_id || null;

    if (!effectivePhoneId && sender_phone) {
      try {
        const phones = await getWabaPhoneNumbers();
        const match = phones.find(
          (p) =>
            String(p.display_phone_number).replace(/\s+/g, "") ===
            String(sender_phone).replace(/\s+/g, "")
        );
        if (match) {
          effectivePhoneId = match.id;
        } else {
          console.warn("sender_phone tidak ditemukan di WABA:", sender_phone);
        }
      } catch (e) {
        console.warn("Gagal resolve sender_phone → phone_number_id:", e.message);
      }
    }

    // --- 1. Simpan broadcast ke Postgres ---
    await pgPool.query(
      `INSERT INTO broadcasts (
         id, created_at, scheduled_at, status,
         template_name, sender_phone, phone_number_id, followup_enabled
       ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)`,
      [
        broadcastId,
        scheduledDate,                      // bisa null
        isScheduled ? "scheduled" : "sent", // status awal
        template_name,
        sender_phone || null,
        effectivePhoneId || null,
        !!(followup && followup.text)
      ]
    );

    // --- 2. Kalau SCHEDULED → cuma simpan penerima, BELUM kirim WA ---
    if (isScheduled) {
      for (const row of rows) {
        const phone = row.phone || row.to;
        if (!phone) continue;

        // siapkan vars_json
        const varsMap = {};
        Object.keys(row)
          .filter((k) => /^var\d+$/.test(k) && row[k] != null && row[k] !== "")
          .forEach((k) => {
            varsMap[k] = row[k];
          });

        const followMedia = row.follow_media || null;

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, NULL, NULL, NOW())`,
          [
            broadcastId,                                   // $1
            phone,                                         // $2
            Object.keys(varsMap).length ? varsMap : null, // $3
            followMedia                                    // $4
          ]
        );
      }

      return res.json({
        status: "scheduled",
        broadcast_id: broadcastId,
        template_name,
        scheduled_at: scheduledDate.toISOString(),
        count: rows.length
      });
    }

    // --- 3. Kalau TIDAK ada schedule → kirim langsung seperti biasa ---
    const results = [];

    for (const row of rows) {
      const phone = row.phone || row.to;
      if (!phone) continue;

      // Simpan mapping nomor → row + broadcastId (dipakai webhook)
      lastBroadcastRowsByPhone[String(phone)] = {
        row,
        broadcastId
      };

      // Ambil semua vars dari row (untuk disimpan di DB)
      let vars = row.vars;
      const varsMap = {};

      if (!Array.isArray(vars)) {
        const varKeys = Object.keys(row)
          .filter((k) => /^var\d+$/.test(k) && row[k] != null && row[k] !== "")
          .sort((a, b) => {
            const na = parseInt(a.replace("var", ""), 10);
            const nb = parseInt(b.replace("var", ""), 10);
            return na - nb;
          });

        vars = varKeys.map((k) => {
          varsMap[k] = row[k];
          return row[k];
        });
      } else {
        vars.forEach((v, idx) => {
          varsMap["var" + (idx + 1)] = v;
        });
      }

      // ⚠️ PENTING:
      // Template WA sekarang cuma punya {{1}},
      // jadi ke Meta kita kirim HANYA parameter pertama.
      const paramCount = await getTemplateParamCount(template_name);
      const varsForTemplate = vars.slice(0, paramCount);

      const followMedia = row.follow_media || null;

      try {
        const r = await sendWaTemplate({
          phone,
          templateName: template_name,
          vars: varsForTemplate,          // <= DI SINI pakai varsForTemplate
          phone_number_id: effectivePhoneId
        });

        results.push(r);

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            broadcastId,                                      // $1
            phone,                                            // $2
            Object.keys(varsMap).length ? varsMap : null,     // $3
            followMedia,                                      // $4
            true,                                             // $5
            r.status || null,                                 // $6
            null                                              // $7
          ]
        );
      } catch (err) {
        console.error("Broadcast error for", phone, err.response?.data || err.message);

        const errorPayload = err.response?.data || err.message;

        results.push({
          phone,
          ok: false,
          status: err.response?.status || 500,
          messageId: null,
          error: errorPayload
        });

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            broadcastId,                                      // $1
            phone,                                            // $2
            Object.keys(varsMap).length ? varsMap : null,     // $3
            followMedia,                                      // $4
            false,                                            // $5
            err.response?.status || null,                     // $6
            typeof errorPayload === "string"
              ? { message: errorPayload }
              : errorPayload                                  // $7
          ]
        );
      }
    }

    const total  = results.length;
    const ok     = results.filter((r) => r.ok).length;
    const failed = total - ok;

    res.json({
      status: "ok",
      broadcast_id: broadcastId,
      template_name,
      count: total,
      ok,
      failed,
      results
    });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast:", err);
    res.status(500).json({
      status: "error",
      error: String(err)
    });
  }
});

// =======================================================
// 7) POST /kirimpesan/custom
//    Kirim pesan bebas (text + optional media)
// =======================================================
app.post("/kirimpesan/custom", async (req, res) => {
  try {
    const { to, text, media, phone_number_id } = req.body || {};

    if (!to) {
      return res.status(400).json({ status: "error", error: "`to` (nomor tujuan) wajib diisi" });
    }
    if (!text && !media) {
      return res
        .status(400)
        .json({ status: "error", error: "Minimal text atau media harus diisi" });
    }

    const data = await sendCustomMessage({ to, text, media, phone_number_id });

    res.json({
      status: "ok",
      to,
      wa_response: data,
    });
  } catch (err) {
    console.error("Error /kirimpesan/custom:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// Helper umum untuk kirim payload WhatsApp mentah (dipakai di webhook follow-up)
async function sendWhatsApp(payload) {
  const phoneId = DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId) {
    throw new Error("PHONE_NUMBER_ID belum diset");
  }

  const url = `https://graph.facebook.com/${WA_VERSION}/${phoneId}/messages`;

  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return resp.data;
}

// =======================================================
// 8) WEBHOOK WHATSAPP – FIXED VERSION
// =======================================================

// Replace {{1}}, {{2}} in follow-up text
function applyFollowupTemplate(text, row) {
  if (!text) return "";
  if (!row) return text;

  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const key = "var" + n;
    return row[key] ? String(row[key]) : "";
  });
}

// Build filename dynamic based on {{var}}
function buildFilenameFromTemplate(filenameTpl, row) {
  if (!filenameTpl) return "document.pdf";
  let name = applyFollowupTemplate(filenameTpl, row).trim();
  if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
  return name;
}


// WEBHOOK VERIFICATION
app.get("/kirimpesan/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});


// =======================================================
// POST WEBHOOK - FIXED
// =======================================================
app.post("/kirimpesan/webhook", async (req, res) => {
  console.log("📥 WH Incoming:", JSON.stringify(req.body, null, 2));

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    let triggerText = "";

    if (msg.type === "interactive" && msg.interactive?.button_reply) {
      triggerText = msg.interactive.button_reply.title;
    } else if (msg.type === "button") {
      triggerText = msg.button.text;
    } else if (msg.type === "text") {
      triggerText = msg.text.body;
    }

    // Mapping ke row
    const mapEntry = lastBroadcastRowsByPhone[from] || null;
    const row = mapEntry?.row || null;
    const broadcastId = mapEntry?.broadcastId || null;

    // Simpan inbox
    try {
      await pgPool.query(
        `INSERT INTO inbox_messages
         (phone, message_type, message_text, raw_json, broadcast_id, is_quick_reply)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          from,
          msg.type || null,
          triggerText,
          req.body,
          broadcastId,
          msg.type === "interactive" || msg.type === "button"
        ]
      );
    } catch (e) {
      console.error("Insert inbox_messages error:", e);
    }

    if (!triggerText?.toUpperCase().includes("BERSEDIA")) {
      return res.sendStatus(200);
    }

    if (!lastFollowupConfig?.text) {
      console.log("No followup config → stop.");
      return res.sendStatus(200);
    }

    // 🔥 APPLY VARIABEL {{1}},{{2}}
    const text = applyFollowupTemplate(lastFollowupConfig.text, row);

    // 🔥 SIAPKAN MEDIA
    let media = null;

    const filenameTpl = lastFollowupConfig.static_media?.filename || null;
    const finalFilename = filenameTpl
      ? buildFilenameFromTemplate(filenameTpl, row)
      : "document.pdf";

    // PRIORITAS:
    // 1) row.follow_media (per orang)
    // 2) static_media (default)
    if (row?.follow_media) {
      media = {
        type: "document",
        link: row.follow_media,
        filename: finalFilename
      };
    } else if (lastFollowupConfig.static_media?.link) {
      media = {
        type: lastFollowupConfig.static_media.type || "document",
        link: lastFollowupConfig.static_media.link,
        filename: finalFilename
      };
    }

    // =======================================
    // 🔥 FIX: KIRIM PESAN FORMAT META YANG BENAR
    // =======================================
    const payload = {
      messaging_product: "whatsapp",
      to: from
    };

    // Ada media → kirim document + caption
    if (media) {
      payload.type = "document";
      payload.document = {
        link: media.link,
        filename: media.filename,
        caption: text
      };
    } else {
      payload.type = "text";
      payload.text = { body: text };
    }

    const sendRes = await sendWhatsApp(payload);
    console.log("Follow-up sent:", sendRes);

    // Simpan ke DB
    if (broadcastId) {
      await pgPool.query(
        `INSERT INTO broadcast_followups
         (id, broadcast_id, phone, text, has_media, media_link, status, error, at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'ok',NULL,$6)`,
        [
          broadcastId,
          from,
          text,
          !!media,
          media?.link || null,
          new Date().toISOString()
        ]
      );
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("Webhook ERROR:", err);
    return res.sendStatus(500);
  }
});

// =======================================================
// 9) LOG BROADCAST (POSTGRES)
// =======================================================

// Ringkasan semua log (urutan terbaru dulu)
// GET /kirimpesan/broadcast/logs?limit=20
app.get("/kirimpesan/broadcast/logs", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);

    const sql = `
      SELECT
        b.id,
        b.created_at,
        b.template_name,
        b.sender_phone,
        b.followup_enabled,
        COUNT(br.id) AS total,
        COALESCE(SUM(CASE WHEN br.template_ok = TRUE  THEN 1 ELSE 0 END),0) AS ok,
        COALESCE(SUM(CASE WHEN br.template_ok = FALSE THEN 1 ELSE 0 END),0) AS failed,
        COUNT(DISTINCT bf.id) AS followup_count
      FROM broadcasts b
      LEFT JOIN broadcast_recipients br ON br.broadcast_id = b.id
      LEFT JOIN broadcast_followups bf  ON bf.broadcast_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT $1
    `;

    const { rows } = await pgPool.query(sql, [limit]);

    res.json({
      status: "ok",
      count: rows.length,
      logs: rows
    });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// Detail satu log
// GET /kirimpesan/broadcast/logs/:id
app.get("/kirimpesan/broadcast/logs/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const bRes = await pgPool.query(
      "SELECT * FROM broadcasts WHERE id = $1",
      [id]
    );
    if (!bRes.rows.length) {
      return res.status(404).json({ status: "error", error: "Log not found" });
    }
    const broadcast = bRes.rows[0];

    const rRes = await pgPool.query(
      `SELECT * FROM broadcast_recipients
       WHERE broadcast_id = $1
       ORDER BY id`,
      [id]
    );

    const fRes = await pgPool.query(
      `SELECT * FROM broadcast_followups
       WHERE broadcast_id = $1
       ORDER BY at`,
      [id]
    );

    res.json({
      status: "ok",
      log: {
        broadcast,
        recipients: rRes.rows,
        followups: fRes.rows
      }
    });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs/:id:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// Export CSV
// GET /kirimpesan/broadcast/logs/:id/csv
app.get("/kirimpesan/broadcast/logs/:id/csv", async (req, res) => {
  const id = req.params.id;
  try {
    const bRes = await pgPool.query(
      "SELECT * FROM broadcasts WHERE id = $1",
      [id]
    );
    if (!bRes.rows.length) {
      return res.status(404).send("Log not found");
    }

    const rRes = await pgPool.query(
      `SELECT * FROM broadcast_recipients
       WHERE broadcast_id = $1
       ORDER BY id`,
      [id]
    );
    const fRes = await pgPool.query(
      `SELECT * FROM broadcast_followups
       WHERE broadcast_id = $1`,
      [id]
    );

    const recipients = rRes.rows;
    const followups  = fRes.rows;

    const followupMap = {};
    followups.forEach((f) => {
      if (!f.phone) return;
      followupMap[String(f.phone)] = f;
    });

    // cari var terbanyak supaya header konsisten
    let maxVar = 0;
    recipients.forEach((row) => {
      const vars = row.vars_json || {};
      Object.keys(vars).forEach((k) => {
        const m = /^var(\d+)$/.exec(k);
        if (m) {
          const n = parseInt(m[1], 10);
          if (!isNaN(n) && n > maxVar) maxVar = n;
        }
      });
    });

    const headers = ["phone"];
    for (let i = 1; i <= maxVar; i++) {
      headers.push(`var${i}`);
    }
    headers.push(
      "follow_media",
      "template_ok",
      "template_http_status",
      "template_error",
      "followup_status",
      "followup_has_media",
      "followup_media_link",
      "followup_at"
    );

    const lines = [];
    lines.push(headers.join(","));

    recipients.forEach((row) => {
      const phone = row.phone || "";
      if (!phone) return;

      const vars = row.vars_json || {};
      const f    = followupMap[String(phone)] || {};

      const cols = [];
      cols.push(`"${phone}"`);

      for (let i = 1; i <= maxVar; i++) {
        const key = "var" + i;
        const v   = vars[key] != null ? String(vars[key]) : "";
        cols.push(`"${v.replace(/"/g, '""')}"`);
      }

      const followMedia = row.follow_media || "";
      cols.push(`"${String(followMedia).replace(/"/g, '""')}"`);

      cols.push(row.template_ok ? "1" : "0");
      cols.push(row.template_http_status != null ? String(row.template_http_status) : "");

      const errStr =
        typeof row.template_error === "string"
          ? row.template_error
          : row.template_error
          ? JSON.stringify(row.template_error)
          : "";
      cols.push(`"${errStr.replace(/"/g, '""')}"`);

      cols.push(f.status || "");
      cols.push(f.has_media ? "1" : "0");
      cols.push(`"${((f.media_link || "") + "").replace(/"/g, '""')}"`);
      cols.push(f.at ? f.at.toISOString() : "");

      lines.push(cols.join(","));
    });

    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="broadcast-${id}.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs/:id/csv:", err);
    res.status(500).send("Internal error");
  }
});

// =======================================================
// 10) KOTAK MASUK / INBOX (gabung dengan data broadcast)
//     GET /kirimpesan/inbox?limit=50
// =======================================================
app.get("/kirimpesan/inbox", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100", 10);

    const sql = `
      SELECT
        im.id,
        im.at,
        im.phone,
        im.message_type,
        im.message_text,
        im.is_quick_reply,
        im.broadcast_id,
        b.template_name,
        br.vars_json
      FROM inbox_messages im
      LEFT JOIN broadcast_recipients br
        ON br.broadcast_id = im.broadcast_id
       AND br.phone        = im.phone
      LEFT JOIN broadcasts b
        ON b.id = im.broadcast_id
      ORDER BY im.at DESC
      LIMIT $1
    `;

    const { rows } = await pgPool.query(sql, [limit]);

    res.json({
      status: "ok",
      count: rows.length,
      messages: rows
    });
  } catch (err) {
    console.error("Error /kirimpesan/inbox:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// =======================================================
// 11) JALANKAN BROADCAST YANG DIJADWALKAN
//     GET /kirimpesan/broadcast/run-scheduled
//     (dipanggil tiap menit dari Apps Script)
// =======================================================
app.get("/kirimpesan/broadcast/run-scheduled", async (req, res) => {
  try {
    // 1. Ambil semua broadcast yang statusnya "scheduled" dan sudah jatuh tempo
    const { rows: broadcasts } = await pgPool.query(
      `SELECT *
         FROM broadcasts
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= NOW()`
    );

    if (!broadcasts.length) {
      return res.json({
        status: "ok",
        ran: []
      });
    }

    const ran = [];

    for (const bc of broadcasts) {
      // 2. Ambil semua penerima untuk broadcast ini
      const { rows: recipients } = await pgPool.query(
        `SELECT *
           FROM broadcast_recipients
          WHERE broadcast_id = $1`,
        [bc.id]
      );

      if (!recipients.length) {
        // kalau nggak ada penerima, tandai sent aja
        await pgPool.query(
          `UPDATE broadcasts
              SET status = 'sent'
            WHERE id = $1`,
          [bc.id]
        );
        ran.push({ broadcast_id: bc.id, total: 0, ok: 0, failed: 0 });
        continue;
      }

      // Ambil jumlah param template sekali saja per broadcast
      const paramCount = await getTemplateParamCount(bc.template_name);
      let okCount = 0;
      let failCount = 0;

      for (const rcp of recipients) {
        const phone = rcp.phone;
        if (!phone) continue;

        const varsMap = rcp.vars_json || {};
        const varKeys = Object.keys(varsMap)
          .filter((k) => /^var\d+$/.test(k))
          .sort((a, b) => {
            const na = parseInt(a.replace("var", ""), 10);
            const nb = parseInt(b.replace("var", ""), 10);
            return na - nb;
          });

        const vars = varKeys.map((k) => varsMap[k]);
        const varsForTemplate = vars.slice(0, paramCount);

        // siapkan row untuk follow-up mapping (webhook)
        const rowForMap = {
          phone,
          follow_media: rcp.follow_media || null,
        };
        varKeys.forEach((k) => {
          rowForMap[k] = varsMap[k];
        });
        lastBroadcastRowsByPhone[String(phone)] = {
          row: rowForMap,
          broadcastId: bc.id,
        };

        try {
          const r = await sendWaTemplate({
            phone,
            templateName: bc.template_name,
            vars: varsForTemplate,
            phone_number_id: bc.phone_number_id || undefined,
          });

          okCount++;

          await pgPool.query(
            `UPDATE broadcast_recipients
                SET template_ok = TRUE,
                    template_http_status = $2,
                    template_error = NULL
              WHERE id = $1`,
            [rcp.id, r.status || null]
          );
        } catch (err) {
          failCount++;
          const errorPayload = err.response?.data || err.message;

          await pgPool.query(
            `UPDATE broadcast_recipients
                SET template_ok = FALSE,
                    template_http_status = $2,
                    template_error = $3
              WHERE id = $1`,
            [
              rcp.id,
              err.response?.status || null,
              typeof errorPayload === "string"
                ? { message: errorPayload }
                : errorPayload,
            ]
          );

          console.error(
            "Scheduled broadcast error for",
            phone,
            errorPayload
          );
        }
      }

      // 3. Tandai broadcast ini sudah dijalankan
      await pgPool.query(
        `UPDATE broadcasts
            SET status = 'sent'
          WHERE id = $1`,
        [bc.id]
      );

      ran.push({
        broadcast_id: bc.id,
        total: recipients.length,
        ok: okCount,
        failed: failCount,
      });
    }

    return res.json({
      status: "ok",
      ran,
    });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/run-scheduled:", err);
    return res.status(500).json({
      status: "error",
      error: String(err),
    });
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
