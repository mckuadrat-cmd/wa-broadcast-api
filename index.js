// index.js
// MCKuadrat WA Broadcast API (CommonJS) — multi-school (config di DB)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || "GANTI_SECRET_INI_DI_ENV";
const META_APP_ID = process.env.META_APP_ID || null;

const WEBHOOK_VERIFY_TOKEN =
  process.env.WEBHOOK_VERIFY_TOKEN || "MCKUADRAT_WEBHOOK_TOKEN";

// untuk endpoint run-scheduled
const CRON_SECRET = process.env.CRON_SECRET || "RANDOM_STRING_PANJANG";

// fallback DEV / single-school
const ENV_WABA_ID = process.env.WABA_ID || null;
const ENV_WA_TOKEN = process.env.WA_TOKEN || null;
const ENV_WA_VERSION = process.env.WA_VERSION || "v24.0";
const ENV_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || "en";
const ENV_DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || null;

// =====================
// SAFETY LOG
// =====================
process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT ERROR:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED PROMISE:", err);
});

// =====================
// PG POOL (Railway)
// =====================
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =====================
// MIDDLEWARE
// =====================
app.use(cors());
app.use(express.json());

// upload memory (15MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// =====================
// AUTH HELPERS
// =====================
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
    return res.status(401).json({ status: "error", error: "Unauthorized (no token)" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    console.error("JWT verify error:", err.message);
    return res.status(401).json({ status: "error", error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  const role = (req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "superadmin") {
    return res.status(403).json({ status: "error", error: "Forbidden (admin only)" });
  }
  next();
}

// phone_number_id harus milik sekolah user (school_phone_numbers) — jika tabel ada
async function assertPhoneNumberBelongsToSchool(phoneNumberId, schoolId) {
  if (!phoneNumberId) return true; // null => reset ke default sekolah
  const { rows } = await pgPool.query(
    `SELECT 1
       FROM school_phone_numbers
      WHERE school_id = $1 AND phone_number_id = $2
      LIMIT 1`,
    [schoolId, String(phoneNumberId)]
  );
  if (!rows.length) throw new Error("phone_number_id tidak terdaftar untuk sekolah ini");
  return true;
}

// =====================
// CTX RESOLVERS
// =====================
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

  // fallback DEV ONLY
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

  throw new Error("School config tidak ditemukan untuk user ini (dan ENV fallback tidak tersedia)");
}

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
    const s = rows[0];
    return {
      user_id: null,
      username: null,
      display_name_user: null,
      role: "admin",
      school_id: s.school_id,
      school_key: s.school_key,
      school_name: s.school_name,
      alamat: s.alamat,
      waba_id: s.waba_id,
      wa_token: s.wa_token,
      wa_version: s.wa_version || ENV_WA_VERSION,
      template_lang: s.template_lang || ENV_TEMPLATE_LANG,
      default_phone_number_id: s.default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
      phone_number_id: s.default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
    };
  }

  // fallback DEV ONLY
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

async function getCtxByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) throw new Error("phone_number_id kosong");

  // 1) mapping table
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
      const r = rows[0];
      return {
        user_id: null,
        username: null,
        display_name_user: null,
        role: "admin",
        school_id: r.school_id,
        school_key: r.school_key,
        school_name: r.school_name,
        alamat: r.alamat,
        waba_id: r.waba_id,
        wa_token: r.wa_token,
        wa_version: r.wa_version || ENV_WA_VERSION,
        template_lang: r.template_lang || ENV_TEMPLATE_LANG,
        default_phone_number_id: r.default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
        phone_number_id: String(phoneNumberId),
      };
    }
  } catch (_) {
    // ignore
  }

  // 2) fallback by schools.default_phone_number_id
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
    const s = r2[0];
    return {
      user_id: null,
      username: null,
      display_name_user: null,
      role: "admin",
      school_id: s.school_id,
      school_key: s.school_key,
      school_name: s.school_name,
      alamat: s.alamat,
      waba_id: s.waba_id,
      wa_token: s.wa_token,
      wa_version: s.wa_version || ENV_WA_VERSION,
      template_lang: s.template_lang || ENV_TEMPLATE_LANG,
      default_phone_number_id: s.default_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
      phone_number_id: String(phoneNumberId),
    };
  }

  // 3) DEV fallback
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

