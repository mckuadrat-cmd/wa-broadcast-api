import express from "express";
import fileUpload from "express-fileupload";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(fileUpload());

// Cek hidup
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// Endpoint broadcast sederhana: upload CSV + templateName
app.post("/broadcast", async (req, res) => {
  try {
    const templateName = req.body.templateName;
    const file = req.files?.csv;

    if (!templateName) {
      return res.status(400).json({ error: "templateName wajib diisi" });
    }
    if (!file) {
      return res.status(400).json({ error: "File CSV wajib diupload sebagai field `csv`" });
    }

    const text = file.data.toString("utf-8").trim();

    // Format CSV: no_wa,var1,var2,var3
    const lines = text.split(/\r?\n/);
    const results = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const [noWa, var1, var2, var3] = line.split(",");

      const r = await sendWaTemplate({
        phone: noWa,
        templateName,
        vars: [var1, var2, var3]
      });

      results.push(r);
    }

    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
});

async function sendWaTemplate({ phone, templateName, vars }) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" }, // sesuaikan dengan template di Meta
      components: [
        {
          type: "body",
          parameters: vars.map(v => ({
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
