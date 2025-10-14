import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

// --- CHAVE DO GEMINI ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ ERRO: A variável GEMINI_API_KEY não foi definida.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const jobs = {};

// --- Função auxiliar: transforma o arquivo local em parte generativa ---
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType,
    },
  };
}

// --- Fallback automático de modelos Gemini ---
async function selecionarModeloDisponivel() {
  const modelosPreferidos = [
    "gemini-2.0-flash",
    "gemini-2.0-pro",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ];

  for (const nome of modelosPreferidos) {
    try {
      console.log(`🔍 Testando modelo: ${nome}`);
      const modelo = genAI.getGenerativeModel({ model: nome });
      // Teste mínimo de conexão
      await modelo.generateContent(["Teste de disponibilidade do modelo."]);
      console.log(`✅ Modelo disponível: ${nome}`);
      return modelo;
    } catch (err) {
      console.log(`⚠️ Modelo ${nome} indisponível (${err.message}).`);
    }
  }
  throw new Error("Nenhum modelo Gemini disponível ou autorizado para uso.");
}

// --- ENDPOINT: Inicia a transcrição de forma assíncrona ---
app.post("/transcribe-chunked", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    console.error("[ERRO] Nenhum arquivo recebido.");
    return res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
  }

  const jobId = uuidv4();
  const filePath = req.file.path;
  const outputDir = `uploads/${jobId}`;

  console.log(`[JOB ${jobId}] Arquivo recebido em: ${filePath}`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  res.status(202).json({ jobId });

  jobs[jobId] = { status: "splitting", transcription: null, progress: 0 };

  // --- Divide o áudio em chunks de 60s ---
  ffmpeg(filePath)
    .outputOptions(["-f segment", "-segment_time 60", "-c copy"])
    .output(`${outputDir}/chunk_%03d.mp3`)
    .on("end", async () => {
      console.log(`[JOB ${jobId}] Divisão concluída.`);
      jobs[jobId].status = "processing";

      const chunkFiles = fs.readdirSync(outputDir).sort();
      console.log(`[JOB ${jobId}] ${chunkFiles.length} partes encontradas.`);

      let fullTranscription = [];

      // Seleciona automaticamente o modelo disponível
      let model;
      try {
        model = await selecionarModeloDisponivel();
      } catch (err) {
        console.error(`[JOB ${jobId}] Nenhum modelo disponível.`);
        jobs[jobId] = { status: "failed", error: "Nenhum modelo Gemini disponível." };
        return;
      }

      // --- Processa cada chunk ---
      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = `${outputDir}/${chunkFiles[i]}`;
        try {
          console.log(`[JOB ${jobId}] Transcrevendo chunk ${i + 1}/${chunkFiles.length}`);
          const audioPart = fileToGenerativePart(chunkPath, "audio/mp3");
          const prompt = "Transcreva o áudio a seguir de forma fiel, sem comentários adicionais.";

          const result = await model.generateContent([prompt, audioPart]);
          const text = result.response.text();

          fullTranscription.push(text);
          jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;
        } catch (error) {
          console.error(`[JOB ${jobId}] Erro no chunk ${i + 1}:`, error.message);
          fullTranscription.push(`[ERRO AO TRANSCRIBIR TRECHO ${i + 1}]`);
        }
      }

      // --- Finaliza o trabalho ---
      jobs[jobId] = {
        status: "completed",
        transcription: fullTranscription.join(" "),
        progress: 100,
      };

      console.log(`[JOB ${jobId}] Transcrição concluída.`);
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.unlinkSync(filePath);
    })
    .on("error", (err) => {
      console.error(`[JOB ${jobId}] FFmpeg ERRO:`, err.message);
      jobs[jobId] = { status: "failed", error: "Erro ao dividir o áudio." };
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    })
    .run();
});

// --- ENDPOINT: Consulta o status da transcrição ---
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ error: "Trabalho não encontrado." });
  res.json(job);
});

// --- Inicializa o servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
