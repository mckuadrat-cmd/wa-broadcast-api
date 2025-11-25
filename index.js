// index.js
// MCKuadrat WA Broadcast API (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

const { Pool } = require("pg");

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // biasanya perlu di Railway
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
// Menyimpan riwayat broadcast (in-memory)
let broadcastLogs = [];   // [{ id, created_at, template_name, sender_phone, phone_number_id, followup_enabled, rows, results, followups }]
let lastBroadcastId = null;

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());

// ====== ROOT SIMPLE CEK ONLINE ======
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

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
// 6) POST /kirimpesan/broadcast
//    Body JSON:
//    {
//      template_name: "kirim_hasil_test",
//      sender_phone: "62851....",        // optional: display number dari dropdown
//      phone_number_id: "1234567890",    // optional: kalau mau kirim ID langsung
//      rows: [
//        { phone: "62812...", var1: "Ridwan", var2: "1234", follow_media: "https://..." },
//        ...
//      ],
//      followup: {
//        text: "Terima kasih, {{1}} ...",
//        static_media: { type: "document", link: "https://..." }
//      }
//    }
// =======================================================
app.post("/kirimpesan/broadcast", async (req, res) => {
  try {
    const { template_name, rows, phone_number_id, sender_phone, followup } = req.body || {};

    if (!template_name) {
      return res.status(400).json({ status: "error", error: "template_name wajib diisi" });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", error: "rows harus array minimal 1" });
    }

    // === FOLLOW-UP CONFIG DARI FRONTEND ===
    if (followup && followup.text) {
      lastFollowupConfig = followup;
      lastBroadcastRowsByPhone = {};
      console.log("Updated followup config:", lastFollowupConfig);
    } else {
      // followup kosong → webhook dimatikan
      lastFollowupConfig = null;
      lastBroadcastRowsByPhone = {};
      console.log("Followup disabled for this broadcast.");
    }

    // Buat ID unik untuk broadcast ini
    const broadcastId =
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    lastBroadcastId = broadcastId;

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

    const results = [];

    for (const row of rows) {
      const phone = row.phone || row.to;
      if (!phone) continue;

      // Simpan mapping nomor → row + broadcastId (dipakai webhook)
      lastBroadcastRowsByPhone[String(phone)] = {
        row,
        broadcastId
      };

      // vars boleh dikirim langsung (row.vars) atau diambil dari var1,var2,...
      let vars = row.vars;
      if (!Array.isArray(vars)) {
        const varKeys = Object.keys(row)
          .filter((k) => /^var\d+$/.test(k) && row[k] != null && row[k] !== "")
          .sort((a, b) => {
            const na = parseInt(a.replace("var", ""), 10);
            const nb = parseInt(b.replace("var", ""), 10);
            return na - nb;
          });

        vars = varKeys.map((k) => row[k]);
      }

      try {
        const r = await sendWaTemplate({
          phone,
          templateName: template_name,
          vars,
          phone_number_id: effectivePhoneId,
        });
        results.push(r);
      } catch (err) {
        console.error("Broadcast error for", phone, err.response?.data || err.message);
        results.push({
          phone,
          ok: false,
          status: err.response?.status || 500,
          messageId: null,
          error: err.response?.data || err.message,
        });
      }
    }

    // Ringkasan
    const total = results.length;
    const ok = results.filter((r) => r.ok).length;
    const failed = total - ok;

    // Simpan log ke memory
    broadcastLogs.push({
      id: broadcastId,
      created_at: new Date().toISOString(),
      template_name,
      sender_phone: sender_phone || null,
      phone_number_id: effectivePhoneId || null,
      followup_enabled: !!(followup && followup.text),
      rows,
      results,
      followups: []    // akan diisi oleh webhook
    });

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
      error: String(err),
    });
  }
});

// =======================================================
// 7) POST /kirimpesan/custom
//    Kirim pesan bebas (text + optional media)
//    Body JSON:
//    {
//      "to": "62812....",
//      "text": "Terima kasih sudah bersedia...",
//      "media": {
//        "type": "document" | "image" | "audio" | "video",
//        "link": "https://...."
//      }
//    }
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

