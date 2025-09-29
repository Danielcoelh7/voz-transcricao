// server.js (Versão Final com Conversão de Áudio)

import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg"; // Importar
import ffmpegStatic from "ffmpeg-static"; // Importar

// Configurar o caminho do ffmpeg
ffmpeg.setFfmpegPath(ffmpegStatic); 

const app = express();
const upload = multer({ dest: "uploads/" });
const HF_TOKEN = process.env.HF_TOKEN;

app.use(cors());

// Função para converter WebM para FLAC (ou WAV)
function convertToFlac(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('flac') // FLAC é um formato de áudio sem perdas (lossless)
      .on('error', (err) => {
        console.error('Erro de conversão FFmpeg:', err);
        reject(err);
      })
      .on('end', () => {
        resolve(outputPath);
      })
      .save(outputPath);
  });
}


app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let convertedFilePath;
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const inputFilePath = req.file.path;
    convertedFilePath = inputFilePath + ".flac"; // Novo caminho para o arquivo FLAC

    // 1. CONVERTER O ÁUDIO DE WEBM PARA FLAC
    await convertToFlac(inputFilePath, convertedFilePath);
    
    // 2. LER O ÁUDIO CONVERTIDO
    const audioBuffer = fs.readFileSync(convertedFilePath);
    const audioMimeType = "audio/flac"; // Tipo de conteúdo correto após a conversão

    // 3. ENVIAR PARA O HUGGING FACE
    const transcriptionResp = await fetch(
      "https://api-inference.huggingface.co/models/openai/whisper-small", // Use o modelo small/base
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": audioMimeType, // Agora é 'audio/flac'
        },
        body: audioBuffer,
      }
    );

    // ... (O restante da sua lógica de tratamento de resposta e erros permanece igual)
    if (!transcriptionResp.ok) {
        // ... (Seu código de erro)
        const errorText = await transcriptionResp.text();
        console.error(`❌ Erro HTTP ${transcriptionResp.status} do HF:`, errorText);
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

    // 4. LIMPAR ARQUIVOS TEMPORÁRIOS
    fs.unlinkSync(inputFilePath); // Remove o arquivo original WebM
    fs.unlinkSync(convertedFilePath); // Remove o arquivo FLAC

    res.json({ transcricao: transcriptionData.text || "" });

  } catch (error) {
    console.error("❌ ERRO NO BACKEND:", error);
    // 5. GARANTIR A LIMPEZA MESMO COM ERRO
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (convertedFilePath && fs.existsSync(convertedFilePath)) fs.unlinkSync(convertedFilePath);
    res.status(500).json({ error: "Erro ao processar áudio: " + error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`✅ Backend rodando na porta ${PORT}`));
