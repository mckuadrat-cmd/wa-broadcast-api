// index.js
// MCKuadrat WA Broadcast API (CommonJS)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "GANTI_SECRET_INI_DI_ENV";

process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT ERROR:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED PROMISE:", err);
});

const { Pool } = require("pg");

// Pool Postgres (Railway)
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ====== CONFIG DARI ENV ======
const WABA_ID = process.env.WABA_ID; // ID WhatsApp Business Account
const WA_TOKEN = process.env.WA_TOKEN; // Permanent token
const WA_VERSION = process.env.WA_VERSION || "v24.0";
const TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || "en";

// PHONE_NUMBER_ID default (kalau tidak dipilih dari dropdown di frontend)
const DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Token verifikasi webhook (untuk Facebook Developer → Webhooks)
const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN || "MCKUADRAT_WEBHOOK_TOKEN";

// PORT Railway otomatis pakai process.env.PORT
const PORT = process.env.PORT || 3000;

// Menyimpan konfigurasi follow-up terakhir dari frontend
let lastFollowupConfig = null;
// Menyimpan mapping nomor → row broadcast terakhir (untuk var & attachment per-orang)
let lastBroadcastRowsByPhone = {};

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());

// ======================================================
// AUTH HELPER & MIDDLEWARE
// ======================================================
function signJwt(user) {
  return jwt.sign(
    {
      sub: user.id,
      school_id: user.school_id,
      role: user.role,
      name: user.display_name,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ status: "error", error: "Unauthorized (no token)" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    console.error("JWT verify error:", err.message);
    return res
      .status(401)
      .json({ status: "error", error: "Invalid or expired token" });
  }
}

// ====== ROOT SIMPLE CEK ONLINE ======
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// =======================================================
// AUTH LOGIN
// POST /kirimpesan/auth/login
// body: { username, password }
// =======================================================
app.post("/kirimpesan/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        status: "error",
        error: "Username dan password wajib diisi",
      });
    }

    const uname = String(username).trim().toLowerCase();

    const { rows } = await pgPool.query(
      `SELECT id, username, password_hash, school_id, display_name, alamat, role
       FROM users
       WHERE username = $1`,
      [uname]
    );

    if (!rows.length) {
      return res
        .status(401)
        .json({ status: "error", error: "Username atau password salah" });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ status: "error", error: "Username atau password salah" });
    }

    const token = signJwt(user);

    return res.json({
      status: "ok",
      token,
      user: {
        id: user.id,
        username: user.username,
        schoolId: user.school_id,
        displayName: user.display_name,
        alamat: user.alamat,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Error /kirimpesan/auth/login:", err);
    return res
      .status(500)
      .json({ status: "error", error: "Internal server error" });
  }
});