// =====================
// UTIL
// =====================
function normPhone(s) {
  return String(s || "").replace(/\D/g, "");
}

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
    if (!t) return { paramCount: 0, language: ctx.template_lang || "en" };

    const bodyComponent = t.components?.find((c) => c.type === "BODY");
    const text = bodyComponent?.text || "";
    const matches = text.match(/\{\{\d+\}\}/g);
    const paramCount = matches ? matches.length : 0;

    return { paramCount, language: t.language || ctx.template_lang || "en" };
  } catch (err) {
    console.error("Gagal ambil template metadata:", err.response?.data || err.message);
    return { paramCount: 0, language: ctx.template_lang || "en" };
  }
}

// replace {{1}} {{2}} from vars_json (var1 var2 ...)
function applyFollowupTemplate(text, varsMap) {
  if (!text) return "";
  const m = varsMap || {};
  return String(text).replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const key = "var" + n;
    return m[key] != null ? String(m[key]) : "";
  });
}

function buildFilenameFromTemplate(filenameTpl, varsMap, fallbackFilename) {
  if (fallbackFilename) {
    let name = String(fallbackFilename).trim();
    if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
    return name;
  }
  if (filenameTpl) {
    let name = applyFollowupTemplate(filenameTpl, varsMap).trim();
    if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
    return name || "Lampiran.pdf";
  }
  return "Lampiran.pdf";
}

// =====================
// SENDERS
// =====================
async function sendWaTemplate(ctx, { phone, templateName, templateLanguage, vars, phone_number_id, headerDocument }) {
  const phoneId = phone_number_id || ctx.phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId) throw new Error("PHONE_NUMBER_ID belum tersedia");

  const url = `https://graph.facebook.com/${ctx.wa_version}/${phoneId}/messages`;
  const langCode = templateLanguage || ctx.template_lang || "en";

  const components = [];

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

  const safeVars = Array.isArray(vars) ? vars : [];
  components.push({
    type: "body",
    parameters: (safeVars.length ? safeVars : [""]).map((v) => ({
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
    headers: { Authorization: `Bearer ${ctx.wa_token}`, "Content-Type": "application/json" },
  });

  return {
    phone,
    ok: true,
    status: resp.status,
    messageId: resp.data?.messages?.[0]?.id ?? null,
    error: null,
  };
}

async function sendCustomMessage(ctx, { to, text, media, phone_number_id }) {
  const phoneId = phone_number_id || ctx.phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID;
  if (!phoneId) throw new Error("PHONE_NUMBER_ID belum tersedia");

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
        document: { link: media.link, filename, ...(text ? { caption: text } : {}) },
      };
    } else {
      body = {
        messaging_product: "whatsapp",
        to,
        type: mType,
        [mType]: { link: media.link, ...(text ? { caption: text } : {}) },
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
    headers: { Authorization: `Bearer ${ctx.wa_token}`, "Content-Type": "application/json" },
  });

  return resp.data;
}

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// ---------- AUTH LOGIN ----------
app.post("/kirimpesan/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ status: "error", error: "Username dan password wajib diisi" });
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
      return res.status(401).json({ status: "error", error: "Username atau password salah" });
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
    return res.status(500).json({ status: "error", error: "Internal server error" });
  }
});

// ---------- ME ----------
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

    if (!rows.length) return res.status(404).json({ status: "error", error: "User not found" });

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
    return res.status(500).json({ status: "error", error: "Internal server error" });
  }
});

