// server.js (Versão Corrigida/Melhorada)
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
    const audioMimeType = req.file.mimetype; // Obtém o tipo real do arquivo (ex: 'audio/webm')

    const transcriptionResp = await fetch(
      "https://api-inference.huggingface.co/models/fal-ai/whisper",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": audioMimeType, // **CORRIGIDO: Usa o mimetype real**
        },
        body: audioBuffer,
      }
    );

    // Verifica se a resposta foi bem-sucedida (status 2xx)
    if (!transcriptionResp.ok) {
         const errorText = await transcriptionResp.text();
         console.error(`❌ Erro HTTP ${transcriptionResp.status} do HF:`, errorText);
         // Tenta extrair a mensagem de erro se for JSON, senão usa o texto.
         try {
            const errorJson = JSON.parse(errorText);
            return res.status(transcriptionResp.status).json({ error: errorJson.error || "Erro na API do Hugging Face" });
         } catch (e) {
            return res.status(transcriptionResp.status).json({ error: "Erro na API do Hugging Face: " + errorText.substring(0, 100) });
         }
    }
    

    const contentType = transcriptionResp.headers.get("content-type");

    let transcriptionData;
    if (contentType && contentType.includes("application/json")) {
      transcriptionData = await transcriptionResp.json();
    } else {
      const text = await transcriptionResp.text();
      console.error("❌ Retorno inesperado do HF (não JSON):", text);
      return res.status(500).json({ error: "Erro no Hugging Face: retorno inesperado" });
    }

    fs.unlinkSync(filePath);

    // Envia a transcrição de volta para o frontend
    res.json({ transcricao: transcriptionData.text || "" });

  } catch (error) {
    console.error("❌ ERRO NO BACKEND:", error);
    // Garante que o arquivo temporário seja removido mesmo em caso de erro
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Erro ao processar áudio" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`✅ Backend rodando na porta ${PORT}`));
