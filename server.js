import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

// Pasta temporária para uploads
const upload = multer({ dest: "uploads/" });

// Hugging Face Token
const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) console.warn("⚠️ HF_TOKEN não encontrado!");

// Rota teste
app.get("/", (req, res) => res.send("Backend funcionando!"));

// Rota de transcrição + resumo
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const filePath = req.file.path;

    // --- Transcrição via Hugging Face Whisper ---
    const transcriptionResp = await fetch(
      "https://api-inference.huggingface.co/models/openai/whisper-large-v3",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/octet-stream"
        },
        body: fs.createReadStream(filePath)
      }
    );

    const contentType = transcriptionResp.headers.get("content-type");
    let transcriptionData;

    if (contentType && contentType.includes("application/json")) {
      transcriptionData = await transcriptionResp.json();
    } else {
      const text = await transcriptionResp.text();
      console.error("❌ Retorno inesperado do HF:", text);
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: "Erro no Hugging Face: retorno inesperado" });
    }

    fs.unlinkSync(filePath); // remove arquivo temporário

    if (transcriptionData.error) {
      return res.status(500).json({ error: transcriptionData.error });
    }

    const text = transcriptionData.text || "";

    // --- Resumo via Hugging Face Pegasus ---
    const summaryResp = await fetch(
      "https://api-inference.huggingface.co/models/google/pegasus-xsum",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs: text })
      }
    );

    const summaryData = await summaryResp.json();
    const resumo = summaryData[0]?.summary_text || "";

    res.json({ transcricao: text, resumo });

  } catch (err) {
    console.error("❌ ERRO NO BACKEND:", err);
    res.status(500).json({ error: err.message });
  }
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend rodando em http://localhost:${PORT}`));
