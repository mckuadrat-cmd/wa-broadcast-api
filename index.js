import express from "express";
import fileUpload from "express-fileupload";

const app = express();
app.use(express.json());
app.use(fileUpload());

// ==== 1. Halaman Health Check (root) ====
app.get("/", (req, res) => {
  res.send("MCKuadrat WA Broadcast API — ONLINE ✅");
});

// ==== 2. Halaman Web untuk Sekolah Pesat Bogor ====
app.get("/sekolahpesatbogor", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <title>Broadcast WA - Sekolah Pesat Bogor</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; }
    h1 { margin-bottom: 0; }
    small { color: #666; }
    label { display: block; margin-top: 16px; font-weight: bold; }
    input[type="text"], input[type="file"] { width: 100%; padding: 8px; margin-top: 4px; }
    button { margin-top: 16px; padding: 10px 18px; font-size: 14px; cursor: pointer; }
    #result { margin-top: 24px; padding: 12px; background: #f5f5f5; white-space: pre-wrap; font-family: monospace; max-height: 300px; overflow-y: auto; }
  </style>
</head>
<body>
  <h1>Broadcast WhatsApp</h1>
  <small>Sekolah Pesat Bogor - MCKuadrat</small>

  <form id="bcForm">
    <label>
      Nama Template WhatsApp
      <input type="text" name="templateName" value="kirim_hasil_test" required />
    </label>

    <label>
      File CSV (tanpa header, format: no_wa,var1[,var2,...])
      <input type="file" name="csv" accept=".csv" required />
    </label>

    <button type="submit">Kirim Broadcast</button>
  </form>

  <div id="result"></div>

  <script>
    const form = document.getElementById('bcForm');
    const resultBox = document.getElementById('result');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      resultBox.textContent = 'Mengirim... mohon tunggu.';

      const formData = new FormData(form);

      try {
        const res = await fetch('/broadcast', {
          method: 'POST',
          body: formData
        });

        const data = await res.json();
        resultBox.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        console.error(err);
        resultBox.textContent = 'Terjadi error saat mengirim. ' + String(err);
      }
    });
  </script>
</body>
</html>
  `;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ==== 3. Endpoint /broadcast (dipakai web & Postman) ====
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
      return res.status(400).json({ error: "File CSV wajib diupload sebagai field \`csv\`" });
    }

    const text = file.data.toString("utf-8").trim();
    if (!text) {
      return res.status(400).json({ error: "Isi CSV kosong" });
    }

    const lines = text.split(/\\r?\\n/).filter(l => l.trim() !== "");
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
  const url = \`https://graph.facebook.com/v21.0/\${process.env.PHONE_NUMBER_ID}/messages\`;

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
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
      Authorization: \`Bearer \${process.env.WA_TOKEN}\`,
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