// ---------- SENDERS ----------
app.get("/kirimpesan/senders", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);
    const rows = await getWabaPhoneNumbers(ctx);

    const senders = rows.map((r) => ({
      id: String(r.id),
      phone_number_id: String(r.id),
      phone: r.display_phone_number,
      label: `${r.display_phone_number} - ${r.verified_name || r.display_phone_number}`,
      name: r.verified_name || r.display_phone_number,
      is_default: String(r.id) === String(ctx.default_phone_number_id || ""),
    }));

    // best-effort simpan mapping phone_number_id -> school_id
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
            [ctx.school_id, String(r.id), r.display_phone_number || null, r.verified_name || null]
          );
        }
      }
    } catch (_) {
      // ignore kalau tabel belum ada
    }

    return res.json({ status: "ok", count: senders.length, senders });
  } catch (err) {
    console.error("Error /kirimpesan/senders:", err.response?.data || err.message);
    return res.status(500).json({ status: "error", error: err.response?.data || err.message });
  }
});

// ---------- TEMPLATES ----------
app.get("/kirimpesan/templates", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    let status = (req.query.status || "").toUpperCase();
    let url = `https://graph.facebook.com/${ctx.wa_version}/${ctx.waba_id}/message_templates`;

    if (status && status !== "ALL") url += `?status=${encodeURIComponent(status)}`;

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

    return res.json({ status: "ok", count: simplified.length, templates: simplified });
  } catch (err) {
    console.error("Error /kirimpesan/templates:", err.response?.data || err.message);
    return res.status(500).json({ status: "error", error: err.response?.data || err.message });
  }
});

// ---------- UPLOAD SAMPLE (RESUMABLE HANDLE) ----------
app.post("/kirimpesan/templates/upload-sample", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    if (!META_APP_ID) return res.status(500).json({ status: "error", error: "META_APP_ID belum diset" });
    if (!ctx.wa_token) return res.status(500).json({ status: "error", error: "WA token sekolah belum diset" });
    if (!req.file) return res.status(400).json({ status: "error", error: "file wajib diupload" });

    const mimeType = req.file.mimetype || "application/pdf";
    const fileName = req.file.originalname || "sample";
    const fileLength = req.file.size;

    const createSessionUrl = `https://graph.facebook.com/${ctx.wa_version}/${META_APP_ID}/uploads`;

    const sessResp = await axios.post(createSessionUrl, null, {
      params: { file_name: fileName, file_length: fileLength, file_type: mimeType },
      headers: { Authorization: `Bearer ${ctx.wa_token}` },
    });

    const uploadSessionId = sessResp.data?.id;
    if (!uploadSessionId) {
      return res.status(500).json({ status: "error", error: "Gagal membuat upload session", error_raw: sessResp.data || null });
    }

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
      return res.status(500).json({ status: "error", error: "Upload selesai tapi handle tidak ditemukan", error_raw: upResp.data || null });
    }

    return res.json({
      status: "ok",
      handle,
      media_id: handle,
      mime_type: mimeType,
      filename: fileName,
      size: fileLength,
    });
  } catch (err) {
    const meta = err.response?.data;
    console.error("Error upload-sample:", meta || err.message);
    return res.status(err.response?.status || 500).json({
      status: "error",
      error_message: meta?.error?.message || err.message,
      error_raw: meta || err.message,
    });
  }
});

