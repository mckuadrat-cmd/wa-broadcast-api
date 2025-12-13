// index.js
// MCKuadrat WA Broadcast API (CommonJS) — multi-school (config di DB)
//
// NOTE:
// - schools menyimpan waba_id, wa_token, wa_version, template_lang, default_phone_number_id
// - users punya phone_number_id (optional override)
//
// SECURITY NOTE:
// Jangan simpan token “permanent” di chat / repo publik. Anggap token yang sudah terlanjur terkirim itu compromised dan ROTATE.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

const JWT_SECRET = process.env.JWT_SECRET || "GANTI_SECRET_INI_DI_ENV";
const META_APP_ID = process.env.META_APP_ID;

// PORT Railway otomatis pakai process.env.PORT
const PORT = process.env.PORT || 3000;

// Cron secret (buat endpoint run-scheduled)
const CRON_SECRET = process.env.CRON_SECRET || "";

// Token verifikasi webhook (untuk Facebook Developer → Webhooks)
const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN || "MCKUADRAT_WEBHOOK_TOKEN";

// ====== FALLBACK CONFIG DARI ENV (DEV / SINGLE-SCHOOL ONLY) ======
// (di mode multi-school: semua config WA diambil dari DB via user.school_id)
const ENV_WABA_ID = process.env.WABA_ID || null;
const ENV_WA_TOKEN = process.env.WA_TOKEN || null;
const ENV_WA_VERSION = process.env.WA_VERSION || "v24.0";
const ENV_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || "en";
const ENV_DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || null;

// Pool Postgres (Railway)
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Upload file ke memory (bukan ke disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // max 15 MB
});

// (Legacy) in-memory config (boleh tetap ada, tapi webhook follow-up sekarang pakai DB)
let lastFollowupConfig = null;
let lastBroadcastRowsByPhone = {};

process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT ERROR:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED PROMISE:", err);
});

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());

