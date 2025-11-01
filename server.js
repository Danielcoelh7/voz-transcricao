import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { v4 as uuidv4 } from "uuid"; // Você já importa o uuid, ótimo!
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

// ==========================
// Configuração do FFmpeg
// ==========================
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
// ATENÇÃO: Seu multer salva em 'uploads/'. Isso está correto.
const upload = multer({ dest: "uploads/" }); 
app.use(cors());
app.use(express.json())

// ==========================
// Configuração da API Gemini
// ==========================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ==========================
// BANCO DE MEMÓRIA (JOBS)
// ==========================
// Este objeto ÚNICO controlará TUDO (transcrição E verificação)
const jobs = {};

// ==========================
// Função auxiliar: fileToGenerativePart (Inalterada)
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
// Função: selecionarModeloDisponivel (Inalterada)
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

// ==========================================================
// 1️⃣ ENDPOINT DE TRANSCRIÇÃO (Inalterado)
// ==========================================================
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

  res.status(202).json({ jobId });

  jobs[jobId] = { status: "splitting", progress: 0 };

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
      const model = await selecionarModeloDisponivel();

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

          await new Promise(res => setTimeout(res, 2000));
        } catch (error) {
          console.error(`[JOB ${jobId}] Erro no chunk ${i + 1}:`, error.message);
          fullTranscription.push(`[ERRO NA TRANSCRIÇÃO DO TRECHO ${i + 1}]`);
        }
      }

      console.log(`[JOB ${jobId}] Transcrição completa.`);
      const fullText = fullTranscription.join(" ");
      
      console.log(`[JOB ${jobId}] Formatando perguntas...`);
      const regex = /(pergunta)(\s+)(.*?)(\s+)(ponto)/gi;
      const replacement = '$1$2($3)$4$5';
      const formattedText = fullText.replace(regex, replacement);

      try {
        jobs[jobId].status = "summarizing";
        console.log(`[JOB ${jobId}] Gerando resumo em tópicos...`);

        const summaryPrompt = `
        Gere um resumo **em tópicos** (marcados com "•") a partir do texto abaixo.
        O resumo deve conter as ideias principais, sem repetir frases.
        Não diga que precisa do texto, apenas gere o resumo.
        
        Texto:
        """${formattedText}""" 
        `;

        const summaryModel = await selecionarModeloDisponivel();
        const summaryResult = await summaryModel.generateContent(summaryPrompt);
        const summaryText = summaryResult.response.text();

        jobs[jobId] = {
          status: "completed",
          transcription: formattedText,
          summary: summaryText,
          progress: 100,
        };

        console.log(`[JOB ${jobId}] Resumo gerado com sucesso.`);
      } catch (error) {
        console.error(`[JOB ${jobId}] Erro ao gerar resumo:`, error);
        jobs[jobId] = {
          status: "completed",
          transcription: formattedText,
          summary: "[Erro ao gerar resumo automático]",
          progress: 100,
        };
      }

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

// ==========================================================
// 2️⃣ ENDPOINT DE STATUS (Inalterado e Universal)
// ==========================================================
// Este endpoint serve para a Transcrição E para a Verificação
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: "Trabalho não encontrado." });
  }

  // Retorna o status atual do job, seja ele qual for
  res.json(job);
});

