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
// Função: selecionar modelo disponível automaticamente (A SUA VERSÃO)
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
// 1️⃣ ENDPOINT DE TRANSCRIÇÃO (ATUALIZADO com formatação de pergunta)
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

      // --- INÍCIO DA ADIÇÃO: LÓGICA DE FORMATAÇÃO DE PERGUNTA ---
      console.log(`[JOB ${jobId}] Formatando perguntas...`);
      const regex = /(pergunta)(\s+)(.*?)(\s+)(ponto)/gi;
      const replacement = '$1$2($3)$4$5';
      const formattedText = fullText.replace(regex, replacement);
      // --- FIM DA ADIÇÃO ---


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
        """${formattedText}""" 
        `; // <--- MODIFICADO: usa formattedText

        const summaryModel = await selecionarModeloDisponivel();
        const summaryResult = await summaryModel.generateContent(summaryPrompt);
        const summaryText = summaryResult.response.text();

        jobs[jobId] = {
          status: "completed",
          transcription: formattedText, // <--- MODIFICADO: usa formattedText
          summary: summaryText,
          progress: 100,
        };

        console.log(`[JOB ${jobId}] Resumo gerado com sucesso.`);
      } catch (error) {
        console.error(`[JOB ${jobId}] Erro ao gerar resumo:`, error);
        jobs[jobId] = {
          status: "completed",
          transcription: formattedText, // <--- MODIFICADO: usa formattedText
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
// 3️⃣ ENDPOINT: GERADOR DE ATIVIDADES (O SEU CÓDIGO)
// ===================================
app.post("/generate-activity", async (req, res) => {
    const { summaryText, options } = req.body;

    if (!summaryText || !options) {
        return res.status(400).json({ error: "Dados insuficientes para gerar a atividade." });
    }

    // --- PASSO 1: CONSTRUÇÃO DO PROMPT ATUALIZADO ---
    // O prompt agora pede o gabarito em um formato específico.
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

        // --- PASSO 2: EXTRAÇÃO DO GABARITO ---
        let activityText = fullResponseText;
        let answers = [];

        // Regex para encontrar o gabarito no texto. O 'i' no final torna a busca insensível a maiúsculas/minúsculas.
        const gabaritoMatch = fullResponseText.match(/GABARITO:\[(.*?)\]/i);

        // Se encontrou o padrão "GABARITO:[...]"
        if (gabaritoMatch && gabaritoMatch[1]) {
            // Remove a linha do gabarito do texto principal da atividade
            activityText = fullResponseText.replace(/GABARITO:\[(.*?)\]/i, "").trim();
            
            // Extrai as letras, remove espaços em branco e as coloca em um array
            answers = gabaritoMatch[1].split(',').map(ans => ans.trim().toUpperCase());
            console.log(`[JOB ATIVIDADE] Gabarito extraído com sucesso:`, answers);
        } else {
            console.warn("[JOB ATIVIDADE] Aviso: O formato do gabarito não foi encontrado na resposta da IA.");
        }

        // --- PASSO 3: ENVIAR OS DOIS DADOS PARA O FRONTEND ---
        res.json({ activityText, answers });

    } catch (error) {
        console.error("[JOB ATIVIDADE] Erro:", error.message);
        res.status(500).json({ error: "Ocorreu um erro na IA ao gerar a atividade." });
    }
});


// ===================================
// 4️⃣ ENDPOINT: VERIFICADOR DE GABARITO (ENDPOINT NOVO ADICIONADO)
// ===================================
app.post("/verify-answers", 
    upload.fields([
        { name: 'teacherKey', maxCount: 1 },
        { name: 'studentSheet', maxCount: 1 }
    ]), 
    async (req, res) => {
        // Verifica se os arquivos foram enviados
        if (!req.files || !req.files.teacherKey || !req.files.studentSheet) {
            return res.status(400).json({ error: "É necessário enviar os dois arquivos: o gabarito e a foto." });
        }

        const teacherKeyFile = req.files.teacherKey[0];
        const studentSheetFile = req.files.studentSheet[0];

        console.log(`[JOB CORREÇÃO] Iniciado. Gabarito: ${teacherKeyFile.path}, Resposta Aluno: ${studentSheetFile.path}`);

        try {
            // Seleciona um modelo que suporte multimodalidade (texto e imagem)
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

            // Prepara os arquivos para a IA
            const teacherKeyPart = fileToGenerativePart(teacherKeyFile.path, teacherKeyFile.mimetype);
            const studentImagePart = fileToGenerativePart(studentSheetFile.path, studentSheetFile.mimetype);

            // Cria o prompt para a IA
            const prompt = `
                Sua tarefa é ser um professor corrigindo uma prova. Eu lhe forneci dois arquivos:
                1. O gabarito oficial em PDF.
                2. Uma imagem da folha de respostas preenchida pelo aluno.

                Analise a imagem da folha do aluno e compare as respostas marcadas com o gabarito oficial. Conte o número de acertos.

                Sua resposta final deve ser APENAS a nota no formato exato 'NOTA: X/Y', onde X é o número de acertos e Y é o número total de questões no gabarito. Não adicione nenhum outro texto ou explicação.
            `;

            const result = await model.generateContent([prompt, teacherKeyPart, studentImagePart]);
            const fullResponseText = result.response.text();

            // Extrai a nota da resposta da IA
            const scoreMatch = fullResponseText.match(/NOTA: (\d+\/\d+)/);

            if (scoreMatch && scoreMatch[1]) {
                console.log(`[JOB CORREÇÃO] Nota encontrada: ${scoreMatch[1]}`);
                res.json({ grade: scoreMatch[1] });
            } else {
                console.error("[JOB CORREÇÃO] Não foi possível extrair a nota da resposta da IA:", fullResponseText);
                res.status(500).json({ error: "Não consegui extrair a nota. A resposta da IA foi inesperada." });
            }

        } catch (error) {
            console.error("[JOB CORREÇÃO] Erro:", error.message);
            res.status(500).json({ error: "Ocorreu um erro na IA ao corrigir a atividade." });
        } finally {
            // Limpa os arquivos temporários após a conclusão
            fs.unlinkSync(teacherKeyFile.path);
            fs.unlinkSync(studentSheetFile.path);
            console.log(`[JOB CORREÇÃO] Arquivos temporários removidos.`);
        }
    }
);


// ================================
// 5️⃣ INICIALIZAÇÃO DO SERVIDOR (Renumerado)
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});