// ---------- CREATE TEMPLATE ----------
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
      return res.status(400).json({ status: "error", error: "body_text tidak boleh kosong" });
    }

    const handleId = media_handle_id || sample_media_id;
    const components = [];

    if (media_sample && media_sample !== "NONE") {
      if (!handleId) {
        return res.status(400).json({
          status: "error",
          error: "media_handle_id / sample_media_id wajib diisi jika media_sample bukan NONE",
        });
      }
      components.push({
        type: "HEADER",
        format: media_sample,
        example: { header_handle: [handleId] },
      });
    }

    components.push({
      type: "BODY",
      text: body_text,
      ...(example_1 ? { example: { body_text: [[example_1]] } } : {}),
    });

    if (footer_text) components.push({ type: "FOOTER", text: footer_text });

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
      headers: { Authorization: `Bearer ${ctx.wa_token}`, "Content-Type": "application/json" },
    });

    return res.json({ status: "submitted", meta_response: resp.data });
  } catch (err) {
    const meta = err.response?.data;
    console.error("Error /kirimpesan/templates/create:", meta || err.message);

    let message = err.message || "Gagal membuat template";
    if (meta?.error?.error_user_msg) message = meta.error.error_user_msg;
    else if (meta?.error?.message) message = meta.error.message;

    return res.status(err.response?.status || 500).json({
      status: "error",
      error_message: message,
      error_raw: meta || err.message,
    });
  }
});