// Ambil metadata template: jumlah parameter & language
async function getTemplateMetadata(templateName) {
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`,
      {
        params: { name: templateName },
        headers: { Authorization: `Bearer ${WA_TOKEN}` },
      }
    );

    const t = resp.data?.data?.[0];
    if (!t) {
      return {
        paramCount: 1,
        language: "en", // default aman
      };
    }

    const bodyComponent = t.components?.find((c) => c.type === "BODY");
    const text = bodyComponent?.text || "";

    const matches = text.match(/\{\{\d+\}\}/g);
    const paramCount = matches ? matches.length : 0;

    return {
      paramCount,
      language: t.language || "en",
    };
  } catch (err) {
    console.error(
      "Gagal ambil template metadata:",
      err.response?.data || err
    );
    return {
      paramCount: 1,
      language: "en",
    };
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
app.get("/kirimpesan/senders", authMiddleware, async (req, res) => {
  try {
    const rows = await getWabaPhoneNumbers();

    const senders = rows.map((r) => ({
      phone_number_id: r.id,
      phone: r.display_phone_number,
      label: `${r.display_phone_number} - ${
        r.verified_name || r.display_phone_number
      }`,
      name: r.verified_name || r.display_phone_number,
    }));

    res.json({
      status: "ok",
      count: senders.length,
      senders,
    });
  } catch (err) {
    console.error(
      "Error /kirimpesan/senders:",
      err.response?.data || err.message
    );
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
app.get("/kirimpesan/templates", authMiddleware, async (req, res) => {
  try {
    if (!WABA_ID || !WA_TOKEN) {
      return res
        .status(500)
        .json({ error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    let status = (req.query.status || "").toUpperCase();

    let url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`;

    if (status && status !== "ALL") {
      url += `?status=${encodeURIComponent(status)}`;
    }

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
    console.error(
      "Error /kirimpesan/templates:",
      err.response?.data || err.message
    );
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
app.post("/kirimpesan/templates/create", authMiddleware, async (req, res) => {
  try {
    const {
      name,
      category,
      body_text,
      example_1,
      footer_text,
      buttons,
      media_sample,
    } = req.body || {};

    if (!name || !category || !body_text) {
      return res.status(400).json({
        status: "error",
        error: "name, category, body_text wajib diisi",
      });
    }

    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({
        status: "error",
        error: "WABA_ID atau WA_TOKEN belum diset di server",
      });
    }

    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`;

    // 🔧 SUSUN COMPONENTS DARI KOSONG
    const components = [];

    // 1) HEADER media (optional)
    if (media_sample && media_sample !== "NONE") {
      const fmt = String(media_sample).toUpperCase(); // jaga-jaga
      components.push({
        type: "HEADER",
        format: fmt, // "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION"
        // sementara tanpa example header_handle
      });
    }

    // 2) BODY (cukup sekali)
    components.push({
      type: "BODY",
      text: body_text,
      ...(example_1 ? { example: { body_text: [[example_1]] } } : {}),
    });

    // 3) FOOTER (opsional)
    if (footer_text) {
      components.push({
        type: "FOOTER",
        text: footer_text,
      });
    }

    // 4) BUTTONS (opsional)
    if (Array.isArray(buttons) && buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.map((label) => ({
          type: "QUICK_REPLY",
          text: label,
        })),
      });
    }

    const payload = {
      name,
      category,
      language: TEMPLATE_LANG, // <– pakai env
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
    const meta = err.response?.data;
    console.error(
      "Error /kirimpesan/templates/create:",
      meta || err.message
    );

    let message = err.message || "Gagal membuat template";

    if (meta?.error?.error_user_msg) {
      message = meta.error.error_user_msg;
    } else if (meta?.error?.message) {
      message = meta.error.message;
    }

    res.status(err.response?.status || 500).json({
      status: "error",
      error_message: message,
      error_raw: meta || err.message,
    });
  }
});

// =======================================================
// 4) Helper: kirim 1 WA template
//    arg: { phone, templateName, templateLanguage, vars, phone_number_id, headerDocument }
// =======================================================
async function sendWaTemplate({
  phone,
  templateName,
  templateLanguage,
  vars,
  phone_number_id,
  headerDocument,   // 👈 tambahan: boleh null
}) {
  const phoneId = phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId) {
    throw new Error("PHONE_NUMBER_ID belum diset");
  }

  const url = `https://graph.facebook.com/${WA_VERSION}/${phoneId}/messages`;

  const langCode = templateLanguage || "en"; // fallback kalau metadata gagal

  // --- susun components dinamis: HEADER (opsional) + BODY ---
  const components = [];

  // 1) HEADER document (kalau ada follow_media)
  if (headerDocument && headerDocument.link) {
    let filename = (headerDocument.filename || "").trim();
    if (!filename) filename = "document.pdf";
    if (!filename.toLowerCase().endsWith(".pdf")) {
      filename += ".pdf";
    }

    components.push({
      type: "header",
      parameters: [
        {
          type: "document",
          document: {
            link: headerDocument.link,
            filename,
          },
        },
      ],
    });
  }

  // 2) BODY (tetap sama seperti sebelumnya)
  components.push({
    type: "body",
    parameters: (vars && vars.length > 0 ? vars : [""]).map((v) => ({
      type: "text",
      text: String(v ?? ""),
    })),
  });

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: langCode },
      components,
    },
  };

  console.log("DEBUG sendWaTemplate body:", JSON.stringify(body, null, 2));

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
    const mType = String(media.type).toLowerCase(); // "document", "image", ...

    if (mType === "document") {
      // 🔥 PAKAI filename dari media.filename
      let filename = (media.filename || "").trim();

      // kalau kosong → default
      if (!filename) {
        filename = "document.pdf";
      }

      // pastikan ada .pdf di belakang
      if (!filename.toLowerCase().endsWith(".pdf")) {
        filename += ".pdf";
      }

      body = {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          link: media.link,
          filename, // ⬅️ INI YANG DILIHAT WA
          ...(text ? { caption: text } : {}),
        },
      };
    } else {
      // image / video / dll
      body = {
        messaging_product: "whatsapp",
        to,
        type: mType,
        [mType]: {
          link: media.link,
          ...(text ? { caption: text } : {}),
        },
      };
    }
  } else {
    // text only
    body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: text || "",
        preview_url: false,
      },
    };
  }

  // DEBUG: cek apa yang benar-benar dikirim
  console.log("DEBUG sendCustomMessage body:", JSON.stringify(body, null, 2));

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
app.post("/kirimpesan/broadcast", authMiddleware, async (req, res) => {
  try {
    const {
      template_name,
      rows,
      phone_number_id,
      sender_phone,
      followup,
      scheduled_at,
    } = req.body || {};

    if (!template_name) {
      return res
        .status(400)
        .json({ status: "error", error: "template_name wajib diisi" });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res
        .status(400)
        .json({ status: "error", error: "rows harus array minimal 1" });
    }

    console.log("📨 /kirimpesan/broadcast REQUEST:", {
      template_name,
      rows_count: rows.length,
      sender_phone,
      phone_number_id,
      scheduled_at,
    });

    // 🔍 Ambil metadata template SEKALI saja
    const { paramCount, language } = await getTemplateMetadata(template_name);
    console.log("Template metadata:", { paramCount, language });

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
        console.warn(
          "Gagal resolve sender_phone → phone_number_id:",
          e.message
        );
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
        scheduledDate, // bisa null
        isScheduled ? "scheduled" : "sent", // status awal
        template_name,
        sender_phone || null,
        effectivePhoneId || null,
        !!(followup && followup.text),
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
        const followMediaFilename = row.follow_media_filename || null;

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media, follow_media_filename,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NULL, NULL, NULL, NOW())`,
          [
            broadcastId, // $1
            phone, // $2
            Object.keys(varsMap).length ? varsMap : null, // $3
            followMedia, // $4
            followMediaFilename, // $5
          ]
        );
      }

      return res.json({
        status: "scheduled",
        broadcast_id: broadcastId,
        template_name,
        scheduled_at: scheduledDate.toISOString(),
        count: rows.length,
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
        broadcastId,
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

      // Ambil hanya sebanyak param yang diminta template
      const varsForTemplate = vars.slice(0, paramCount);

      const followMedia = row.follow_media || null;
      const followMediaFilename = row.follow_media_filename || null;
      
      // Siapkan headerDocument untuk template
      const headerDocument = followMedia
        ? {
            link: followMedia,
            filename: followMediaFilename || null,
          }
        : null;
      
      try {
        const r = await sendWaTemplate({
          phone,
          templateName: template_name,
          templateLanguage: language,   // <– otomatis ikut template
          vars: varsForTemplate,
          phone_number_id: effectivePhoneId,
          headerDocument,               // 👈 tambahan penting
        });
  
        results.push(r);

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media, follow_media_filename,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            broadcastId, // $1
            phone, // $2
            Object.keys(varsMap).length ? varsMap : null, // $3
            followMedia, // $4
            followMediaFilename, // $5
            true, // $6
            r.status || null, // $7
            null, // $8
          ]
        );
      } catch (err) {
        console.error(
          "Broadcast error for",
          phone,
          err.response?.data || err.message
        );

        const errorPayload = err.response?.data || err.message;

        results.push({
          phone,
          ok: false,
          status: err.response?.status || 500,
          messageId: null,
          error: errorPayload,
        });

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media, follow_media_filename,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            broadcastId, // $1
            phone, // $2
            Object.keys(varsMap).length ? varsMap : null, // $3
            followMedia, // $4
            followMediaFilename, // $5
            false, // $6
            err.response?.status || null, // $7
            typeof errorPayload === "string"
              ? { message: errorPayload }
              : errorPayload, // $8
          ]
        );
      }
    }

    const total = results.length;
    const ok = results.filter((r) => r.ok).length;
    const failed = total - ok;

    res.json({
      status: "ok",
      broadcast_id: broadcastId,
      template_name,
      count: total,
      ok,
      failed,
      results,
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
//    + SEKARANG: log ke inbox_messages sebagai outgoing
// =======================================================
app.post("/kirimpesan/custom", authMiddleware, async (req, res) => {
  try {
    const { to, text, media, phone_number_id } = req.body || {};

    if (!to) {
      return res.status(400).json({
        status: "error",
        error: "`to` (nomor tujuan) wajib diisi",
      });
    }
    if (!text && !media) {
      return res.status(400).json({
        status: "error",
        error: "Minimal text atau media harus diisi",
      });
    }

    // 1) Kirim ke WhatsApp API
    const waRes = await sendCustomMessage({
      to,
      text,
      media,
      phone_number_id,
    });

    // 2) Simpan sebagai pesan OUTGOING di inbox_messages
    try {
      await pgPool.query(
        `
        INSERT INTO inbox_messages (at, phone, message_type, message_text, is_quick_reply, broadcast_id, raw_json)
        VALUES (NOW(), $1, $2, $3, $4, $5, $6)
        `,
        [
          to,
          media ? "outgoing_media" : "outgoing", // penting buat deteksi bubble hijau
          text || null,
          false, // is_quick_reply
          null, // broadcast_id
          JSON.stringify(waRes || {}),
        ]
      );
    } catch (dbErr) {
      console.error("Gagal insert outgoing ke inbox_messages:", dbErr);
      // jangan throw supaya response ke FE tetap ok
    }

    // 3) Balikkan response ke FE
    res.json({
      status: "ok",
      to,
      wa_response: waRes,
    });
  } catch (err) {
    console.error(
      "Error /kirimpesan/custom:",
      err.response?.data || err.message
    );
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// =======================================================
// 8) WEBHOOK WHATSAPP – BALAS "BERSEDIA" KIRIM PDF
// =======================================================

// Gantikan {{1}}, {{2}}, ... di teks follow-up dengan var1, var2, ...
function applyFollowupTemplate(text, row) {
  if (!text) return "";
  if (!row) return text;

  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const key = "var" + n;
    return row[key] != null ? String(row[key]) : "";
  });
}

// Bangun nama file dari template (mis: "Surat penerimaan {{1}}")
function buildFilenameFromTemplate(filenameTpl, row) {
  // 1) Kalau per nomor sudah ada follow_media_filename, pakai itu
  if (row && row.follow_media_filename) {
    let name = String(row.follow_media_filename).trim();
    if (!name.toLowerCase().endsWith(".pdf")) {
      name += ".pdf";
    }
    return name;
  }

  // 2) Kalau ada template filename (static_media.filename), pakai itu + {{var}} replacement
  if (filenameTpl) {
    let name = applyFollowupTemplate(filenameTpl, row).trim();
    if (!name.toLowerCase().endsWith(".pdf")) {
      name += ".pdf";
    }
    return name;
  }

  // 3) Fallback
  return "Lampiran";
}

// Ambil info media dari 1 pesan WA (image / document / video / audio)
function extractMediaInfoFromMessage(msg) {
  let mediaType = null;
  let mediaId = null;
  let mediaFilename = null;
  let mediaCaption = null;

  if (!msg || !msg.type) return { mediaType, mediaId, mediaFilename, mediaCaption };

  if (msg.type === "image" && msg.image) {
    mediaType = "image";
    mediaId = msg.image.id || null;
    mediaCaption = msg.image.caption || null;
  } else if (msg.type === "video" && msg.video) {
    mediaType = "video";
    mediaId = msg.video.id || null;
    mediaCaption = msg.video.caption || null;
  } else if (msg.type === "audio" && msg.audio) {
    mediaType = "audio";
    mediaId = msg.audio.id || null;
  } else if (msg.type === "document" && msg.document) {
    mediaType = "document";
    mediaId = msg.document.id || null;
    mediaFilename = msg.document.filename || null;
    mediaCaption = msg.document.caption || null;
  }

  return { mediaType, mediaId, mediaFilename, mediaCaption };
}

// ========== VERIFIKASI WEBHOOK (saat set di Facebook Developer) ==========
app.get("/kirimpesan/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN && challenge) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ========== HANDLE PESAN MASUK (BUTTON / TEXT / INTERACTIVE) ==========
app.post("/kirimpesan/webhook", async (req, res) => {
  console.log("📥 WH Incoming:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || !messages.length) {
      return res.sendStatus(200);
    }

    const msg = messages[0];
    const from = msg.from; // nomor pengirim (628xx…)
    let triggerText = "";
    const phoneNumberId = value.metadata?.phone_number_id || null;

    // Ambil teks yang dikirim user (button / interactive / text biasa)
    if (msg.type === "text" && msg.text) {
      triggerText = msg.text.body || "";
    } else if (msg.type === "button" && msg.button) {
      triggerText = msg.button.text || msg.button.payload || "";
    } else if (msg.type === "interactive" && msg.interactive) {
      if (msg.interactive.button_reply) {
        triggerText =
          msg.interactive.button_reply.title ||
          msg.interactive.button_reply.id ||
          "";
      } else if (msg.interactive.list_reply) {
        triggerText =
          msg.interactive.list_reply.title ||
          msg.interactive.list_reply.id ||
          "";
      }
    }

    // Ambil info media (kalau pesan image/video/audio/document)
    const {
      mediaType,
      mediaId,
      mediaFilename,
      mediaCaption,
    } = extractMediaInfoFromMessage(msg);

    console.log("Type:", msg.type, "from:", from, "text:", triggerText);

    // ====== MAP KE ROW BROADCAST TERAKHIR ======
    // (diisi waktu /kirimpesan/broadcast kirim atau run-scheduled)
    const mapEntry = lastBroadcastRowsByPhone[String(from)] || null;
    const row = mapEntry ? mapEntry.row : null;
    const broadcastId = mapEntry ? mapEntry.broadcastId : null;

    // ====== SIMPAN KE inbox_messages SELALU ======
    try {
      const isQuickReply =
        !!triggerText && (msg.type === "button" || msg.type === "interactive");

    await pgPool.query(
      `INSERT INTO inbox_messages
         (phone,
          message_type,
          message_text,
          raw_json,
          broadcast_id,
          is_quick_reply,
          media_type,
          media_id,
          media_filename,
          media_caption,
          phone_number_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        from,
        msg.type || null,
        triggerText || null,
        JSON.stringify(req.body || {}),
        broadcastId || null,
        isQuickReply,
        mediaType,
        mediaId,
        mediaFilename,
        mediaCaption,
        phoneNumberId,       // ⬅️ nomor pengirim WABA
      ]
    );

    } catch (e) {
      console.error("Insert inbox_messages error:", e);
    }

    // ====== KALAU BUKAN "BERSEDIA" → TIDAK BALAS APA-APA ======
    if (!triggerText || !triggerText.toUpperCase().includes("BERSEDIA")) {
      return res.sendStatus(200);
    }

    // ====== KALAU TIDAK ADA CONFIG FOLLOW-UP → JUGA DIEM ======
    if (!lastFollowupConfig || !lastFollowupConfig.text) {
      console.log("No followup config, ignore.");
      return res.sendStatus(200);
    }

    // ====== BANGUN TEKS FOLLOW-UP DARI TEMPLATE {{1}},{{2}} ======
    const text = applyFollowupTemplate(lastFollowupConfig.text, row);

    // ====== SIAPKAN MEDIA (PDF) ======
    let media = null;

    // template filename dari frontend (boleh ada {{1}}, {{2}})
    const filenameTpl = lastFollowupConfig.static_media?.filename || null;
    const finalFilename = buildFilenameFromTemplate(filenameTpl, row);
    console.log(
      "DEBUG followup filenameTpl:",
      filenameTpl,
      "finalFilename:",
      finalFilename
    );

    // PRIORITAS:
    // 1) follow_media di row (khusus nomor itu)
    // 2) static_media dari config (sama untuk semua)
    if (row && row.follow_media) {
      media = {
        type: "document",
        link: row.follow_media,
        filename: finalFilename,
      };
    } else if (
      lastFollowupConfig.static_media &&
      lastFollowupConfig.static_media.link
    ) {
      media = {
        type: lastFollowupConfig.static_media.type || "document",
        link: lastFollowupConfig.static_media.link,
        filename: finalFilename,
      };
    }

    // ====== KIRIM KE WHATSAPP MENGGUNAKAN sendCustomMessage() ======
    // (fungsi ini sudah ada di atas dan sudah benar soal filename & caption)
    try {
      const waRes = await sendCustomMessage({
        to: from,
        text,
        media,
        // pakai default PHONE_NUMBER_ID
      });

      console.log("Follow-up sent:", JSON.stringify(waRes, null, 2));

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
            media ? media.link : null,
            new Date().toISOString(),
          ]
        );
      }
    } catch (err) {
      console.error(
        "Error sending follow-up:",
        err.response?.data || err.message
      );

      if (broadcastId) {
        const errorPayload = err.response?.data || err.message;
        await pgPool.query(
          `INSERT INTO broadcast_followups
             (id, broadcast_id, phone, text, has_media, media_link, status, error, at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'error',$6,$7)`,
          [
            broadcastId,
            from,
            text,
            !!media,
            media ? media.link : null,
            typeof errorPayload === "string"
              ? { message: errorPayload }
              : errorPayload,
            new Date().toISOString(),
          ]
        );
      }
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
app.get("/kirimpesan/broadcast/logs", authMiddleware, async (req, res) => {
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
      logs: rows,
    });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// Detail satu log
// GET /kirimpesan/broadcast/logs/:id
app.get(
  "/kirimpesan/broadcast/logs/:id",
  authMiddleware,
  async (req, res) => {
    const id = req.params.id;
    try {
      const bRes = await pgPool.query(
        "SELECT * FROM broadcasts WHERE id = $1",
        [id]
      );
      if (!bRes.rows.length) {
        return res
          .status(404)
          .json({ status: "error", error: "Log not found" });
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
          followups: fRes.rows,
        },
      });
    } catch (err) {
      console.error("Error /kirimpesan/broadcast/logs/:id:", err);
      res.status(500).json({ status: "error", error: String(err) });
    }
  }
);