// =====================================================
// AUTH HELPER & MIDDLEWARE
// =====================================================
function signJwt(user) {
  return jwt.sign(
    {
      sub: user.id,
      school_id: user.school_id,
      school_key: user.school_key,
      role: user.role,
      name: user.display_name_user || user.username || "User",
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

function requireAdmin(req, res, next) {
  const role = (req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "superadmin") {
    return res
      .status(403)
      .json({ status: "error", error: "Forbidden (admin only)" });
  }
  next();
}

// Normalisasi nomor untuk matching display_phone_number
function normPhone(s) {
  return String(s || "").replace(/\D/g, "");
}

// Validasi: phone_number_id harus milik sekolah user (ada di school_phone_numbers)
async function assertPhoneNumberBelongsToSchool(phoneNumberId, schoolId) {
  if (!phoneNumberId) return true; // null => balik ke default sekolah

  const { rows } = await pgPool.query(
    `SELECT 1
     FROM school_phone_numbers
     WHERE school_id = $1 AND phone_number_id = $2
     LIMIT 1`,
    [schoolId, String(phoneNumberId)]
  );

  if (!rows.length) {
    throw new Error("phone_number_id tidak terdaftar untuk sekolah ini");
  }
  return true;
}

// =====================================================
// HELPER: Ambil WA config dari DB berdasarkan userId
// =====================================================
async function getCtxByUserId(userId) {
  const { rows } = await pgPool.query(
    `
    SELECT
      u.id as user_id,
      u.username,
      u.display_name_user,
      u.role,
      u.school_id,
      COALESCE(u.phone_number_id, s.default_phone_number_id) AS phone_number_id,

      s.school_key,
      s.display_name AS school_name,
      s.alamat,
      s.waba_id,
      s.wa_token,
      s.wa_version,
      s.template_lang,
      s.default_phone_number_id
    FROM users u
    JOIN schools s ON s.id = u.school_id
    WHERE u.id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (rows.length) return rows[0];

  // fallback (DEV ONLY)
  if (ENV_WABA_ID && ENV_WA_TOKEN) {
    return {
      user_id: userId,
      username: null,
      display_name_user: null,
      role: "admin",
      school_id: null,
      phone_number_id: ENV_DEFAULT_PHONE_NUMBER_ID,
      school_key: null,
      school_name: null,
      alamat: null,
      waba_id: ENV_WABA_ID,
      wa_token: ENV_WA_TOKEN,
      wa_version: ENV_WA_VERSION,
      template_lang: ENV_TEMPLATE_LANG,
      default_phone_number_id: ENV_DEFAULT_PHONE_NUMBER_ID,
    };
  }

  throw new Error(
    "School config tidak ditemukan untuk user ini (dan ENV fallback tidak tersedia)"
  );
}

// =====================================================
// HELPER: Ambil WA config dari DB berdasarkan school_id
// =====================================================
async function getCtxBySchoolId(schoolId) {
  if (!schoolId) throw new Error("schoolId kosong");

  const { rows } = await pgPool.query(
    `SELECT
        id AS school_id,
        school_key,
        display_name AS school_name,
        alamat,
        waba_id,
        wa_token,
        wa_version,
        template_lang,
        default_phone_number_id
     FROM schools
     WHERE id = $1
     LIMIT 1`,
    [schoolId]
  );

  if (rows.length) {
    return {
      user_id: null,
      username: null,
      display_name_user: null,
      role: "admin",
      school_id: rows[0].school_id,
      school_key: rows[0].school_key,
      school_name: rows[0].school_name,
      alamat: rows[0].alamat,
      waba_id: rows[0].waba_id,
      wa_token: rows[0].wa_token,
      wa_version: rows[0].wa_version || ENV_WA_VERSION,
      template_lang: rows[0].template_lang || ENV_TEMPLATE_LANG,
      default_phone_number_id:
        rows[0].default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
      phone_number_id:
        rows[0].default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
    };
  }

  // fallback DEV
  if (ENV_WABA_ID && ENV_WA_TOKEN) {
    return {
      user_id: null,
      username: null,
      display_name_user: null,
      role: "admin",
      school_id: schoolId,
      school_key: null,
      school_name: null,
      alamat: null,
      waba_id: ENV_WABA_ID,
      wa_token: ENV_WA_TOKEN,
      wa_version: ENV_WA_VERSION,
      template_lang: ENV_TEMPLATE_LANG,
      default_phone_number_id: ENV_DEFAULT_PHONE_NUMBER_ID,
      phone_number_id: ENV_DEFAULT_PHONE_NUMBER_ID,
    };
  }

  throw new Error("School config tidak ditemukan (school_id)");
}

// =====================================================
// HELPER: Ambil WA config dari DB berdasarkan phone_number_id
// Priority:
// 1) school_phone_numbers.phone_number_id
// 2) schools.default_phone_number_id
// =====================================================
async function getCtxByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) throw new Error("phone_number_id kosong");

  // 1) coba mapping table
  try {
    const { rows } = await pgPool.query(
      `SELECT
         spn.school_id,
         s.school_key,
         s.display_name AS school_name,
         s.alamat,
         s.waba_id,
         s.wa_token,
         s.wa_version,
         s.template_lang,
         s.default_phone_number_id
       FROM school_phone_numbers spn
       JOIN schools s ON s.id = spn.school_id
       WHERE spn.phone_number_id = $1
       LIMIT 1`,
      [String(phoneNumberId)]
    );

    if (rows.length) {
      return {
        user_id: null,
        username: null,
        display_name_user: null,
        role: "admin",
        school_id: rows[0].school_id,
        school_key: rows[0].school_key,
        school_name: rows[0].school_name,
        alamat: rows[0].alamat,
        waba_id: rows[0].waba_id,
        wa_token: rows[0].wa_token,
        wa_version: rows[0].wa_version || ENV_WA_VERSION,
        template_lang: rows[0].template_lang || ENV_TEMPLATE_LANG,
        default_phone_number_id:
          rows[0].default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
        phone_number_id: String(phoneNumberId),
      };
    }
  } catch (e) {
    // table mungkin belum ada — ignore
  }

  // 2) fallback: cari sekolah yang default_phone_number_id = phoneNumberId
  const { rows: r2 } = await pgPool.query(
    `SELECT
        id AS school_id,
        school_key,
        display_name AS school_name,
        alamat,
        waba_id,
        wa_token,
        wa_version,
        template_lang,
        default_phone_number_id
     FROM schools
     WHERE default_phone_number_id = $1
     LIMIT 1`,
    [String(phoneNumberId)]
  );

  if (r2.length) {
    return {
      user_id: null,
      username: null,
      display_name_user: null,
      role: "admin",
      school_id: r2[0].school_id,
      school_key: r2[0].school_key,
      school_name: r2[0].school_name,
      alamat: r2[0].alamat,
      waba_id: r2[0].waba_id,
      wa_token: r2[0].wa_token,
      wa_version: r2[0].wa_version || ENV_WA_VERSION,
      template_lang: r2[0].template_lang || ENV_TEMPLATE_LANG,
      default_phone_number_id:
        r2[0].default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
      phone_number_id: String(phoneNumberId),
    };
  }

  // 3) fallback DEV
  if (ENV_WA_TOKEN) {
    return {
      wa_token: ENV_WA_TOKEN,
      wa_version: ENV_WA_VERSION,
      template_lang: ENV_TEMPLATE_LANG,
      waba_id: ENV_WABA_ID,
      default_phone_number_id: ENV_DEFAULT_PHONE_NUMBER_ID,
      phone_number_id: String(phoneNumberId),
    };
  }

  throw new Error("Tidak bisa resolve config dari phone_number_id");
}

// =======================================================
// ROOT SIMPLE CEK ONLINE
// =======================================================
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
      `
      SELECT
        u.id,
        u.username,
        u.display_name_user,
        u.role,
        u.school_id,
        s.school_key,
        s.display_name AS school_name,
        s.alamat
      FROM users u
      JOIN schools s ON s.id = u.school_id
      WHERE u.username = $1
        AND u.password_hash = crypt($2, u.password_hash)
      LIMIT 1
      `,
      [uname, password]
    );

    if (!rows.length) {
      return res
        .status(401)
        .json({ status: "error", error: "Username atau password salah" });
    }

    const user = rows[0];
    const token = signJwt(user);

    return res.json({
      status: "ok",
      token,
      user: {
        id: user.id,
        username: user.username,
        schoolId: user.school_id,
        schoolKey: user.school_key,
        schoolName: user.school_name,
        alamat: user.alamat,
        displayName: user.display_name_user,
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

// =======================================================
// ME (profile + effective sender)
// GET /kirimpesan/me
// =======================================================
app.get("/kirimpesan/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;

    const { rows } = await pgPool.query(
      `
      SELECT
        u.id,
        u.username,
        u.display_name_user,
        u.role,
        u.school_id,
        COALESCE(u.phone_number_id, s.default_phone_number_id) AS effective_phone_number_id,
        s.school_key,
        s.display_name AS school_name,
        s.default_phone_number_id
      FROM users u
      JOIN schools s ON s.id = u.school_id
      WHERE u.id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ status: "error", error: "User not found" });
    }

    const me = rows[0];

    return res.json({
      status: "ok",
      me: {
        id: me.id,
        username: me.username,
        displayName: me.display_name_user,
        role: me.role,
        schoolId: me.school_id,
        schoolKey: me.school_key,
        schoolName: me.school_name,
        effectivePhoneNumberId: me.effective_phone_number_id,
        schoolDefaultPhoneNumberId: me.default_phone_number_id,
      },
    });
  } catch (err) {
    console.error("Error /kirimpesan/me:", err);
    return res
      .status(500)
      .json({ status: "error", error: "Internal server error" });
  }
});