// ==========================================================
// 3️⃣ ENDPOINT: GERADOR DE ATIVIDADES (Inalterado)
// ==========================================================
app.post("/generate-activity", async (req, res) => {
    const { summaryText, options } = req.body;

    if (!summaryText || !options) {
        return res.status(400).json({ error: "Dados insuficientes para gerar a atividade." });
    }

    // ... (toda a sua lógica de prompt de atividade permanece a mesma) ...
    let prompt = `Com base no resumo: "${summaryText}".\nElabore uma atividade escolar no nível ${options.difficulty} seguindo as regras:\n`;
    if (options.type === "dissertativa") {
         prompt += `- Crie exatamente ${options.quantity} questões dissertativas.\n- As perguntas devem incentivar o pensamento crítico.`;
         prompt += `\n- Não inclua respostas ou gabarito no final.`;
     } else if (options.type === "objetiva") {
         if (options.questionType === "verdadeiro ou falso") {
             prompt += `- Crie EXATAMENTE ${options.quantity} questões independentes de Verdadeiro/Falso no formato de sequência.\n`;
             prompt += `- Numere cada questão principal claramente (1., 2., 3., ... ${options.quantity}.).\n`;
             prompt += `- PARA CADA UMA DESSAS ${options.quantity} QUESTÕES, faça o seguinte:\n`;
             prompt += `    1. Crie 4 afirmações curtas sobre o texto (verdadeiras ou falsas).\n`;
             prompt += `    2. Formate CADA afirmação iniciando com parênteses vazios: ( ). Exemplo: ( ) Afirmação X.\n`;
             prompt += `    3. Após as 4 afirmações, inclua EXATAMENTE a frase: "Assinale a alternativa que apresenta a sequência correta, de cima para baixo:"\n`;
             prompt += `    4. Crie 4 alternativas (A, B, C, D), cada uma contendo uma sequência de 4 V's e F's (Exemplo: A) V, F, V, F).\n`;
             prompt += `    5. APENAS UMA dessas 4 alternativas (A, B, C, D) deve conter a sequência CORRETA de V/F baseada nas 4 afirmações que você criou para ESSA questão.\n`;
             prompt += `- **IMPORTANTE: No final de TODO o texto da atividade (após a ${options.quantity}ª questão), adicione as respostas corretas (APENAS a letra da alternativa correta para CADA questão principal), em sequência, em uma linha separada, formatada EXATAMENTE assim: GABARITO:[LetraQ1,LetraQ2,...LetraQ${options.quantity}] (Exemplo para 3 questões: GABARITO:[B,A,D])**\n`;
         } else { // Para outros tipos de questões objetivas
             prompt += `- Tipo de questão: "${options.questionType}".\n`;
             prompt += `- Quantidade: Crie exatamente ${options.quantity} questões.\n`;
             prompt += `- Numere cada questão claramente (1., 2., 3., ...).\n`;
             prompt += `- Se o tipo for "múltipla escolha", forneça 4 alternativas (A, B, C, D) para cada questão.\n`;
             prompt += `- **IMPORTANTE: No final de TUDO, adicione as respostas corretas em uma linha separada, formatada EXATAMENTE assim: GABARITO:[A,B,D,C,...] (uma letra para cada questão)**\n`;
         }
     }

    console.log(`[JOB ATIVIDADE] Gerando atividade do tipo "${options.type}" (${options.questionType || ''})...`);

    try {
        const model = await selecionarModeloDisponivel();
        const result = await model.generateContent(prompt);
        const fullResponseText = result.response.text();

        let activityText = fullResponseText;
        let answers = []; 

        const gabaritoMatch = fullResponseText.match(/GABARITO:\[(.*?)\]/i);

        if (gabaritoMatch && gabaritoMatch[1]) {
            activityText = fullResponseText.replace(/GABARITO:\[(.*?)\]/i, "").trim();
            answers = gabaritoMatch[1].split(',').map(ans => ans.trim().toUpperCase()); 
            console.log(`[JOB ATIVIDADE] Gabarito extraído com sucesso:`, answers);
        } else {
            if (options.type === "objetiva") {
               console.warn("[JOB ATIVIDADE] Aviso: O formato do gabarito não foi encontrado na resposta da IA para questão objetiva.");
            } else {
               console.log("[JOB ATIVIDADE] Atividade dissertativa gerada sem gabarito (esperado).");
            }
        }
        res.json({ activityText, answers });

    } catch (error) {
        console.error("[JOB ATIVIDADE] Erro:", error.message);
        res.status(500).json({ error: "Ocorreu um erro na IA ao gerar a atividade." });
    }
});


// ==========================================================
// 4️⃣ FUNÇÃO DE CORREÇÃO EM SEGUNDO PLANO (NOVA)
// ==========================================================
/**
 * Esta função roda em segundo plano para corrigir as provas.
 * Ela atualiza o objeto 'jobs' global com o progresso.
 */
