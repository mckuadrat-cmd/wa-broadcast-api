import express from "express";
import fileUpload from "express-fileupload";

const app = express();
app.use(express.json());
app.use(fileUpload());

// ====== CORS SIMPLE (BIAR BISA DIPANGGIL DARI HTML / DOMAIN LAIN) ======
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // boleh dari mana saja
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Cek hidup
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// POST /broadcast
// Body: form-data -> templateName (text), csv (file)
// CSV format: no_wa,var1,var2,var3,...
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
    if (!text) {
      return res.status(400).json({ error: "Isi CSV kosong" });
    }

    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
    const results = [];

    for (const line of lines) {
      const cols = line.split(",").map(c => c.trim());
      if (!cols[0]) continue; // skip baris tanpa nomor

      const phone = cols[0];
      const vars = cols.slice(1); // bisa 1 variabel, 2, 3, dst.

      const r = await sendWaTemplate({
        phone,
        templateName,
        vars,
      });

      results.push(r);
    }

    res.json({
      ok: true,
      count: results.length,
      results,
    });
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
      language: { code: "en" }, // sesuaikan dengan template WA-mu
      components: [
        {
          type: "body",
          parameters: (vars && vars.length > 0 ? vars : [""]).map(v => ({
            type: "text",
            text: String(v ?? ""),
          })),
        },
      ],
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  return {
    phone,
    ok: resp.ok,
    status: resp.status,
    messageId: data?.messages?.[0]?.id ?? null,
    error: resp.ok ? null : data,
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("WA Broadcast API running on port", PORT);
});
