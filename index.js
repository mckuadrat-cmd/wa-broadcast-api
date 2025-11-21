import express from "express";
import fileUpload from "express-fileupload";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(fileUpload());

// Health check
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
    const results =