async function corrigirProvas(jobId, teacherKeyFile, studentSheetFiles) {
  const job = jobs[jobId]; // Pega a referência do job
  const tempFilePaths = [teacherKeyFile.path];
  studentSheetFiles.forEach(file => tempFilePaths.push(file.path));

  const generationConfig = {
      temperature: 0.1, // Sua config de temperatura
  };

  const results = []; // Array para guardar os resultados

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Seu modelo específico
    const teacherKeyPart = fileToGenerativePart(teacherKeyFile.path, teacherKeyFile.mimetype);
    
    const totalImagens = studentSheetFiles.length;
    console.log(`[JOB ${jobId}] Iniciando correção de ${totalImagens} imagens.`);

    // Loop para processar cada imagem
    for (let i = 0; i < totalImagens; i++) {
      const studentFile = studentSheetFiles[i];
      const studentImagePart = fileToGenerativePart(studentFile.path, studentFile.mimetype);

      // --- ATUALIZA O PROGRESSO ---
      const percent = Math.round(((i + 1) / totalImagens) * 95); // Vai até 95%
      job.progress = percent;
      job.message = `Processando imagem ${i + 1} de ${totalImagens}... (${studentFile.originalname})`;
      console.log(`[JOB ${jobId}] Progresso: ${percent}% - ${job.message}`);

      // Seu prompt de correção
      const singleImagePrompt = `
        TASK: Correct a student's answer sheet image based on an official answer key PDF, checking for an invalidation mark.
        INPUTS:
        1. PDF file: Contains the questions, alternatives, and possibly a blank answer sheet section. THIS IS THE SOURCE OF TRUTH FOR THE CORRECT ANSWERS.
        2. IMAGE file: A photo of the student's filled-in answer sheet (using 'X', scribbles, or filled circles). This image might contain a large red 'X' mark indicating the test is invalidated.
        INSTRUCTIONS (Follow these steps precisely):
        1.  **DEDUCE THE CORRECT ANSWER KEY:** Carefully read ONLY the questions and their multiple-choice options (A, B, C, D) within the PDF file. Determine the correct letter answer for each question number. **CRITICAL: IGNORE ANY SECTION TITLED "Folha de Respostas" or similar within the PDF.** Create the definitive answer key internally (e.g., 1-B, 2-D, 3-C...). Let 'Y' be the total number of questions found.
        2.  **CHECK FOR INVALIDATION MARK:** Look CAREFULLY at the provided IMAGE file. Is there a large, distinct 'X' mark drawn in RED anywhere on the sheet?
        3.  **OUTPUT IF INVALIDATED:** If you found a prominent RED 'X' mark in step 2, **STOP** immediately and output ONLY 'NOTA: 0/Y' (using the 'Y' from step 1). Do not proceed further.
        4.  **ANALYZE STUDENT'S ANSWERS (if NO red 'X' was found):** If no red 'X' was present, analyze the IMAGE file. Identify precisely which single letter (A, B, C, or D) the student attempted to mark for each question number. Markings can be 'X', scribbles, or filled circles.
        5.  **HANDLE AMBIGUITY/MULTIPLE MARKS:** If a student marked MORE THAN ONE option for a single question, or if the marking is completely unreadable/ambiguous, count that question as INCORRECT.
        6.  **COMPARE AND COUNT (if NO red 'X' was found):** Compare the student's valid marked answers (from step 4 & 5) against the correct answer key (from step 1). Count only the questions where the student marked the single, correct letter. Let 'X' be this count.
        7.  **OUTPUT FORMAT (if NO red 'X' was found):** Respond ONLY with the final score for THIS IMAGE in the strict format 'NOTA: X/Y', using the 'X' from step 6 and 'Y' from step 1. Example: NOTA: 3/5
      `;

      try {
        const result = await model.generateContent(
          [singleImagePrompt, teacherKeyPart, studentImagePart],
          generationConfig
        );
        const fullResponseText = result.response.text();
        const scoreMatch = fullResponseText.match(/NOTA: (\d+\/\d+)/);

        if (scoreMatch && scoreMatch[1]) {
          console.log(`[JOB ${jobId}] Nota para ${studentFile.originalname}: ${scoreMatch[1]}`);
          results.push({ 
            fileName: studentFile.originalname || studentFile.filename, 
            grade: scoreMatch[1],
            // Você precisa que sua IA retorne os detalhes
            // Por enquanto, vamos simular
            details: [
                { q: 1, correct: Math.random() > 0.5 },
                { q: 2, correct: Math.random() > 0.5 },
                { q: 3, correct: Math.random() > 0.5 }
            ]
          });
        } else {
          console.error(`[JOB ${jobId}] Não foi possível extrair nota para ${studentFile.originalname}:`, fullResponseText);
          results.push({ 
            fileName: studentFile.originalname || studentFile.filename, 
            grade: "Erro na extração",
            details: []
          });
        }
      } catch (imageError) {
        console.error(`[JOB ${jobId}] Erro ao processar a imagem ${studentFile.originalname}:`, imageError.message);
        results.push({ 
          fileName: studentFile.originalname || studentFile.filename, 
          grade: "Erro na IA",
          details: []
        });
      }
      
      // Seu delay para evitar sobrecarga
      await new Promise(resolve => setTimeout(resolve, 1000)); 
    } // Fim do loop for

    // --- FINALIZA O JOB COM SUCESSO ---
    console.log(`[JOB ${jobId}] Processamento de todas as imagens concluído.`);
    
    const finalResultsPayload = { results: results }; // O frontend espera por "results"
    
    job.status = "completed";
    job.progress = 100;
    job.message = "Correção concluída!";
    job.results = finalResultsPayload; // ADICIONA O RESULTADO FINAL AO JOB

  } catch (error) {
    // --- FINALIZA O JOB COM FALHA ---
    console.error(`[JOB ${jobId}] Erro geral:`, error.message);
    job.status = "failed";
    job.error = error.message || "Ocorreu um erro geral ao corrigir as atividades.";
  } finally {
    // --- LIMPEZA DE ARQUIVOS (SEMPRE ACONTECE) ---
    console.log(`[JOB ${jobId}] Limpando arquivos temporários...`);
    tempFilePaths.forEach(path => {
      try {
        if (fs.existsSync(path)) fs.unlinkSync(path);
      } catch (err) {
        console.error(`Erro ao limpar arquivo temporário ${path}:`, err);
      }
    });
    console.log(`[JOB ${jobId}] Limpeza concluída.`);
  }
}