// =======================================================
// 8) WEBHOOK WHATSAPP (LANGSUNG KE BACKEND, TANPA APPS SCRIPT)
//    GET  /kirimpesan/webhook  → verifikasi
//    POST /kirimpesan/webhook  → handle pesan masuk (quick reply "Bersedia")
// =======================================================

function applyFollowupTemplate(text, row) {
  if (!text) return "";
  if (!row) return text;

  const varMap = {};

  Object.keys(row).forEach((k) => {
    const m = /^var(\d+)$/.exec(k);
    if (m && row[k] != null) {
      varMap[m[1]] = String(row[k]);
    }
  });

  return text.replace(/\{\{(\d+)\}\}/g, (_, idx) => {
    return Object.prototype.hasOwnProperty.call(varMap, idx) ? varMap[idx] : "";
  });
}

// Verifikasi webhook (saat set callback URL di Facebook Developer)
app.get("/kirimpesan/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Facebook");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Terima event message dari WhatsApp
app.post("/kirimpesan/webhook", async (req, res) => {
  console.log("📩 Incoming webhook:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || !messages.length) {
      return res.sendStatus(200);
    }

    const msg = messages[0];
    const from = msg.from; // nomor pengirim

    let triggerText = "";

    if (msg.type === "text" && msg.text) {
      triggerText = msg.text.body || "";
    } else if (msg.type === "button" && msg.button) {
      triggerText = msg.button.text || msg.button.payload || "";
    } else if (msg.type === "interactive" && msg.interactive) {
      if (msg.interactive.button_reply) {
        triggerText =
          msg.interactive.button_reply.title || msg.interactive.button_reply.id || "";
      } else if (msg.interactive.list_reply) {
        triggerText =
          msg.interactive.list_reply.title || msg.interactive.list_reply.id || "";
      }
    }

    console.log("Webhook message type:", msg.type, "from:", from, "triggerText:", triggerText);

    if (!triggerText) {
      return res.sendStatus(200);
    }

    const upperTxt = triggerText.toUpperCase();

    // Contoh: hanya respon kalau mengandung "BERSEDIA"
    if (upperTxt.includes("BERSEDIA")) {
      console.log("🔥 Trigger BERSEDIA dari", from);
    
      // Kalau follow-up tidak diset dari frontend → jangan kirim apa-apa
      if (!lastFollowupConfig || !lastFollowupConfig.text) {
        console.log("No followup config set, ignoring.");
        return res.sendStatus(200);
      }
    
      // Ambil row broadcast terakhir untuk nomor ini (kalau ada)
      const mapEntry = lastBroadcastRowsByPhone[String(from)] || null;
      const row = mapEntry ? mapEntry.row : null;
      const broadcastId = mapEntry ? mapEntry.broadcastId : null;
    
      // Text follow-up dengan {{1}}, {{2}}, ... diisi dari var1, var2, ...
      const text = applyFollowupTemplate(lastFollowupConfig.text, row);
    
      // Attachment:
      // 1) kalau row punya follow_media → pakai itu
      // 2) kalau tidak, tapi followup.static_media ada → pakai itu
      let media = null;
      if (row && row.follow_media) {
        media = {
          type: "document",
          link: row.follow_media
        };
      } else if (
        lastFollowupConfig.static_media &&
        lastFollowupConfig.static_media.type &&
        lastFollowupConfig.static_media.link
      ) {
        media = {
          type: lastFollowupConfig.static_media.type,
          link: lastFollowupConfig.static_media.link
        };
      }
    
      const payload = { to: from, text };
      if (media) payload.media = media;
    
      try {
        const data = await sendCustomMessage(payload);
        console.log("Follow-up sent:", JSON.stringify(data, null, 2));
    
        // Catat ke log broadcast kalau ketemu
        if (broadcastId) {
          const log = broadcastLogs.find((l) => l.id === broadcastId);
          if (log) {
            log.followups = log.followups || [];
            log.followups.push({
              phone: from,
              text,
              has_media: !!media,
              media_link: media ? media.link : null,
              status: "ok",
              wa_response: data,
              at: new Date().toISOString()
            });
          }
        }
      } catch (err) {
        console.error("Error sending follow-up:", err.response?.data || err.message);
    
        if (broadcastId) {
          const log = broadcastLogs.find((l) => l.id === broadcastId);
          if (log) {
            log.followups = log.followups || [];
            log.followups.push({
              phone: from,
              text,
              has_media: !!media,
              media_link: media ? media.link : null,
              status: "error",
              error: err.response?.data || err.message,
              at: new Date().toISOString()
            });
          }
        }
      }
    }

    // bisa tambah else-if utk trigger lain di sini

    return res.sendStatus(200);
  } catch (err) {
    console.error("Error /kirimpesan/webhook POST:", err);
    return res.sendStatus(500);
  }
});