// Export CSV
// GET /kirimpesan/broadcast/logs/:id/csv
app.get(
  "/kirimpesan/broadcast/logs/:id/csv",
  authMiddleware,
  async (req, res) => {
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
      const followups = fRes.rows;

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
        "follow_media_filename",
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
        const f = followupMap[String(phone)] || {};

        const cols = [];
        cols.push(`"${phone}"`);

        for (let i = 1; i <= maxVar; i++) {
          const key = "var" + i;
          const v = vars[key] != null ? String(vars[key]) : "";
          cols.push(`"${v.replace(/"/g, '""')}"`);
        }

        const followMedia = row.follow_media || "";
        const followMediaFilename = row.follow_media_filename || "";
        cols.push(`"${String(followMedia).replace(/"/g, '""')}"`);
        cols.push(
          `"${String(followMediaFilename).replace(/"/g, '""')}"`
        );

        cols.push(row.template_ok ? "1" : "0");
        cols.push(
          row.template_http_status != null
            ? String(row.template_http_status)
            : ""
        );

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
  }
);

// =======================================================
// 10) KOTAK MASUK / INBOX (gabung dengan data broadcast)
//     GET /kirimpesan/inbox?limit=50
// =======================================================
app.get("/kirimpesan/inbox", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100", 10);

    const phoneNumberId =
      req.query.phone_number_id || DEFAULT_PHONE_NUMBER_ID || null;

    const sql = `
      SELECT
        im.id,
        im.at,
        im.phone,
        im.message_type,
        im.message_text,
        im.is_quick_reply,
        im.broadcast_id,
        im.media_type,
        im.media_id,
        im.media_filename,
        im.media_caption,
        im.phone_number_id,
        b.template_name,
        br.vars_json
      FROM inbox_messages im
      LEFT JOIN broadcast_recipients br
        ON br.broadcast_id = im.broadcast_id
       AND br.phone        = im.phone
      LEFT JOIN broadcasts b
        ON b.id = im.broadcast_id
      WHERE ($2::text IS NULL OR im.phone_number_id = $2)
      ORDER BY im.at DESC
      LIMIT $1
    `;

    const { rows } = await pgPool.query(sql, [limit, phoneNumberId]);

    res.json({
      status: "ok",
      messages: rows,
    });
  } catch (err) {
    console.error("Inbox error:", err);
    res.status(500).json({ status: "error", error: "Gagal memuat inbox" });
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
        ran: [],
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

      // Ambil metadata template sekali saja per broadcast
      const { paramCount, language } = await getTemplateMetadata(
        bc.template_name
      );
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
          follow_media_filename: rcp.follow_media_filename || null,
        };
        varKeys.forEach((k) => {
          rowForMap[k] = varsMap[k];
        });
        lastBroadcastRowsByPhone[String(phone)] = {
          row: rowForMap,
          broadcastId: bc.id,
        };
        
        // 👉 ambil media dari DB untuk header document
        const headerDocument = rcp.follow_media
          ? {
              link: rcp.follow_media,
              filename: rcp.follow_media_filename || null,
            }
          : null;
        
        try {
          const r = await sendWaTemplate({
            phone,
            templateName: bc.template_name,
            templateLanguage: language,
            vars: varsForTemplate,
            phone_number_id: bc.phone_number_id || undefined,
            headerDocument,   // 👈 tambahan
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

// =======================================================
//  X) PROXY MEDIA WHATSAPP
//     GET /kirimpesan/media/:id
//     Frontend pakai ini sebagai src gambar/video/audio
//     (DIBIARKAN TANPA AUTH supaya <img src> bisa akses)
// =======================================================
app.get("/kirimpesan/media/:id", async (req, res) => {
  try {
    const mediaId = req.params.id;

    if (!mediaId) {
      return res.status(400).send("media id required");
    }
    if (!WA_TOKEN) {
      return res.status(500).send("WA_TOKEN belum diset");
    }

    // 1) Ambil metadata media (url + mime_type)
    const metaUrl = `https://graph.facebook.com/${WA_VERSION}/${mediaId}`;
    const metaResp = await axios.get(metaUrl, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });

    const fileUrl = metaResp.data?.url;
    const mime = metaResp.data?.mime_type || "application/octet-stream";

    if (!fileUrl) {
      return res.status(404).send("Media URL not found");
    }

    // 2) Ambil file sebenarnya dan stream ke client
    const fileResp = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      responseType: "stream",
    });

    res.setHeader("Content-Type", mime);
    fileResp.data.pipe(res);
  } catch (err) {
    console.error(
      "Error proxy media:",
      err.response?.data || err.message
    );
    res.status(500).send("Error fetching media");
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