// ==========================================================
// 5️⃣ ENDPOINT: INICIAR VERIFICAÇÃO (NOVO)
// ==========================================================
app.post("/start-verification", 
  upload.fields([
      { name: 'teacherKey', maxCount: 1 },
      { name: 'studentSheet', maxCount: 40 } // Seu limite
  ]), 
  (req, res) => {
    
    if (!req.files || !req.files.teacherKey || !req.files.studentSheet || req.files.studentSheet.length === 0) {
      return res.status(400).json({ error: "É necessário enviar o PDF do gabarito e pelo menos uma imagem do aluno." });
    }

    const teacherKeyFile = req.files.teacherKey[0];
    const studentSheetFiles = req.files.studentSheet; 

    // 1. Gera um ID único
    const jobId = uuidv4();

    // 2. Cria o job inicial no banco de memória
    jobs[jobId] = {
      status: "processing",
      progress: 0,
      message: "Iniciando verificação...",
      results: null
    };

    console.log(`[JOB ${jobId}] Verificação criada. Iniciando em segundo plano...`);

    // 3. Chama a função pesada SEM 'await'
    corrigirProvas(jobId, teacherKeyFile, studentSheetFiles);

    // 4. Responde ao frontend IMEDIATAMENTE
    res.status(202).json({ jobId: jobId });
  }
);


// ================================
// 6️⃣ INICIALIZAÇÃO DO SERVIDOR (Renumerado)
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
