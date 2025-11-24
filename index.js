// index.js
// MCKuadrat WA Broadcast API (CommonJS, cocok dengan package.json tanpa "type": "module")

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// ====== CONFIG DARI ENV ======
const WABA_ID    = process.env.WABA_ID;          // ID WhatsApp Business Account
const WA_TOKEN   = process.env.WA_TOKEN;         // Permanent token
const WA_VERSION = process.env.WA_VERSION || "v21.0";

// PORT Railway otomatis pakai process.env.PORT
const PORT = process.env.PORT || 3000;

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json());

// ====== ROOT SIMPLE CEK ONLINE ======
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// =======================================================
// HELPER: ambil daftar phone_numbers dari WABA
// =======================================================
async function getWabaPhoneNumbers() {
  if (!WABA_ID || !WA_TOKEN) {
    throw new Error("WABA_ID atau WA_TOKEN belum diset di server");
  }

  const url =
    `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/phone_numbers` +
    `?fields=id,display_phone_number,verified_name`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` }
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
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });

    const templates = Array.isArray(resp.data?.data) ? resp.data.data : [];

    const simplified = templates.map((t) => ({
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
    console.error("Error /kirimpesan/templates:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
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
      buttons
    } = req.body || {};

    if (!name || !category || !body_text) {
      return res.status(400).json({
        status: "error",
        error: "name, category, body_text wajib diisi"
      });
    }

    if (!WABA_ID || !WA_TOKEN) {
      return res.status(500).json({ status: "error", error: "WABA_ID atau WA_TOKEN belum diset di server" });
    }

    const url = `https://graph.facebook.com/${WA_VERSION}/${WABA_ID}/message_templates`;

    // Komponen body
    const components = [
      {
        type: "BODY",
        text: body_text,
        ...(example_1
          ? { example: { body_text: [[example_1]] } }
          : {})
      }
    ];

    // Footer optional
    if (footer_text) {
      components.push({
        type: "FOOTER",
        text: footer_text
      });
    }

    // Quick reply buttons optional
    if (Array.isArray(buttons) && buttons.length) {
      components.push({
        type: "BUTTONS",
        buttons: buttons.slice(0, 3).map((label) => ({
          type: "QUICK_REPLY",
          text: label
        }))
      });
    }

    const payload = {
      name,          // lowercase + underscore (frontend sudah mengarahkan)
      category,      // "UTILITY" / "MARKETING" / "AUTHENTICATION"
      language: "en", // kita pakai English (en) dulu
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
    console.error("Error /kirimpesan/templates/create:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// =======================================================
// 4) Helper: kirim 1 WA template
//    arg: { phone, templateName, vars, phone_number_id }
// =======================================================
async function sendWaTemplate({ phone, templateName, vars, phone_number_id }) {
  // kalau backend dikirimi phone_number_id → pakai itu,
  // kalau tidak, fallback ke PHONE_NUMBER_ID default di env
  const phoneId = phone_number_id || process.env.PHONE_NUMBER_ID;
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
            text: String(v ?? "")
          }))
        }
      ]
    }
  };

  const resp = await axios.post(url, body, {
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
}

// =======================================================
// 5) POST /kirimpesan/broadcast
//    Body JSON:
//    {
//      template_name: "kirim_hasil_test",
//      sender_phone: "62851....",        // optional, dari dashboard (display number)
//      phone_number_id: "1234567890",    // optional, kalau mau kirim ID langsung
//      rows: [
//        { phone: "62812...", var1: "Ridwan", var2: "1234", ... },
//        ...
//      ]
//    }
// =======================================================
app.post("/kirimpesan/broadcast", async (req, res) => {
  try {
    const { template_name, rows, phone_number_id, sender_phone } = req.body || {};

    if (!template_name) {
      return res.status(400).json({ status: "error", error: "template_name wajib diisi" });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ status: "error", error: "rows harus array minimal 1" });
    }

    let effectivePhoneId = phone_number_id || null;

    // Kalau tidak ada phone_number_id tapi ada sender_phone (display number),
    // coba mapping ke id lewat Graph API.
    if (!effectivePhoneId && sender_phone) {
      try {
        const phones = await getWabaPhoneNumbers();
        const match = phones.find(
          (p) => String(p.display_phone_number).replace(/\s+/g, "") === String(sender_phone).replace(/\s+/g, "")
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

      // vars boleh dikirim langsung (row.vars) atau diambil dari var1,var2,var3,... dinamis
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
          phone_number_id: effectivePhoneId
        });
        results.push(r);
      } catch (err) {
        console.error("Broadcast error for", phone, err.response?.data || err.message);
        results.push({
          phone,
          ok: false,
          status: err.response?.status || 500,
          messageId: null,
          error: err.response?.data || err.message
        });
      }
    }

    res.json({
      status: "ok",
      template_name,
      count: results.length,
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
// 6) POST /kirimpesan/custom
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
//
//  Ini yang akan dipanggil webhook setelah user klik quick reply.
// =======================================================
app.post("/kirimpesan/custom", async (req, res) => {
  try {
    const { to, text, media } = req.body || {};

    if (!to) {
      return res.status(400).json({ status: "error", error: "`to` (nomor tujuan) wajib diisi" });
    }
    if (!text && !media) {
      return res.status(400).json({ status: "error", error: "Minimal text atau media harus diisi" });
    }

    // tentukan PHONE_NUMBER_ID yang dipakai
    const phoneId = process.env.PHONE_NUMBER_ID;
    if (!phoneId) {
      return res.status(500).json({ status: "error", error: "PHONE_NUMBER_ID belum diset di server" });
    }

    const url = `https://graph.facebook.com/${WA_VERSION}/${phoneId}/messages`;

    // bangun payload dasar
    let body;

    if (media && media.type && media.link) {
      // kirim message dengan lampiran + caption
      // type bisa: document, image, video, audio (sesuai WA Cloud API)
      const mType = media.type.toLowerCase();

      const baseMediaPayload = {
        link: media.link
      };

      // caption (text) kalau ada
      if (text) {
        baseMediaPayload.caption = text;
      }

      body = {
        messaging_product: "whatsapp",
        to,
        type: mType,
        [mType]: baseMediaPayload
      };
    } else {
      // text only
      body = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: text
        }
      };
    }

    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    res.json({
      status: "ok",
      to,
      wa_response: resp.data
    });
  } catch (err) {
    console.error("Error /kirimpesan/custom:", err.response?.data || err.message);
    res.status(500).json({
      status: "error",
      error: err.response?.data || err.message
    });
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