// =======================================================
// 9) LOG BROADCAST (IN-MEMORY)
// =======================================================

// Ringkasan semua log (urutan terbaru dulu)
// GET /kirimpesan/broadcast/logs?limit=20
app.get("/kirimpesan/broadcast/logs", (req, res) => {
  const limit = parseInt(req.query.limit || "50", 10);

  const sorted = [...broadcastLogs].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  const sliced = sorted.slice(0, limit).map((l) => ({
    id: l.id,
    created_at: l.created_at,
    template_name: l.template_name,
    sender_phone: l.sender_phone,
    followup_enabled: l.followup_enabled,
    total: l.results.length,
    ok: l.results.filter((r) => r.ok).length,
    failed: l.results.filter((r) => !r.ok).length,
    followup_count: (l.followups || []).length
  }));

  res.json({
    status: "ok",
    count: sliced.length,
    logs: sliced
  });
});

// Detail satu log
// GET /kirimpesan/broadcast/logs/:id
app.get("/kirimpesan/broadcast/logs/:id", (req, res) => {
  const id = req.params.id;
  const log = broadcastLogs.find((l) => l.id === id);
  if (!log) {
    return res.status(404).json({ status: "error", error: "Log not found" });
  }
  res.json({
    status: "ok",
    log
  });
});

// Export CSV
// GET /kirimpesan/broadcast/logs/:id/csv
app.get("/kirimpesan/broadcast/logs/:id/csv", (req, res) => {
  const id = req.params.id;
  const log = broadcastLogs.find((l) => l.id === id);
  if (!log) {
    return res.status(404).send("Log not found");
  }

  const resultsMap = {};
  (log.results || []).forEach((r) => {
    if (!r.phone) return;
    resultsMap[String(r.phone)] = r;
  });

  const followupMap = {};
  (log.followups || []).forEach((f) => {
    if (!f.phone) return;
    followupMap[String(f.phone)] = f;
  });

  // cari var terbanyak supaya header konsisten
  let maxVar = 0;
  (log.rows || []).forEach((row) => {
    Object.keys(row).forEach((k) => {
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

  (log.rows || []).forEach((row) => {
    const phone = row.phone || row.to || "";
    if (!phone) return;

    const r = resultsMap[String(phone)] || {};
    const f = followupMap[String(phone)] || {};

    const cols = [];
    cols.push(`"${phone}"`);

    for (let i = 1; i <= maxVar; i++) {
      const v = row[`var${i}`] != null ? String(row[`var${i}`]) : "";
      cols.push(`"${v.replace(/"/g, '""')}"`);
    }

    const followMedia = row.follow_media || "";
    cols.push(`"${String(followMedia).replace(/"/g, '""')}"`);

    cols.push(r.ok ? "1" : "0");
    cols.push(r.status != null ? String(r.status) : "");
    const errStr =
      typeof r.error === "string"
        ? r.error
        : r.error
        ? JSON.stringify(r.error)
        : "";
    cols.push(`"${errStr.replace(/"/g, '""')}"`);

    cols.push(f.status || "");
    cols.push(f.has_media ? "1" : "0");
    cols.push(`"${(f.media_link || "").replace(/"/g, '""')}"`);
    cols.push(f.at || "");

    lines.push(cols.join(","));
  });

  const csv = lines.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="broadcast-${id}.csv"`
  );
  res.send(csv);
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