// =======================================================
// Helper: ambil metadata template (paramCount & language)
// =======================================================
async function getTemplateMetadata(ctx, templateName) {
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${ctx.wa_version}/${ctx.waba_id}/message_templates`,
      {
        params: { name: templateName },
        headers: { Authorization: `Bearer ${ctx.wa_token}` },
      }
    );

    const t = resp.data?.data?.[0];
    if (!t) {
      return { paramCount: 1, language: ctx.template_lang || "en" };
    }

    const bodyComponent = t.components?.find((c) => c.type === "BODY");
    const text = bodyComponent?.text || "";

    const matches = text.match(/\{\{\d+\}\}/g);
    const paramCount = matches ? matches.length : 0;

    return {
      paramCount,
      language: t.language || ctx.template_lang || "en",
    };
  } catch (err) {
    console.error("Gagal ambil template metadata:", err.response?.data || err);
    return { paramCount: 1, language: ctx.template_lang || "en" };
  }
}

// =======================================================
// HELPER: Ambil daftar phone_numbers dari WABA
// =======================================================
async function getWabaPhoneNumbers(ctx) {
  if (!ctx?.waba_id || !ctx?.wa_token) {
    throw new Error("WABA config belum tersedia (waba_id / wa_token)");
  }

  const url =
    `https://graph.facebook.com/${ctx.wa_version}/${ctx.waba_id}/phone_numbers` +
    `?fields=id,display_phone_number,verified_name`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${ctx.wa_token}` },
  });

  return Array.isArray(resp.data?.data) ? resp.data.data : [];
}

// =======================================================
// 1) GET /kirimpesan/senders
// =======================================================
app.get("/kirimpesan/senders", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    const rows = await getWabaPhoneNumbers(ctx);

    const senders = rows.map((r) => ({
      phone_number_id: r.id,
      phone: r.display_phone_number,
      label: `${r.display_phone_number} - ${
        r.verified_name || r.display_phone_number
      }`,
      name: r.verified_name || r.display_phone_number,
      is_default: String(r.id) === String(ctx.default_phone_number_id || ""),
    }));

    // best-effort: simpan mapping phone_number_id -> school_id
    try {
      if (ctx.school_id) {
        for (const r of rows) {
          await pgPool.query(
            `INSERT INTO school_phone_numbers (school_id, phone_number_id, display_phone_number, verified_name)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (phone_number_id)
             DO UPDATE SET school_id = EXCLUDED.school_id,
                           display_phone_number = EXCLUDED.display_phone_number,
                           verified_name = EXCLUDED.verified_name`,
            [
              ctx.school_id,
              String(r.id),
              r.display_phone_number || null,
              r.verified_name || null,
            ]
          );
        }
      }
    } catch (e) {
      // ignore kalau tabel belum ada
    }

    res.json({ status: "ok", count: senders.length, senders });
  } catch (err) {
    console.error(
      "Error /kirimpesan/senders:",
      err.response?.data || err.message
    );
    res
      .status(500)
      .json({ status: "error", error: err.response?.data || err.message });
  }
});

// =======================================================
// 2) GET /kirimpesan/templates
// =======================================================
app.get("/kirimpesan/templates", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    let status = (req.query.status || "").toUpperCase();
    let url = `https://graph.facebook.com/${ctx.wa_version}/${ctx.waba_id}/message_templates`;

    if (status && status !== "ALL") {
      url += `?status=${encodeURIComponent(status)}`;
    }

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${ctx.wa_token}` },
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

    res.json({ status: "ok", count: simplified.length, templates: simplified });
  } catch (err) {
    console.error(
      "Error /kirimpesan/templates:",
      err.response?.data || err.message
    );
    res
      .status(500)
      .json({ status: "error", error: err.response?.data || err.message });
  }
});

// =======================================================
// UPLOAD SAMPLE MEDIA HANDLE (RESUMABLE) - untuk template header
// POST /kirimpesan/templates/upload-sample
// multipart/form-data: file
// return: { handle: "<ASSET_HANDLE>" }
// =======================================================
app.post(
  "/kirimpesan/templates/upload-sample",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      const ctx = await getCtxByUserId(req.user.sub);

      if (!META_APP_ID) {
        return res
          .status(500)
          .json({ status: "error", error: "META_APP_ID belum diset di server" });
      }
      if (!ctx.wa_token) {
        return res
          .status(500)
          .json({ status: "error", error: "WA token sekolah belum diset" });
      }
      if (!req.file) {
        return res
          .status(400)
          .json({ status: "error", error: "file wajib diupload" });
      }

      const mimeType = req.file.mimetype || "application/pdf";
      const fileName = req.file.originalname || "sample";
      const fileLength = req.file.size;

      // 1) Create upload session
      const createSessionUrl = `https://graph.facebook.com/${ctx.wa_version}/${META_APP_ID}/uploads`;
      const sessResp = await axios.post(createSessionUrl, null, {
        params: {
          file_name: fileName,
          file_length: fileLength,
          file_type: mimeType,
        },
        headers: { Authorization: `Bearer ${ctx.wa_token}` },
      });

      const uploadSessionId = sessResp.data?.id;
      if (!uploadSessionId) {
        return res.status(500).json({
          status: "error",
          error: "Gagal membuat upload session",
          error_raw: sessResp.data || null,
        });
      }

      // 2) Upload bytes
      const uploadUrl = `https://graph.facebook.com/${ctx.wa_version}/${uploadSessionId}`;
      const upResp = await axios.post(uploadUrl, req.file.buffer, {
        headers: {
          Authorization: `Bearer ${ctx.wa_token}`,
          "Content-Type": mimeType,
          file_offset: "0",
        },
        maxBodyLength: Infinity,
      });

      const handle = upResp.data?.h;
      if (!handle) {
        return res.status(500).json({
          status: "error",
          error: "Upload selesai tapi handle tidak ditemukan",
          error_raw: upResp.data || null,
        });
      }

      return res.json({
        status: "ok",
        handle,
        media_id: handle, // alias biar FE lama gak rusak
        mime_type: mimeType,
        filename: fileName,
        size: fileLength,
      });
    } catch (err) {
      const meta = err.response?.data;
      console.error("Error upload-sample(handle):", meta || err.message);

      return res.status(err.response?.status || 500).json({
        status: "error",
        error_message: meta?.error?.message || err.message,
        error_raw: meta || err.message,
      });
    }
  }
);

