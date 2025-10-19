import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

// ==========================
// Configuração do FFmpeg
// ==========================
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json())

// ==========================
// Configuração da API Gemini
// ==========================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Banco em memória para controlar os jobs
const jobs = {};

// ==========================
// Função auxiliar: converte arquivo em formato aceito pelo Gemini
// ==========================
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType,
    },
  };
}

// ==========================
// Função: selecionar modelo disponível automaticamente
// ==========================
async function selecionarModeloDisponivel() {
  const modelosPreferidos = [
    "gemini-2.0-flash",
    "gemini-2.0-pro",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ];

  for (const nomeModelo of modelosPreferidos) {
    try {
      console.log(`[INFO] Testando modelo: ${nomeModelo}...`);
      const model = genAI.getGenerativeModel({ model: nomeModelo });

      // Teste rápido de disponibilidade
      const result = await model.generateContent("Teste de disponibilidade do modelo.");
      if (result?.response) {
        console.log(`[SUCESSO] Modelo disponível: ${nomeModelo}`);
        return model;
      }
    } catch (err) {
      const code = err?.status || err?.statusCode || err?.code;
      console.warn(`[ERRO] Modelo ${nomeModelo} falhou (${code || err.message}). Tentando o próximo...`);
      if (code === 429 || code === 503) continue;
    }
  }

  throw new Error("Nenhum modelo Gemini disponível no momento.");
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
    .on("end", async () => {
      console.log(`[JOB ${jobId}] Divisão concluída.`);

      jobs[jobId].status = "processing";
      const chunkFiles = fs.readdirSync(outputDir).sort();
      console.log(`[JOB ${jobId}] ${chunkFiles.length} partes encontradas.`);

      let fullTranscription = [];

      // Seleciona modelo disponível (fallback automático)
      const model = await selecionarModeloDisponivel();

      // =========================================
      // PROCESSAMENTO DE CADA CHUNK (TRANSCRIÇÃO)
      // =========================================
      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = `${outputDir}/${chunkFiles[i]}`;
        try {
          console.log(`[JOB ${jobId}] Transcrevendo ${chunkFiles[i]}...`);

          const audioPart = fileToGenerativePart(chunkPath, "audio/mp3");
          const prompt = "Transcreva o áudio a seguir na íntegra, sem comentários.";

          const result = await model.generateContent([prompt, audioPart]);
          const text = result.response.text();

          fullTranscription.push(text);
          jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;

          // Aguarda 2 segundos entre os chunks (evita sobrecarga 503)
          await new Promise(res => setTimeout(res, 2000));
        } catch (error) {
          console.error(`[JOB ${jobId}] Erro no chunk ${i + 1}:`, error.message);
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
  Gere um resumo **em tópicos** (marcados com "•") a partir do texto abaixo.
  O resumo deve conter as ideias principais, sem repetir frases.
  Não diga que precisa do texto, apenas gere o resumo.
  
  Texto:
  """${fullText}"""
  `;

  const summaryModel = await selecionarModeloDisponivel();
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
    .on("error", (err) => {
      console.error(`[JOB ${jobId}] [FFmpeg] ERRO:`, err.message);
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

// ===================================
// 3️⃣ ENDPOINT: GERADOR DE ATIVIDADES
// ===================================
app.post("/generate-activity", async (req, res) => {
    const { summaryText, options } = req.body;

    if (!summaryText || !options) {
        return res.status(400).json({ error: "Dados insuficientes para gerar a atividade." });
    }

    let prompt = `Com base nos seguintes tópicos de um resumo:\n"""\n${summaryText}\n"""\n\nElabore uma atividade escolar seguindo RIGOROSAMENTE as seguintes regras:`;

    if (options.type === "dissertativa") {
        prompt += `\n- Crie 5 questões dissertativas que explorem os conceitos apresentados.\n- As perguntas devem incentivar o pensamento crítico e a reflexão sobre os tópicos.`;
    } else if (options.type === "objetiva") {
        prompt += `\n- Tipo de questão: "${options.questionType}".\n- Nível de dificuldade: "${options.difficulty}".\n- Quantidade: Crie exatamente ${options.quantity} questões.\n- Numere cada questão claramente (1., 2., 3., ...).\n- Se o tipo for "múltipla escolha", forneça 4 alternativas (A, B, C, D).\n- No final de TUDO, adicione uma seção chamada "GABARITO" com as respostas corretas.`;
    }

    console.log(`[JOB ATIVIDADE] Gerando atividade do tipo "${options.type}"...`);

    try {
        const model = await selecionarModeloDisponivel();
        const result = await model.generateContent(prompt);
        const activityText = result.response.text();
        res.json({ activityText });
    } catch (error) {
        console.error("[JOB ATIVIDADE] Erro:", error.message);
        res.status(500).json({ error: "Ocorreu um erro na IA ao gerar a atividade." });
    }
});




// ================================
// 4 INICIALIZAÇÃO DO SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});


