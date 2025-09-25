import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());

// Variáveis de ambiente
const HF_TOKEN = process.env.HF_TOKEN;
const HF_TRANSCRIBE_MODEL = "openai/whisper-large";
const HF_SUMMARY_MODEL = "google/pegasus-xsum";

// Rota de transcrição + resumo
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

  const filePath = req.file.path;

  try {
    // Ler o arquivo de áudio
    const audioData = fs.readFileSync(filePath);

    // 1️⃣ Transcrição
    const transResp = await fetch(
      `https://api-inference.huggingface.co/models/${HF_TRANSCRIBE_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "audio/webm" // ou wav, flac conforme o arquivo
        },
        body: audioData
      }
    );

    const transData = await transResp.json();
    if (transData.error) throw new Error(transData.error);

    const transcription = transData[0]?.text || "Não foi possível transcrever";

    // 2️⃣ Resumo
    const summaryResp = await fetch(
      `https://api-inference.huggingface.co/models/${HF_SUMMARY_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs: transcription })
      }
    );

    const summaryData = await summaryResp.json();
    if (summaryData.error) throw new Error(summaryData.error);

    const resumo = summaryData[0]?.summary_text || "Não foi possível resumir";

    res.json({ transcricao: transcription, resumo });

  } catch (error) {
    console.error("❌ ERRO NO BACKEND:", error);
    res.status(500).json({ error: error.message });
  } finally {
    // Remove o arquivo temporário
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend rodando na porta ${PORT}`));