// =======================================================
// 3) POST /kirimpesan/templates/create
// =======================================================
app.post("/kirimpesan/templates/create", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    const {
      name,
      category,
      body_text,
      example_1,
      footer_text,
      buttons,
      media_sample, // "DOCUMENT" | "IMAGE" | "VIDEO" | "NONE"
      media_handle_id,
      sample_media_id,
    } = req.body || {};

    if (!body_text || !String(body_text).trim()) {
      return res
        .status(400)
        .json({ status: "error", error: "body_text tidak boleh kosong" });
    }

    const handleId = media_handle_id || sample_media_id;
    const components = [];

    // HEADER (MEDIA SAMPLE OPSIONAL)
    if (media_sample && media_sample !== "NONE") {
      if (!handleId) {
        return res.status(400).json({
          status: "error",
          error:
            "media_handle_id / sample_media_id wajib diisi jika media_sample bukan NONE",
        });
      }

      components.push({
        type: "HEADER",
        format: media_sample,
        example: { header_handle: [handleId] },
      });
    }

    // BODY (WAJIB)
    components.push({
      type: "BODY",
      text: body_text,
      ...(example_1 ? { example: { body_text: [[example_1]] } } : {}),
    });

    // FOOTER (OPSIONAL)
    if (footer_text) {
      components.push({ type: "FOOTER", text: footer_text });
    }

    // BUTTONS (OPSIONAL)
    if (Array.isArray(buttons) && buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.map((label) => ({ type: "QUICK_REPLY", text: label })),
      });
    }

    const payload = {
      name,
      category,
      language: ctx.template_lang || "en",
      components,
    };

    const url = `https://graph.facebook.com/${ctx.wa_version}/${ctx.waba_id}/message_templates`;
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${ctx.wa_token}`,
        "Content-Type": "application/json",
      },
    });

    res.json({ status: "submitted", meta_response: resp.data });
  } catch (err) {
    const meta = err.response?.data;
    console.error("Error /kirimpesan/templates/create:", meta || err.message);

    let message = err.message || "Gagal membuat template";
    if (meta?.error?.error_user_msg) message = meta.error.error_user_msg;
    else if (meta?.error?.message) message = meta.error.message;

    res.status(err.response?.status || 500).json({
      status: "error",
      error_message: message,
      error_raw: meta || err.message,
    });
  }
});

// =======================================================
// 4) Helper: kirim 1 WA template
// =======================================================
async function sendWaTemplate(
  ctx,
  { phone, templateName, templateLanguage, vars, phone_number_id, headerDocument }
) {
  const phoneId =
    phone_number_id || ctx.phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId)
    throw new Error("PHONE_NUMBER_ID belum tersedia (user/school/default)");

  const url = `https://graph.facebook.com/${ctx.wa_version}/${phoneId}/messages`;
  const langCode = templateLanguage || ctx.template_lang || "en";

  const components = [];

  // HEADER document (opsional)
  if (headerDocument && headerDocument.link) {
    let filename = (headerDocument.filename || "").trim();
    if (!filename) filename = "document.pdf";
    if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";

    components.push({
      type: "header",
      parameters: [
        {
          type: "document",
          document: { link: headerDocument.link, filename },
        },
      ],
    });
  }

  // BODY
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

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${ctx.wa_token}`,
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
// =======================================================
async function sendCustomMessage(ctx, { to, text, media, phone_number_id }) {
  const phoneId =
    phone_number_id || ctx.phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId)
    throw new Error("PHONE_NUMBER_ID belum tersedia (user/school/default)");

  const url = `https://graph.facebook.com/${ctx.wa_version}/${phoneId}/messages`;

  let body;

  if (media && media.type && media.link) {
    const mType = String(media.type).toLowerCase();

    if (mType === "document") {
      let filename = (media.filename || "").trim();
      if (!filename) filename = "document.pdf";
      if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";

      body = {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          link: media.link,
          filename,
          ...(text ? { caption: text } : {}),
        },
      };
    } else {
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
    body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text || "", preview_url: false },
    };
  }

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${ctx.wa_token}`,
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
    const ctx = await getCtxByUserId(req.user.sub);

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

    // Ambil metadata template SEKALI saja
    const { paramCount, language } = await getTemplateMetadata(ctx, template_name);

    // schedule parsing: frontend kirim ISO
    function parseScheduleISO(str) {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    }

    let scheduledDate = null;
    let isScheduled = false;

    if (scheduled_at) {
      const dUtc = parseScheduleISO(scheduled_at);
      if (dUtc) {
        scheduledDate = dUtc;
        if (dUtc.getTime() > Date.now() + 15 * 1000) isScheduled = true;
      }
    }

    // in-memory (legacy)
    if (followup && followup.text) {
      lastFollowupConfig = followup;
      lastBroadcastRowsByPhone = {};
    } else {
      lastFollowupConfig = null;
      lastBroadcastRowsByPhone = {};
    }

    // Buat ID unik untuk broadcast ini
    const broadcastId =
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

    // Resolve phone_number_id:
    // 1) payload.phone_number_id
    // 2) resolve by sender_phone
    // 3) ctx.phone_number_id
    let effectivePhoneId = phone_number_id || null;

    if (!effectivePhoneId && sender_phone) {
      try {
        const phones = await getWabaPhoneNumbers(ctx);
        const match = phones.find(
          (p) => normPhone(p.display_phone_number) === normPhone(sender_phone)
        );
        if (match) effectivePhoneId = match.id;
        else console.warn("sender_phone tidak ditemukan di WABA:", sender_phone);
      } catch (e) {
        console.warn("Gagal resolve sender_phone → phone_number_id:", e.message);
      }
    }

    if (!effectivePhoneId) {
      effectivePhoneId = ctx.phone_number_id || null;
    }

    // --- 1. Simpan broadcast ke Postgres ---
    await pgPool.query(
      `INSERT INTO broadcasts (
         id, created_at, scheduled_at, status,
         template_name, sender_phone, phone_number_id, followup_enabled,
         school_id, followup_config
       ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        broadcastId,
        scheduledDate,
        isScheduled ? "scheduled" : "sent",
        template_name,
        sender_phone || null,
        effectivePhoneId || null,
        !!(followup && followup.text),
        ctx.school_id || null,
        followup ? JSON.stringify(followup) : null,
      ]
    );

    // --- 2. Kalau SCHEDULED → simpan penerima, BELUM kirim WA ---
    if (isScheduled) {
      for (const row of rows) {
        const phone = row.phone || row.to;
        if (!phone) continue;

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
            broadcastId,
            phone,
            Object.keys(varsMap).length ? varsMap : null,
            followMedia,
            followMediaFilename,
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

    // --- 3. Kalau TIDAK scheduled → kirim langsung ---
    const results = [];

    for (const row of rows) {
      const phone = row.phone || row.to;
      if (!phone) continue;

      lastBroadcastRowsByPhone[String(phone)] = { row, broadcastId };

      // vars
      let vars = row.vars;
      const varsMap = {};

      if (!Array.isArray(vars)) {
        const varKeys = Object.keys(row)
          .filter((k) => /^var\d+$/.test(k) && row[k] != null && row[k] !== "")
          .sort(
            (a, b) =>
              parseInt(a.replace("var", ""), 10) -
              parseInt(b.replace("var", ""), 10)
          );

        vars = varKeys.map((k) => {
          varsMap[k] = row[k];
          return row[k];
        });
      } else {
        vars.forEach((v, idx) => {
          varsMap["var" + (idx + 1)] = v;
        });
      }

      const varsForTemplate = vars.slice(0, paramCount);

      const followMedia = row.follow_media || null;
      const followMediaFilename = row.follow_media_filename || null;

      const headerDocument = followMedia
        ? { link: followMedia, filename: followMediaFilename || null }
        : null;

      try {
        const r = await sendWaTemplate(ctx, {
          phone,
          templateName: template_name,
          templateLanguage: language,
          vars: varsForTemplate,
          phone_number_id: effectivePhoneId,
          headerDocument,
        });

        results.push(r);

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media, follow_media_filename,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            broadcastId,
            phone,
            Object.keys(varsMap).length ? varsMap : null,
            followMedia,
            followMediaFilename,
            true,
            r.status || null,
            null,
          ]
        );
      } catch (err) {
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
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            broadcastId,
            phone,
            Object.keys(varsMap).length ? varsMap : null,
            followMedia,
            followMediaFilename,
            false,
            err.response?.status || null,
            typeof errorPayload === "string"
              ? { message: errorPayload }
              : errorPayload,
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
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// =======================================================
// 7) POST /kirimpesan/custom
// =======================================================
app.post("/kirimpesan/custom", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    const { to, text, media, phone_number_id } = req.body || {};

    if (!to) {
      return res
        .status(400)
        .json({ status: "error", error: "`to` (nomor tujuan) wajib diisi" });
    }
    if (!text && !media) {
      return res
        .status(400)
        .json({ status: "error", error: "Minimal text atau media harus diisi" });
    }

    const waRes = await sendCustomMessage(ctx, { to, text, media, phone_number_id });

    // log outgoing (best effort)
    try {
      await pgPool.query(
        `
        INSERT INTO inbox_messages (at, phone, message_type, message_text, is_quick_reply, broadcast_id, raw_json)
        VALUES (NOW(), $1, $2, $3, $4, $5, $6)
        `,
        [
          to,
          media ? "outgoing_media" : "outgoing",
          text || null,
          false,
          null,
          JSON.stringify(waRes || {}),
        ]
      );
    } catch (dbErr) {
      console.error("Gagal insert outgoing ke inbox_messages:", dbErr);
    }

    res.json({ status: "ok", to, wa_response: waRes });
  } catch (err) {
    console.error("Error /kirimpesan/custom:", err.response?.data || err.message);
    res.status(500).json({ status: "error", error: err.response?.data || err.message });
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
  if (row && row.follow_media_filename) {
    let name = String(row.follow_media_filename).trim();
    if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
    return name;
  }

  if (filenameTpl) {
    let name = applyFollowupTemplate(filenameTpl, row).trim();
    if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
    return name;
  }

  return "Lampiran";
}

// Ambil info media dari 1 pesan WA
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

// ========== VERIFIKASI WEBHOOK ==========
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

// ========== HANDLE PESAN MASUK ==========
app.post("/kirimpesan/webhook", async (req, res) => {
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

    const { mediaType, mediaId, mediaFilename, mediaCaption } =
      extractMediaInfoFromMessage(msg);

    // Ambil broadcast terakhir utk nomor ini (ikut vars + follow_media) + followup_config
    const { rows } = await pgPool.query(
      `SELECT
          b.id AS broadcast_id,
          b.followup_config,
          br.vars_json,
          br.follow_media,
          br.follow_media_filename
       FROM broadcasts b
       JOIN broadcast_recipients br ON br.broadcast_id = b.id
       WHERE br.phone = $1
       ORDER BY b.created_at DESC
       LIMIT 1`,
      [from]
    );

    const broadcastId = rows[0]?.broadcast_id || null;

    const row = rows[0]
      ? {
          ...(rows[0].vars_json || {}),
          follow_media: rows[0].follow_media || null,
          follow_media_filename: rows[0].follow_media_filename || null,
        }
      : null;

    const followupConfigRaw = rows[0]?.followup_config || null;
    const followupCfg = followupConfigRaw
      ? typeof followupConfigRaw === "string"
        ? safeJsonParse(followupConfigRaw)
        : followupConfigRaw
      : null;

    // simpan inbox
    try {
      const isQuickReply =
        !!triggerText && (msg.type === "button" || msg.type === "interactive");

      await pgPool.query(
        `INSERT INTO inbox_messages
         (phone, message_type, message_text, raw_json, broadcast_id, is_quick_reply,
          media_type, media_id, media_filename, media_caption, phone_number_id)
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
          phoneNumberId,
        ]
      );
    } catch (e) {
      console.error("Insert inbox_messages error:", e);
    }

    // kalau bukan BERSEDIA -> diam
    if (!triggerText || !triggerText.toUpperCase().includes("BERSEDIA")) {
      return res.sendStatus(200);
    }

    // kalau tidak ada followup config -> diam
    if (!followupCfg || !followupCfg.text) {
      return res.sendStatus(200);
    }

    const text = applyFollowupTemplate(followupCfg.text, row);

    // media (PDF)
    let media = null;
    const filenameTpl = followupCfg.static_media?.filename || null;
    const finalFilename = buildFilenameFromTemplate(filenameTpl, row);

    if (row && row.follow_media) {
      media = { type: "document", link: row.follow_media, filename: finalFilename };
    } else if (followupCfg.static_media && followupCfg.static_media.link) {
      media = {
        type: followupCfg.static_media.type || "document",
        link: followupCfg.static_media.link,
        filename: finalFilename,
      };
    }

    // Follow-up butuh token: resolve via phone_number_id (metadata)
    let followCtx = null;
    try {
      if (phoneNumberId) followCtx = await getCtxByPhoneNumberId(phoneNumberId);
    } catch (e) {
      followCtx = null;
    }

    // fallback DEV
    if (!followCtx) {
      followCtx = {
        wa_token: ENV_WA_TOKEN,
        wa_version: ENV_WA_VERSION,
        phone_number_id: phoneNumberId || ENV_DEFAULT_PHONE_NUMBER_ID,
      };
    }

    if (!followCtx.wa_token) {
      console.warn("Token WA tidak tersedia; follow-up tidak bisa dikirim.");
      return res.sendStatus(200);
    }

    try {
      const waRes = await sendCustomMessage(followCtx, { to: from, text, media });

      if (broadcastId) {
        await pgPool.query(
          `INSERT INTO broadcast_followups
             (id, broadcast_id, phone, text, has_media, media_link, status, error, at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'ok',NULL,$6)`,
          [broadcastId, from, text, !!media, media ? media.link : null, new Date().toISOString()]
        );
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error("Error sending follow-up:", err.response?.data || err.message);

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
            typeof errorPayload === "string" ? { message: errorPayload } : errorPayload,
            new Date().toISOString(),
          ]
        );
      }

      return res.sendStatus(200);
    }
  } catch (err) {
    console.error("Webhook ERROR:", err);
    return res.sendStatus(500);
  }
});

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// =======================================================
// 9) LOG BROADCAST (POSTGRES) — SCOPED by school_id
// =======================================================
app.get("/kirimpesan/broadcast/logs", authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const schoolId = req.user.school_id;

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
      WHERE b.school_id = $2
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT $1
    `;

    const { rows } = await pgPool.query(sql, [limit, schoolId]);
    res.json({ status: "ok", count: rows.length, logs: rows });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

app.get("/kirimpesan/broadcast/logs/:id", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const schoolId = req.user.school_id;
  try {
    const bRes = await pgPool.query(
      "SELECT * FROM broadcasts WHERE id = $1 AND school_id = $2",
      [id, schoolId]
    );
    if (!bRes.rows.length) {
      return res.status(404).json({ status: "error", error: "Log not found" });
    }
    const broadcast = bRes.rows[0];

    const rRes = await pgPool.query(
      `SELECT * FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY id`,
      [id]
    );

    const fRes = await pgPool.query(
      `SELECT * FROM broadcast_followups WHERE broadcast_id = $1 ORDER BY at`,
      [id]
    );

    res.json({
      status: "ok",
      log: { broadcast, recipients: rRes.rows, followups: fRes.rows },
    });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs/:id:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// Export CSV (scoped by school_id)
app.get("/kirimpesan/broadcast/logs/:id/csv", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const schoolId = req.user.school_id;
  try {
    const bRes = await pgPool.query(
      "SELECT * FROM broadcasts WHERE id = $1 AND school_id = $2",
      [id, schoolId]
    );
    if (!bRes.rows.length) return res.status(404).send("Log not found");

    const rRes = await pgPool.query(
      `SELECT * FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY id`,
      [id]
    );
    const fRes = await pgPool.query(
      `SELECT * FROM broadcast_followups WHERE broadcast_id = $1`,
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
    for (let i = 1; i <= maxVar; i++) headers.push(`var${i}`);
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
      cols.push(`"${String(followMediaFilename).replace(/"/g, '""')}"`);

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
      cols.push(f.at ? new Date(f.at).toISOString() : "");

      lines.push(cols.join(","));
    });

    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="broadcast-${id}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs/:id/csv:", err);
    res.status(500).send("Internal error");
  }
});

// =======================================================
// 10) KOTAK MASUK / INBOX (SCOPED by school)
// =======================================================
app.get("/kirimpesan/inbox", authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100", 10);
    const schoolId = req.user.school_id;
    const phoneNumberId = req.query.phone_number_id ? String(req.query.phone_number_id) : null;

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
      WHERE (
        im.phone_number_id IN (
          SELECT phone_number_id FROM school_phone_numbers WHERE school_id = $2
        )
        OR im.phone_number_id = (
          SELECT default_phone_number_id FROM schools WHERE id = $2
        )
      )
        AND ($3::text IS NULL OR im.phone_number_id = $3)
      ORDER BY im.at DESC
      LIMIT $1
    `;

    const { rows } = await pgPool.query(sql, [limit, schoolId, phoneNumberId]);
    res.json({ status: "ok", messages: rows });
  } catch (err) {
    console.error("Inbox error:", err);
    res.status(500).json({ status: "error", error: "Gagal memuat inbox" });
  }
});

// =======================================================
// 11) JALANKAN BROADCAST YANG DIJADWALKAN (Protected)
// GET /kirimpesan/broadcast/run-scheduled
// header: x-cron-secret atau query ?secret=
// =======================================================
app.get("/kirimpesan/broadcast/run-scheduled", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(403).json({ status: "error", error: "Forbidden" });
  }

  try {
    const { rows: broadcasts } = await pgPool.query(
      `SELECT *
         FROM broadcasts
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= NOW()`
    );

    if (!broadcasts.length) {
      return res.json({ status: "ok", ran: [] });
    }

    const ran = [];

    for (const bc of broadcasts) {
      const { rows: recipients } = await pgPool.query(
        `SELECT * FROM broadcast_recipients WHERE broadcast_id = $1`,
        [bc.id]
      );

      if (!recipients.length) {
        await pgPool.query(`UPDATE broadcasts SET status = 'sent' WHERE id = $1`, [bc.id]);
        ran.push({ broadcast_id: bc.id, total: 0, ok: 0, failed: 0 });
        continue;
      }

      // ctx berdasarkan school_id
      let ctx = null;
      try {
        if (bc.school_id) ctx = await getCtxBySchoolId(bc.school_id);
      } catch (e) {
        ctx = null;
      }

      // fallback DEV
      if (!ctx) {
        ctx = {
          wa_token: ENV_WA_TOKEN,
          wa_version: ENV_WA_VERSION,
          template_lang: ENV_TEMPLATE_LANG,
          waba_id: ENV_WABA_ID,
          phone_number_id: bc.phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
        };
      }

      if (!ctx.wa_token || !ctx.waba_id) {
        console.warn("ctx WA tidak tersedia; run-scheduled skip broadcast:", bc.id);
        continue;
      }

      const { paramCount, language } = await getTemplateMetadata(ctx, bc.template_name);

      let okCount = 0;
      let failCount = 0;

      for (const rcp of recipients) {
        const phone = rcp.phone;
        if (!phone) continue;

        const varsMap = rcp.vars_json || {};
        const varKeys = Object.keys(varsMap)
          .filter((k) => /^var\d+$/.test(k))
          .sort(
            (a, b) =>
              parseInt(a.replace("var", ""), 10) -
              parseInt(b.replace("var", ""), 10)
          );

        const vars = varKeys.map((k) => varsMap[k]);
        const varsForTemplate = vars.slice(0, paramCount);

        const headerDocument = rcp.follow_media
          ? { link: rcp.follow_media, filename: rcp.follow_media_filename || null }
          : null;

        try {
          const r = await sendWaTemplate(ctx, {
            phone,
            templateName: bc.template_name,
            templateLanguage: language,
            vars: varsForTemplate,
            phone_number_id: bc.phone_number_id || undefined,
            headerDocument,
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
              typeof errorPayload === "string" ? { message: errorPayload } : errorPayload,
            ]
          );
        }
      }

      await pgPool.query(`UPDATE broadcasts SET status = 'sent' WHERE id = $1`, [bc.id]);

      ran.push({
        broadcast_id: bc.id,
        total: recipients.length,
        ok: okCount,
        failed: failCount,
      });
    }

    return res.json({ status: "ok", ran });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/run-scheduled:", err);
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

// =======================================================
//  X) PROXY MEDIA WHATSAPP
//     GET /kirimpesan/media/:id
// =======================================================
app.get("/kirimpesan/media/:id", async (req, res) => {
  try {
    const mediaId = req.params.id;
    if (!mediaId) return res.status(400).send("media id required");

    const schoolId = req.query.school_id || null;
    const phoneNumberIdQ = req.query.phone_number_id || null;

    let ctx = null;

    if (schoolId) {
      try {
        ctx = await getCtxBySchoolId(schoolId);
      } catch {
        ctx = null;
      }
    }

    if (!ctx && phoneNumberIdQ) {
      try {
        ctx = await getCtxByPhoneNumberId(phoneNumberIdQ);
      } catch {
        ctx = null;
      }
    }

    if (!ctx) {
      try {
        const { rows } = await pgPool.query(
          `SELECT phone_number_id
             FROM inbox_messages
            WHERE media_id = $1
              AND phone_number_id IS NOT NULL
            ORDER BY at DESC
            LIMIT 1`,
          [String(mediaId)]
        );

        const pnid = rows[0]?.phone_number_id || null;
        if (pnid) ctx = await getCtxByPhoneNumberId(pnid);
      } catch {
        ctx = null;
      }
    }

    if (!ctx) ctx = { wa_token: ENV_WA_TOKEN, wa_version: ENV_WA_VERSION };
    if (!ctx.wa_token) return res.status(500).send("WA_TOKEN belum tersedia");

    const metaUrl = `https://graph.facebook.com/${ctx.wa_version || ENV_WA_VERSION}/${mediaId}`;
    const metaResp = await axios.get(metaUrl, {
      headers: { Authorization: `Bearer ${ctx.wa_token}` },
    });

    const fileUrl = metaResp.data?.url;
    const mime = metaResp.data?.mime_type || "application/octet-stream";
    if (!fileUrl) return res.status(404).send("Media URL not found");

    const fileResp = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${ctx.wa_token}` },
      responseType: "stream",
    });

    res.setHeader("Content-Type", mime);
    fileResp.data.pipe(res);
  } catch (err) {
    console.error("Error proxy media:", err.response?.data || err.message);
    res.status(500).send("Error fetching media");
  }
});

// =======================================================
// CHANGE PASSWORD (crypt) — user ganti password sendiri
// POST /kirimpesan/auth/change-password
// =======================================================
app.post("/kirimpesan/auth/change-password", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { old_password, new_password } = req.body || {};

    if (!old_password || !new_password) {
      return res
        .status(400)
        .json({ status: "error", error: "old_password & new_password wajib" });
    }
    if (String(new_password).length < 8) {
      return res
        .status(400)
        .json({ status: "error", error: "new_password minimal 8 karakter" });
    }

    const chk = await pgPool.query(
      `SELECT 1
       FROM users
       WHERE id = $1
         AND password_hash = crypt($2, password_hash)
       LIMIT 1`,
      [userId, String(old_password)]
    );

    if (!chk.rows.length) {
      return res.status(401).json({ status: "error", error: "old_password salah" });
    }

    await pgPool.query(
      `UPDATE users
       SET password_hash = crypt($2, gen_salt('bf'))
       WHERE id = $1`,
      [userId, String(new_password)]
    );

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("Error change-password:", err);
    return res.status(500).json({ status: "error", error: "Internal server error" });
  }
});

// =======================================================
// SET DEFAULT SENDER PER USER
// PATCH /kirimpesan/users/me/sender
// =======================================================
app.patch("/kirimpesan/users/me/sender", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;
    const schoolId = req.user.school_id;
    const { phone_number_id } = req.body || {};

    const pnid =
      phone_number_id === null || phone_number_id === "" || typeof phone_number_id === "undefined"
        ? null
        : String(phone_number_id);

    await assertPhoneNumberBelongsToSchool(pnid, schoolId);

    await pgPool.query(
      `UPDATE users
       SET phone_number_id = $2
       WHERE id = $1`,
      [userId, pnid]
    );

    return res.json({ status: "ok", phone_number_id: pnid });
  } catch (err) {
    console.error("Error set sender:", err);
    return res.status(400).json({ status: "error", error: err.message || "Bad request" });
  }
});

// =======================================================
// LIST USERS (per school)
// GET /kirimpesan/users
// =======================================================
app.get("/kirimpesan/users", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.school_id;

    const { rows } = await pgPool.query(
      `SELECT
         id,
         username,
         display_name_user,
         role,
         phone_number_id,
         created_at
       FROM users
       WHERE school_id = $1
       ORDER BY created_at ASC`,
      [schoolId]
    );

    return res.json({ status: "ok", count: rows.length, users: rows });
  } catch (err) {
    console.error("Error list users:", err);
    return res.status(500).json({ status: "error", error: "Internal server error" });
  }
});

// =======================================================
// CREATE USER (per school)
// POST /kirimpesan/users
// =======================================================
app.post("/kirimpesan/users", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.school_id;
    const { username, password, display_name_user, role, phone_number_id } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ status: "error", error: "username & password wajib" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ status: "error", error: "password minimal 8 karakter" });
    }

    const uname = String(username).trim().toLowerCase();
    const r = role ? String(role).trim().toLowerCase() : "operator";

    const pnid =
      phone_number_id === null || phone_number_id === "" || typeof phone_number_id === "undefined"
        ? null
        : String(phone_number_id);

    await assertPhoneNumberBelongsToSchool(pnid, schoolId);

    const { rows } = await pgPool.query(
      `INSERT INTO users
         (username, password_hash, display_name_user, role, school_id, phone_number_id, created_at)
       VALUES
         ($1, crypt($2, gen_salt('bf')), $3, $4, $5, $6, NOW())
       RETURNING id, username, display_name_user, role, school_id, phone_number_id, created_at`,
      [uname, String(password), display_name_user || null, r, schoolId, pnid]
    );

    return res.json({ status: "ok", user: rows[0] });
  } catch (err) {
    const msg = err?.code === "23505" ? "username sudah dipakai" : err.message || "Internal error";
    console.error("Error create user:", err);
    return res.status(400).json({ status: "error", error: msg });
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
