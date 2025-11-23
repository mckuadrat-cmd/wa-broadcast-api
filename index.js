// index.js  — WA Broadcast API (MCKuadrat /kirimpesan)

// ----------------------
// IMPORTS (ESM FULL)
// ----------------------
import express from "express";
import fileUpload from "express-fileupload";
import axios from "axios";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ----------------------
// ENV CONFIG
// ----------------------
const WABA_ID    = process.env.WABA_ID;
const WA_TOKEN   = process.env.WA_TOKEN;
const WA_VERSION = process.env.WA_VERSION || "v20.0";

// default PHONE_NUMBER_ID untuk kirim pesan
const DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// map sender_id dari frontend → PHONE_NUMBER_ID
// sekarang baru satu, nanti bisa kamu tambah sendiri
const PHONE_NUMBER_MAP = {
  PRIMARY: DEFAULT_PHONE_NUMBER_ID,
};

// Semua endpoint kita taruh di bawah path ini
const BASE_PATH = "/kirimpesan";

// ----------------------
// EXPRESS APP
// ----------------------
const app = express();
app.use(express.json());
app.use(fileUpload());

// CORS sederhana
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// ----------------------
// HEALTHCHECK
// ----------------------
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// Supaya gampang cek root /kirimpesan juga
app.get(BASE_PATH + "/", (req, res) => {
  res.json({
    status: "ok",
    message: "MCKuadrat WA Broadcast API — /kirimpesan root",
  });
});

// ----------------------
// GET /kirimpesan/templates?status=APPROVED
// ----------------------
app.get(BASE_PATH + "/templates", async (req, res) => {
  try {
    if (!WABA_ID || !WA_TOKEN) {
      return res
        .status(500)
        .json({ status: "error", error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const status = req.query.status || "APPROVED";

    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates?status=${encodeURIComponent(
      status
    )}`;

    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
      },
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

    return res.json({
      status: "ok",
      count: simplified.length,
      templates: simplified,
    });
  } catch (err) {
    console.error("Error get templates:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// ----------------------
// POST /kirimpesan/templates/create
// body: { name, category, body_text, example_1, footer_text, buttons[] }
// ----------------------
app.post(BASE_PATH + "/templates/create", async (req, res) => {
  try {
    const {
      name, // "kirim_hasil_test"
      category, // "UTILITY" / "MARKETING" / "AUTHENTICATION"
      body_text,
      example_1,
      footer_text,
      buttons,
    } = req.body;

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

    const components = [];

    // BODY wajib
    const bodyComp = {
      type: "BODY",
      text: body_text,
    };
    if (example_1) {
      bodyComp.example = { body_text: [[example_1]] };
    }
    components.push(bodyComp);

    // FOOTER optional
    if (footer_text) {
      components.push({
        type: "FOOTER",
        text: footer_text,
      });
    }

    // BUTTONS optional (quick reply)
    const btns = Array.isArray(buttons)
      ? buttons.filter((b) => typeof b === "string" && b.trim().length > 0)
      : [];
    if (btns.length) {
      components.push({
        type: "BUTTONS",
        buttons: btns.map((txt) => ({
          type: "QUICK_REPLY",
          text: txt,
        })),
      });
    }

    const payload = {
      name,
      category,
      language: "en", // sesuai UI: English (en)
      components,
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    return res.json({
      status: "submitted",
      meta_response: resp.data,
    });
  } catch (err) {
    console.error("Error create template:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      error: err.response?.data || err.message,
    });
  }
});

// ====== GET /kirimpesan/senders ======
// Ambil daftar phone_number dari WABA via Graph API
app.get("/kirimpesan/senders", async (req, res) => {
  try {
    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const url =
      `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/phone_numbers` +
      `?fields=id,display_phone_number,verified_name`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });

    const rows = Array.isArray(resp.data?.data) ? resp.data.data : [];

    const senders = rows.map((r) => ({
      phone_number_id: r.id,
      phone: r.display_phone_number,
      name: r.verified_name || r.display_phone_number
    }));

    res.json({
      status: "ok",
      count: senders.length,
      senders
    });
  } catch (err) {
    console.error("Error /kirimpesan/senders:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// ----------------------
// POST /kirimpesan/broadcast
// body: { template_name, rows: [{phone, var1}], sender_id? }
// ----------------------
app.post(BASE_PATH + "/broadcast", async (req, res) => {
  try {
    const { template_name, rows, sender_id } = req.body;

    if (!template_name) {
      return res.status(400).json({ status: "error", error: "template_name wajib diisi" });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        status: "error",
        error: "rows (daftar penerima) wajib diisi",
      });
    }

    if (!WA_TOKEN || !DEFAULT_PHONE_NUMBER_ID) {
      return res.status(500).json({
        status: "error",
        error: "WA_TOKEN atau PHONE_NUMBER_ID belum diset di server",
      });
    }

    const phoneNumberId =
      PHONE_NUMBER_MAP[sender_id] || DEFAULT_PHONE_NUMBER_ID;

    const results = [];
    for (const row of rows) {
      const phone = (row.phone || row.to || "").toString().trim();
      const var1 = (row.var1 || "").toString();

      if (!phone) continue;

      const r = await sendWaTemplate({
        phone,
        templateName: template_name,
        vars: [var1],
        phoneNumberId,
      });

      results.push(r);
    }

    return res.json({
      status: "ok",
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("Error broadcast:", err);
    return res.status(500).json({
      status: "error",
      error: String(err),
    });
  }
});

// ----------------------
// Helper kirim WA template
// ----------------------
async function sendWaTemplate({ phone, templateName, vars, phone_number_id }) {
  const phoneId = phone_number_id || process.env.PHONE_NUMBER_ID; // fallback ke default

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" }, // atau "id" sesuai template
      components: [
        {
          type: "body",
          parameters: (vars && vars.length > 0 ? vars : [""]).map(v => ({
            type: "text",
            text: String(v ?? "")
          }))
        }
      ]
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();

  return {
    phone,
    ok: resp.ok,
    status: resp.status,
    messageId: data?.messages?.[0]?.id ?? null,
    error: resp.ok ? null : data
  };
}

// ----------------------
// START SERVER
// ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
