// ====== IMPORT MODULE ======
const express = require("express");
const cors = require("cors");
const axios = require("axios");

// ====== ENV VARS ======
const WABA_ID = process.env.WABA_ID;                  // WhatsApp Business Account ID
const WA_TOKEN = process.env.WA_TOKEN;                // Access token Meta
const WA_VERSION = process.env.WA_VERSION || "v20.0"; // versi Graph API
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;  // phone number id WA Cloud

// ====== APP SETUP ======
const app = express();

// Baca JSON body
app.use(express.json());

// CORS (boleh diakses dari app.mckuadrat.com)
app.use(cors());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// ====== HEALTHCHECK ======
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// ====== BROADCAST (JSON, BUKAN FILE UPLOAD) ======
// Body JSON:
// {
//   "template_name": "kirim_hasil_test",
//   "rows": [
//     { "phone": "62823xxxx", "var1": "Bapak/Ibu Ridwan" },
//     { "phone": "62812xxxx", "var1": "Bapak/Ibu Budi" }
//   ]
// }
app.post("/broadcast", async (req, res) => {
  try {
    const { template_name, rows } = req.body;

    if (!template_name) {
      return res.status(400).json({ error: "template_name wajib diisi" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows wajib berupa array dengan minimal 1 item" });
    }
    if (!PHONE_NUMBER_ID || !WA_TOKEN) {
      return res.status(500).json({ error: "PHONE_NUMBER_ID atau WA_TOKEN belum diset di server" });
    }

    const results = [];

    for (const row of rows) {
      const phone = String(row.phone || "").trim();
      const var1  = String(row.var1  || "").trim(); // saat ini cuma dukung {{1}}

      if (!phone) {
        results.push({ phone: null, ok: false, error: "no phone", raw: row });
        continue;
      }

      const r = await sendWaTemplate({
        phone,
        templateName: template_name,
        vars: [var1]
      });

      results.push(r);
    }

    return res.json({
      status: "ok",
      template_name,
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Error /broadcast:", err);
    return res.status(500).json({
      status: "error",
      error: String(err)
    });
  }
});

// ====== AJUKAN TEMPLATE BARU ======
app.post("/templates/create", async (req, res) => {
  try {
    const {
      name,          // contoh: "kirim_hasil_test_pesat"
      category,      // "UTILITY" atau "MARKETING"
      body_text,     // teks body, boleh ada {{1}}
      example_1,     // sample isi {{1}} (opsional)
      footer_text,   // teks footer (opsional)
      buttons        // array string button text (opsional)
    } = req.body;

    // language kita kunci sebagai English (en)
    const language = "en";

    if (!name || !category || !body_text) {
      return res.status(400).json({ error: "name, category, body_text wajib diisi" });
    }

    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`;

    const components = [];

    // BODY (WAJIB)
    const bodyComponent = {
      type: "BODY",
      text: body_text
    };
    if (example_1) {
      bodyComponent.example = { body_text: [[example_1]] };
    }
    components.push(bodyComponent);

    // FOOTER (OPSIONAL)
    if (footer_text && footer_text.trim().length > 0) {
      components.push({
        type: "FOOTER",
        text: footer_text.trim()
      });
    }

    // BUTTONS (OPSIONAL – Quick Reply)
    const btnArray = Array.isArray(buttons)
      ? buttons.filter(b => typeof b === "string" && b.trim().length > 0)
      : [];

    if (btnArray.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: btnArray.map((text, idx) => ({
          type: "QUICK_REPLY",
          text: text.trim()
        }))
      });
    }

    const payload = {
      name,       // harus lowercase + underscore, diatur dari frontend
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

    return res.json({
      status: "submitted",
      payload_sent: payload,
      meta_response: resp.data
    });

  } catch (err) {
    console.error("Error /templates/create:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// ====== AMBIL DAFTAR TEMPLATE (APPROVED) ======
app.get("/templates", async (req, res) => {
  try {
    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const status = req.query.status || "APPROVED";
    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates?status=${encodeURIComponent(status)}`;

    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`
      }
    });

    const templates = Array.isArray(resp.data?.data) ? resp.data.data : [];

    const simplified = templates.map(t => ({
      name: t.name,
      category: t.category,
      language: t.language,
      status: t.status,
      id: t.id,
      components: t.components
    }));

    return res.json({
      status: "ok",
      count: simplified.length,
      templates: simplified
    });

  } catch (err) {
    console.error("Error /templates:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// ====== HELPER: KIRIM TEMPLATE WA ======
async function sendWaTemplate({ phone, templateName, vars }) {
  const url = `https://graph.facebook.com/${WA_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      // SESUAIKAN dengan bahasa template di Meta (id, en_US, dll)
      language: { code: "en" },
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

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    const data = resp.data;

    return {
      phone,
      ok: true,
      status: resp.status,
      messageId: data?.messages?.[0]?.id ?? null,
      error: null
    };
  } catch (err) {
    const data = err.response?.data || err.message;
    return {
      phone,
      ok: false,
      status: err.response?.status || 500,
      messageId: null,
      error: data
    };
  }
}

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
