import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const upload = multer({ dest: "uploads/" });
const HF_TOKEN = process.env.HF_TOKEN;

app.use(cors());

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const filePath = req.file.path;
    const audioBuffer = fs.readFileSync(filePath);

    const transcriptionResp = await fetch(
      "https://api-inference.huggingface.co/models/fal-ai/whisper",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "audio/flac", // ou "audio/wav" / "audio/mpeg"
        },
        body: audioBuffer,
      }
    );

    const contentType = transcriptionResp.headers.get("content-type");

    let transcriptionData;
    if (contentType && contentType.includes("application/json")) {
      transcriptionData = await transcriptionResp.json();
    } else {
      const text = await transcriptionResp.text();
      console.error("❌ Retorno inesperado do HF:", text);
      return res.status(500).json({ error: "Erro no Hugging Face: retorno inesperado" });
    }

    fs.unlinkSync(filePath);

    // Envia a transcrição de volta para o frontend
    res.json({ transcricao: transcriptionData.text || "" });

  } catch (error) {
    console.error("❌ ERRO NO BACKEND:", error);
    res.status(500).json({ error: "Erro ao processar áudio" });
  }
});

app.listen(3000, () => console.log("✅ Backend rodando em http://localhost:3000"));
