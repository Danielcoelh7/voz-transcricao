import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import OpenAI from "openai";

// Configurações

const app = express();
const upload = multer({ dest: "uploads/" });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());

// Rota de transcrição + resumo
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const filePath = req.file.path;

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });

    fs.unlinkSync(filePath);

    const resumoResp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Você é um assistente que resume textos longos de forma clara para alunos entederem." },
        { role: "user", content: `Resuma o seguinte texto em até 10 parágrafos:\n\n${transcription.text}` }
      ]
    });

    const resumo = resumoResp.choices[0].message.content;

    res.json({ transcricao: transcription.text, resumo });

  } catch (error) {
    console.error("❌ ERRO NO BACKEND:", error);
    res.status(500).json({ error: "Erro ao processar áudio" });
  }
});

app.listen(3000, () => console.log("✅ Backend rodando em http://localhost:3000"));
