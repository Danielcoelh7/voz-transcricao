import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

// Configuração do FFmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

// Chave da API do Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// "Banco" em memória para controlar os jobs
const jobs = {};

// Função auxiliar: converte arquivo em formato aceito pelo Gemini
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType,
    },
  };
}

// ================================
// 1️⃣ ENDPOINT DE TRANSCRIÇÃO
// ================================
app.post("/transcribe-chunked", upload.single("audio"), (req, res) => {
  if (!req.file) {
    console.error("[ERRO] Nenhum arquivo recebido.");
    return res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
  }

  const jobId = uuidv4();
  const filePath = req.file.path;
  const outputDir = `uploads/${jobId}`;

  console.log(`[JOB ${jobId}] Iniciado. Arquivo: ${filePath}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Retorna resposta imediata ao front
  res.status(202).json({ jobId });

  // Marca o job como em andamento
  jobs[jobId] = { status: "splitting", progress: 0 };

  // ==========================
  // DIVISÃO DO ÁUDIO EM CHUNKS
  // ==========================
  console.log(`[JOB ${jobId}] Dividindo o áudio com FFmpeg...`);

  ffmpeg(filePath)
    .outputOptions(["-f segment", "-segment_time 120", "-c copy"]) // 2 minutos por chunk
    .output(`${outputDir}/chunk_%03d.mp3`)
    .on("progress", (progress) => {
      console.log(`[JOB ${jobId}] [FFmpeg] ${progress.timemark}`);
    })
    .on("end", async () => {
      console.log(`[JOB ${jobId}] Divisão concluída.`);

      jobs[jobId].status = "processing";
      const chunkFiles = fs.readdirSync(outputDir).sort();
      console.log(`[JOB ${jobId}] ${chunkFiles.length} partes encontradas.`);

      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      let fullTranscription = [];

      // =========================================
      // PROCESSAMENTO DE CADA CHUNK (TRANSCRIÇÃO)
      // =========================================
      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = `${outputDir}/${chunkFiles[i]}`;
        try {
          console.log(`[JOB ${jobId}] Transcrevendo ${chunkFiles[i]}...`);

          const audioPart = fileToGenerativePart(chunkPath, "audio/mp3");
          const prompt =
            "Transcreva o áudio a seguir na íntegra. Não adicione comentários, apenas o texto falado.";

          const result = await model.generateContent([prompt, audioPart]);
          const text = result.response.text();

          fullTranscription.push(text);
          jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;
        } catch (error) {
          console.error(`[JOB ${jobId}] Erro no chunk ${i + 1}:`, error);
          fullTranscription.push(`[ERRO NA TRANSCRIÇÃO DO TRECHO ${i + 1}]`);
        }
      }

      console.log(`[JOB ${jobId}] Transcrição completa.`);
      const fullText = fullTranscription.join(" ");

      // ==============================
      // 🧠 GERAÇÃO DE RESUMO EM TÓPICOS
      // ==============================
      try {
        jobs[jobId].status = "summarizing";
        console.log(`[JOB ${jobId}] Gerando resumo em tópicos...`);

        const summaryPrompt = `
        Resuma o texto abaixo em tópicos curtos e claros.
        Cada linha deve começar com o símbolo •
        Foque nas ideias principais e elimine repetições.

        Texto:
        ${fullText}
        `;

        const summaryModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const summaryResult = await summaryModel.generateContent(summaryPrompt);
        const summaryText = summaryResult.response.text();

        jobs[jobId] = {
          status: "completed",
          transcription: fullText,
          summary: summaryText,
          progress: 100,
        };

        console.log(`[JOB ${jobId}] Resumo gerado com sucesso.`);
      } catch (error) {
        console.error(`[JOB ${jobId}] Erro ao gerar resumo:`, error);
        jobs[jobId] = {
          status: "completed",
          transcription: fullText,
          summary: "[Erro ao gerar resumo automático]",
          progress: 100,
        };
      }

      // ==============================
      // LIMPEZA FINAL
      // ==============================
      console.log(`[JOB ${jobId}] Limpando arquivos temporários.`);
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.unlinkSync(filePath);
    })
    .on("error", (err, stdout, stderr) => {
      console.error(`[JOB ${jobId}] [FFmpeg] ERRO:`, err.message);
      console.error(stderr);
      jobs[jobId] = { status: "failed", error: "Erro ao dividir o áudio." };

      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    })
    .run();
});

// ================================
// 2️⃣ ENDPOINT DE STATUS
// ================================
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: "Trabalho não encontrado." });
  }

  res.json(job);
});

// ================================
// 3️⃣ INICIALIZAÇÃO DO SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