// ---------- BROADCAST ----------
app.post("/kirimpesan/broadcast", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);

    const { template_name, rows, phone_number_id, sender_phone, followup, scheduled_at } = req.body || {};

    if (!template_name) return res.status(400).json({ status: "error", error: "template_name wajib diisi" });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ status: "error", error: "rows harus array minimal 1" });

    const { paramCount, language } = await getTemplateMetadata(ctx, template_name);

    const parseScheduleISO = (str) => {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    };

    let scheduledDate = null;
    let isScheduled = false;
    if (scheduled_at) {
      const dUtc = parseScheduleISO(scheduled_at);
      if (dUtc) {
        scheduledDate = dUtc;
        if (dUtc.getTime() > Date.now() + 15 * 1000) isScheduled = true;
      }
    }

    // broadcastId
    const broadcastId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

    // resolve phone_number_id
    let effectivePhoneId = phone_number_id ? String(phone_number_id) : null;

    if (!effectivePhoneId && sender_phone) {
      try {
        const phones = await getWabaPhoneNumbers(ctx);
        const match = phones.find((p) => normPhone(p.display_phone_number) === normPhone(sender_phone));
        if (match) effectivePhoneId = String(match.id);
        else console.warn("sender_phone tidak ditemukan di WABA:", sender_phone);
      } catch (e) {
        console.warn("Gagal resolve sender_phone → phone_number_id:", e.message);
      }
    }

    if (!effectivePhoneId) effectivePhoneId = ctx.phone_number_id ? String(ctx.phone_number_id) : null;

    // simpan broadcast
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

    // mode scheduled: simpan recipients saja
    if (isScheduled) {
      for (const row of rows) {
        const phone = row.phone || row.to;
        if (!phone) continue;

        const varsMap = {};
        Object.keys(row)
          .filter((k) => /^var\d+$/.test(k) && row[k] != null && row[k] !== "")
          .forEach((k) => (varsMap[k] = row[k]));

        await pgPool.query(
          `INSERT INTO broadcast_recipients (
             id, broadcast_id, phone, vars_json, follow_media, follow_media_filename,
             template_ok, template_http_status, template_error, created_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NULL, NULL, NULL, NOW())`,
          [
            broadcastId,
            phone,
            Object.keys(varsMap).length ? varsMap : null,
            row.follow_media || null,
            row.follow_media_filename || null,
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

    // mode langsung: kirim + simpan hasil
    const results = [];

    for (const row of rows) {
      const phone = row.phone || row.to;
      if (!phone) continue;

      // vars array dari row var1..varN
      const varsMap = {};
      const varKeys = Object.keys(row)
        .filter((k) => /^var\d+$/.test(k) && row[k] != null && row[k] !== "")
        .sort((a, b) => parseInt(a.replace("var", ""), 10) - parseInt(b.replace("var", ""), 10));
      const vars = varKeys.map((k) => {
        varsMap[k] = row[k];
        return row[k];
      });
      const varsForTemplate = vars.slice(0, paramCount);

      const headerDocument = row.follow_media
        ? { link: row.follow_media, filename: row.follow_media_filename || null }
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
            row.follow_media || null,
            row.follow_media_filename || null,
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
            row.follow_media || null,
            row.follow_media_filename || null,
            false,
            err.response?.status || null,
            typeof errorPayload === "string" ? { message: errorPayload } : errorPayload,
          ]
        );
      }
    }

    const total = results.length;
    const ok = results.filter((r) => r.ok).length;
    const failed = total - ok;

    return res.json({ status: "ok", broadcast_id: broadcastId, template_name, count: total, ok, failed, results });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast:", err);
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

// ---------- CUSTOM MESSAGE ----------
app.post("/kirimpesan/custom", authMiddleware, async (req, res) => {
  try {
    const ctx = await getCtxByUserId(req.user.sub);
    const { to, text, media, phone_number_id } = req.body || {};

    if (!to) return res.status(400).json({ status: "error", error: "`to` wajib diisi" });
    if (!text && !media) return res.status(400).json({ status: "error", error: "Minimal text atau media harus diisi" });

    const waRes = await sendCustomMessage(ctx, { to, text, media, phone_number_id });

    // log outgoing (best-effort)
    try {
      await pgPool.query(
        `
        INSERT INTO inbox_messages (at, phone, message_type, message_text, is_quick_reply, broadcast_id, raw_json)
        VALUES (NOW(), $1, $2, $3, $4, $5, $6)
        `,
        [to, media ? "outgoing_media" : "outgoing", text || null, false, null, JSON.stringify(waRes || {})]
      );
    } catch (dbErr) {
      console.error("Gagal insert outgoing ke inbox_messages:", dbErr);
    }

    return res.json({ status: "ok", to, wa_response: waRes });
  } catch (err) {
    console.error("Error /kirimpesan/custom:", err.response?.data || err.message);
    return res.status(500).json({ status: "error", error: err.response?.data || err.message });
  }
});

// =====================
// WEBHOOK VERIFY
// =====================
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

// =====================
// WEBHOOK INCOMING
// =====================
app.post("/kirimpesan/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || !messages.length) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from; // 628xx
    const phoneNumberId = value?.metadata?.phone_number_id || null;

    let triggerText = "";
    if (msg.type === "text" && msg.text) triggerText = msg.text.body || "";
    else if (msg.type === "button" && msg.button) triggerText = msg.button.text || msg.button.payload || "";
    else if (msg.type === "interactive" && msg.interactive) {
      if (msg.interactive.button_reply) triggerText = msg.interactive.button_reply.title || msg.interactive.button_reply.id || "";
      else if (msg.interactive.list_reply) triggerText = msg.interactive.list_reply.title || msg.interactive.list_reply.id || "";
    }

    // query terakhir broadcast+recipient utk nomor ini (buat vars + media + followup_config)
    const q = await pgPool.query(
      `
      SELECT
        b.id AS broadcast_id,
        b.school_id,
        b.followup_config,
        b.phone_number_id AS broadcast_phone_number_id,
        br.vars_json,
        br.follow_media,
        br.follow_media_filename
      FROM broadcasts b
      JOIN broadcast_recipients br ON br.broadcast_id = b.id
      WHERE br.phone = $1
      ORDER BY b.created_at DESC
      LIMIT 1
      `,
      [from]
    );

    const row = q.rows[0] || null;
    const broadcastId = row?.broadcast_id || null;

    // simpan inbox_messages (best-effort)
    try {
      const isQuickReply = !!triggerText && (msg.type === "button" || msg.type === "interactive");
      await pgPool.query(
        `INSERT INTO inbox_messages
         (at, phone, message_type, message_text, raw_json, broadcast_id, is_quick_reply, phone_number_id)
         VALUES (NOW(), $1,$2,$3,$4,$5,$6,$7)`,
        [
          from,
          msg.type || null,
          triggerText || null,
          JSON.stringify(req.body || {}),
          broadcastId,
          isQuickReply,
          phoneNumberId,
        ]
      );
    } catch (e) {
      console.error("Insert inbox_messages error:", e.message);
    }

    // bukan "BERSEDIA" => stop
    if (!triggerText || !String(triggerText).toUpperCase().includes("BERSEDIA")) {
      return res.sendStatus(200);
    }

    // followup_config harus ada
    let followupConfig = row?.followup_config || null;
    if (typeof followupConfig === "string") {
      try { followupConfig = JSON.parse(followupConfig); } catch { /* ignore */ }
    }
    if (!followupConfig || !followupConfig.text) {
      console.log("No followup config, ignore.");
      return res.sendStatus(200);
    }

    const varsMap = row?.vars_json || {};
    const text = applyFollowupTemplate(followupConfig.text, varsMap);

    // media follow-up: prioritas per penerima, fallback static_media
    let media = null;
    const filenameTpl = followupConfig.static_media?.filename || null;
    const finalFilename = buildFilenameFromTemplate(filenameTpl, varsMap, row?.follow_media_filename);

    if (row?.follow_media) {
      media = { type: "document", link: row.follow_media, filename: finalFilename };
    } else if (followupConfig.static_media?.link) {
      media = {
        type: followupConfig.static_media.type || "document",
        link: followupConfig.static_media.link,
        filename: finalFilename,
      };
    }

    // resolve token untuk kirim followup
    let followCtx = null;
    try {
      if (phoneNumberId) followCtx = await getCtxByPhoneNumberId(phoneNumberId);
      else if (row?.school_id) followCtx = await getCtxBySchoolId(row.school_id);
    } catch (_) {
      followCtx = null;
    }
    if (!followCtx) {
      followCtx = {
        wa_token: ENV_WA_TOKEN,
        wa_version: ENV_WA_VERSION,
        phone_number_id: phoneNumberId || row?.broadcast_phone_number_id || ENV_DEFAULT_PHONE_NUMBER_ID,
      };
    }
    if (!followCtx.wa_token) {
      console.warn("Token WA tidak tersedia; follow-up tidak bisa dikirim.");
      return res.sendStatus(200);
    }

    try {
      const waRes = await sendCustomMessage(followCtx, {
        to: from,
        text,
        media,
        phone_number_id: followCtx.phone_number_id,
      });

      if (broadcastId) {
        await pgPool.query(
          `INSERT INTO broadcast_followups
             (id, broadcast_id, phone, text, has_media, media_link, status, error, at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'ok',NULL,NOW())`,
          [broadcastId, from, text, !!media, media ? media.link : null]
        );
      }

      console.log("Follow-up sent:", waRes?.messages?.[0]?.id || "(ok)");
    } catch (err) {
      const errorPayload = err.response?.data || err.message;
      console.error("Error sending follow-up:", errorPayload);

      if (broadcastId) {
        await pgPool.query(
          `INSERT INTO broadcast_followups
             (id, broadcast_id, phone, text, has_media, media_link, status, error, at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'error',$6,NOW())`,
          [
            broadcastId,
            from,
            text,
            !!media,
            media ? media.link : null,
            typeof errorPayload === "string" ? { message: errorPayload } : errorPayload,
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

// =====================
// BROADCAST LOGS (SCOPED SCHOOL)
// =====================
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
    return res.json({ status: "ok", count: rows.length, logs: rows });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs:", err);
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

app.get("/kirimpesan/broadcast/logs/:id", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const schoolId = req.user.school_id;

  try {
    const bRes = await pgPool.query("SELECT * FROM broadcasts WHERE id = $1 AND school_id = $2", [id, schoolId]);
    if (!bRes.rows.length) return res.status(404).json({ status: "error", error: "Log not found" });

    const broadcast = bRes.rows[0];
    const rRes = await pgPool.query(`SELECT * FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY id`, [id]);
    const fRes = await pgPool.query(`SELECT * FROM broadcast_followups WHERE broadcast_id = $1 ORDER BY at`, [id]);

    return res.json({ status: "ok", log: { broadcast, recipients: rRes.rows, followups: fRes.rows } });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/logs/:id:", err);
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

// =====================
// INBOX (SCOPED by school)
// =====================
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
    return res.json({ status: "ok", messages: rows });
  } catch (err) {
    console.error("Inbox error:", err);
    return res.status(500).json({ status: "error", error: "Gagal memuat inbox" });
  }
});

// =====================
// RUN SCHEDULED
// =====================
app.get("/kirimpesan/broadcast/run-scheduled", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (secret !== CRON_SECRET) {
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

    if (!broadcasts.length) return res.json({ status: "ok", ran: [] });

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

      let ctx = null;
      try {
        if (bc.school_id) ctx = await getCtxBySchoolId(bc.school_id);
      } catch (_) {
        ctx = null;
      }

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
          .sort((a, b) => parseInt(a.replace("var", ""), 10) - parseInt(b.replace("var", ""), 10));

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
      ran.push({ broadcast_id: bc.id, total: recipients.length, ok: okCount, failed: failCount });
    }

    return res.json({ status: "ok", ran });
  } catch (err) {
    console.error("Error /kirimpesan/broadcast/run-scheduled:", err);
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

// =====================
// PROXY MEDIA
// =====================
app.get("/kirimpesan/media/:id", async (req, res) => {
  try {
    const mediaId = req.params.id;
    if (!mediaId) return res.status(400).send("media id required");

    const schoolId = req.query.school_id || null;
    const phoneNumberIdQ = req.query.phone_number_id || null;

    let ctx = null;

    if (schoolId) {
      try { ctx = await getCtxBySchoolId(schoolId); } catch (_) { ctx = null; }
    }

    if (!ctx && phoneNumberIdQ) {
      try { ctx = await getCtxByPhoneNumberId(phoneNumberIdQ); } catch (_) { ctx = null; }
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
      } catch (_) {
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
    return res.status(500).send("Error fetching media");
  }
});

// =====================
// CHANGE PASSWORD
// =====================
app.post("/kirimpesan/auth/change-password", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { old_password, new_password } = req.body || {};

    if (!old_password || !new_password) {
      return res.status(400).json({ status: "error", error: "old_password & new_password wajib" });
    }
    if (String(new_password).length < 8) {
      return res.status(400).json({ status: "error", error: "new_password minimal 8 karakter" });
    }

    const chk = await pgPool.query(
      `SELECT 1
       FROM users
       WHERE id = $1
         AND password_hash = crypt($2, password_hash)
       LIMIT 1`,
      [userId, String(old_password)]
    );

    if (!chk.rows.length) return res.status(401).json({ status: "error", error: "old_password salah" });

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

// =====================
// SET DEFAULT SENDER PER USER
// =====================
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

    await pgPool.query(`UPDATE users SET phone_number_id = $2 WHERE id = $1`, [userId, pnid]);
    return res.json({ status: "ok", phone_number_id: pnid });
  } catch (err) {
    console.error("Error set sender:", err);
    return res.status(400).json({ status: "error", error: err.message || "Bad request" });
  }
});

// =====================
// USERS LIST + CREATE
// =====================
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

app.post("/kirimpesan/users", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.school_id;
    const { username, password, display_name_user, role, phone_number_id } = req.body || {};

    if (!username || !password) return res.status(400).json({ status: "error", error: "username & password wajib" });
    if (String(password).length < 8) return res.status(400).json({ status: "error", error: "password minimal 8 karakter" });

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
    const msg = err?.code === "23505" ? "username sudah dipakai" : (err.message || "Internal error");
    console.error("Error create user:", err);
    return res.status(400).json({ status: "error", error: msg });
  }
});

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
