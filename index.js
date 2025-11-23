// index.js (backend API) – versi dengan prefix /kirimpesan

import express from "express";
import fileUpload from "express-fileupload";
import cors from "cors";
import axios from "axios";
import fetch from "node-fetch";
import "dotenv/config.js";

const app = express();

// ====== CONFIG DASAR ======
const PORT       = process.env.PORT || 3000;
const WABA_ID    = process.env.WABA_ID;
const WA_TOKEN   = process.env.WA_TOKEN;
const WA_VERSION = process.env.WA_VERSION || "v21.0";

// prefix semua endpoint API
const BASE_PATH = "/kirimpesan";

// DEFAULT phone_number_id (kalau sender tidak dipilih)
const DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// MAP nomor WA → phone_number_id (ISI SENDIRI SESUAI NOMOR)
const PHONE_NUMBER_ID_MAP = {
  // contoh:
  // "6282312006987": process.env.PHONE_NUMBER_ID_6282312006987,
  // "62851xxxxxxx":  process.env.PHONE_NUMBER_ID_62851xxxxxxx,
};

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Health root (optional saja, biar kalau buka api.mckuadrat.com masih ada tulisan ONLINE)
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// Router khusus /kirimpesan
const router = express.Router();

// Health di bawah /kirimpesan (opsional, buat test)
router.get("/", (req, res) => {
  res.json({ status: "ok", path: BASE_PATH });
});

// ====== ENDPOINT: GET /kirimpesan/templates ======
router.get("/templates", async (req, res) => {
  try {
    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ status: "error", error: "WABA_ID atau WA_TOKEN belum diset" });
    }

    const status = req.query.status || "APPROVED";
    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates?status=${encodeURIComponent(status)}`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });

    const templates = Array.isArray(resp.data?.data) ? resp.data.data : [];

    const simplified = templates.map(t => ({
      id: t.id,
      name: t.name,
      category: t.category,
      language: t.language,
      status: t.status,
      components: t.components
    }));

    res.json({
      status: "ok",
      count: simplified.length,
      templates: simplified
    });
  } catch (err) {
    console.error("Error get templates:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// ====== ENDPOINT: POST /kirimpesan/templates/create ======
router.post("/templates/create", async (req, res) => {
  try {
    const {
      name,
      category,
      language = "en",
      body_text,
      example_1,
      footer_text,
      buttons
    } = req.body;

    if (!name || !category || !body_text) {
      return res.status(400).json({ status: "error", error: "name, category, body_text wajib diisi" });
    }

    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ status: "error", error: "WABA_ID atau WA_TOKEN belum diset" });
    }

    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`;

    const components = [];

    // BODY
    const bodyComponent = {
      type: "BODY",
      text: body_text
    };
    if (example_1) {
      bodyComponent.example = { body_text: [[example_1]] };
    }
    components.push(bodyComponent);

    // FOOTER
    if (footer_text) {
      components.push({
        type: "FOOTER",
        text: footer_text
      });
    }

    // BUTTONS (quick reply)
    if (Array.isArray(buttons) && buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.map((b, idx) => ({
          type: "QUICK_REPLY",
          text: b,
          index: idx
        }))
      });
    }

    const payload = {
      name,
      category,
      language,
      components
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    res.json({
      status: "submitted",
      meta_response: resp.data
    });
  } catch (err) {
    console.error("Error create template:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// ====== ENDPOINT: POST /kirimpesan/broadcast ======
router.post("/broadcast", async (req, res) => {
  try {
    const { template_name, rows, sender_phone } = req.body;

    if (!template_name) {
      return res.status(400).json({ status: "error", error: "template_name wajib diisi" });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", error: "rows wajib berupa array dan tidak boleh kosong" });
    }

    const results = [];
    for (const r of rows) {
      const phone = (r.phone || r.to || "").toString().trim();
      const var1  = r.var1 ?? "";
      const var2  = r.var2 ?? "";
      const var3  = r.var3 ?? "";

      if (!phone) continue;

      const sendResult = await sendWaTemplate({
        phone,
        templateName: template_name,
        vars: [var1, var2, var3],
        senderPhone: sender_phone || null
      });

      results.push(sendResult);
    }

    res.json({
      status: "ok",
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Error broadcast:", err);
    res.status(500).json({ status: "error", error: String(err) });
  }
});

// ====== FUNGSI KIRIM WA TEMPLATE ======
async function sendWaTemplate({ phone, templateName, vars, senderPhone }) {
  // tentukan phone_number_id berdasarkan senderPhone
  let phoneNumberId = DEFAULT_PHONE_NUMBER_ID;
  if (senderPhone && PHONE_NUMBER_ID_MAP[senderPhone]) {
    phoneNumberId = PHONE_NUMBER_ID_MAP[senderPhone];
  }

  if (!phoneNumberId) {
    throw new Error("PHONE_NUMBER_ID belum diset");
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" }, // sesuaikan sama language template
      components: [
        {
          type: "body",
          parameters: (vars || []).map(v => ({
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
      Authorization: `Bearer ${WA_TOKEN}`,
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

// pasang router di /kirimpesan
app.use(BASE_PATH, router);

// start server
app.listen(PORT, () => {
  console.log(`WA Broadcast API running on port ${PORT}, base path = ${BASE_PATH}`);
});
