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
// ATENÇÃO: Carregue suas variáveis de ambiente antes de iniciar o servidor
// Ex: require('dotenv').config();
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
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ];

  for (const nomeModelo of modelosPreferidos) {
    try {
      console.log(`[INFO] Testando modelo: ${nomeModelo}...`);
      const model = genAI.getGenerativeModel({ model: nomeModelo });
      const result = await model.generateContent("Teste");
      if (result?.response) {
        console.log(`[SUCESSO] Modelo disponível: ${nomeModelo}`);
        return model;
      }
    } catch (err) {
      console.warn(`[AVISO] Modelo ${nomeModelo} falhou. Tentando o próximo...`);
    }
  }

  throw new Error("Nenhum modelo Gemini disponível no momento.");
}

// ================================
// 1️⃣ ENDPOINT DE TRANSCRIÇÃO
// ================================
app.post("/transcribe-chunked", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
  }

  const jobId = uuidv4();
  const filePath = req.file.path;
  const outputDir = `uploads/${jobId}`;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  res.status(202).json({ jobId });

  jobs[jobId] = { status: "splitting", progress: 0 };

  ffmpeg(filePath)
    .outputOptions(["-f segment", "-segment_time 120", "-c copy"])
    .output(`${outputDir}/chunk_%03d.mp3`)
    .on("end", async () => {
      jobs[jobId].status = "processing";
      const chunkFiles = fs.readdirSync(outputDir).sort();
      let fullTranscription = [];
      const model = await selecionarModeloDisponivel();

      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = `${outputDir}/${chunkFiles[i]}`;
        try {
          const audioPart = fileToGenerativePart(chunkPath, "audio/mp3");
          const prompt = "Transcreva o áudio a seguir na íntegra.";
          const result = await model.generateContent([prompt, audioPart]);
          fullTranscription.push(result.response.text());
          jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;
          await new Promise(res => setTimeout(res, 1500));
        } catch (error) {
          console.error(`[JOB ${jobId}] Erro no chunk ${i + 1}:`, error.message);
          fullTranscription.push(`[ERRO NA TRANSCRIÇÃO]`);
        }
      }

      const fullText = fullTranscription.join(" ");
      try {
        jobs[jobId].status = "summarizing";
        const summaryPrompt = `Gere um resumo em tópicos (marcados com "•") a partir do texto: """${fullText}"""`;
        const summaryModel = await selecionarModeloDisponivel();
        const summaryResult = await summaryModel.generateContent(summaryPrompt);
        jobs[jobId] = {
          status: "completed",
          transcription: fullText,
          summary: summaryResult.response.text(),
          progress: 100,
        };
      } catch (error) {
        jobs[jobId] = {
          status: "completed",
          transcription: fullText,
          summary: "[Erro ao gerar resumo]",
          progress: 100,
        };
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.unlinkSync(filePath);
    })
    .on("error", (err) => {
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
// 3️⃣ ENDPOINT: GERADOR DE ATIVIDADES (MODIFICADO)
// ===================================
app.post("/generate-activity", async (req, res) => {
    const { summaryText, options } = req.body;

    if (!summaryText || !options) {
        return res.status(400).json({ error: "Dados insuficientes para gerar a atividade." });
    }

    // --- CONSTRUÇÃO DO PROMPT DINÂMICO ---
    let prompt = `Com base no resumo: "${summaryText}".\nElabore uma atividade escolar seguindo as regras:\n`;

    if (options.type === "dissertativa") {
        prompt += `- Crie exatamente ${options.quantity} questões dissertativas no nível ${options.difficulty}.\n- As perguntas devem incentivar o pensamento crítico.`;
    } else if (options.type === "objetiva") {
        prompt += `- Tipo de questão: "${options.questionType}".\n- Nível de dificuldade: "${options.difficulty}".\n- Quantidade: Crie exatamente ${options.quantity} questões.\n- Se for múltipla escolha, forneça 4 alternativas (A, B, C, D).\n- **IMPORTANTE: No final de TUDO, adicione as respostas em uma linha separada, formatada EXATAMENTE assim: GABARITO:[A,B,D,C,...]**`;
    }

    console.log(`[JOB ATIVIDADE] Gerando atividade do tipo "${options.type}"...`);

    try {
        const model = await selecionarModeloDisponivel();
        const result = await model.generateContent(prompt);
        const fullResponseText = result.response.text();

        // --- EXTRAÇÃO DO GABARITO ---
        let activityText = fullResponseText;
        let answers = [];

        // Regex para encontrar o gabarito no texto. Case-insensitive.
        const gabaritoMatch = fullResponseText.match(/GABARITO:\[(.*?)\]/i);

        if (gabaritoMatch && gabaritoMatch[1]) {
            // Remove a linha do gabarito do texto principal da atividade
            activityText = fullResponseText.replace(/GABARITO:\[(.*?)\]/i, "").trim();
            // Extrai as letras, remove espaços e as coloca em um array
            answers = gabaritoMatch[1].split(',').map(ans => ans.trim().toUpperCase());
            console.log(`[JOB ATIVIDADE] Gabarito extraído:`, answers);
        } else {
            console.warn("[JOB ATIVIDADE] Aviso: Gabarito não encontrado na resposta da IA.");
        }

        // Envia ambos para o frontend
        res.json({ activityText, answers });

    } catch (error) {
        console.error("[JOB ATIVIDADE] Erro:", error.message);
        res.status(500).json({ error: "Ocorreu um erro na IA ao gerar a atividade." });
    }
});


// ================================
// 4️⃣ INICIALIZAÇÃO DO SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
