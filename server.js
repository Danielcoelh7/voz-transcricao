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

// ==========================
// BANCO DE MEMÓRIA (JOBS)
// ==========================
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
  // ... (código de transcrição inalterado) ...
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
    .outputOptions(["-f segment", "-segment_time 120", "-c copy"])
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
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: "Trabalho não encontrado." });
  }
  res.json(job);
});

// ==========================================================
// 3️⃣ ENDPOINT: GERADOR DE ATIVIDADES (Inalterado)
// ==========================================================
app.post("/generate-activity", async (req, res) => {
    // ... (código de gerar atividade inalterado) ...
    const { summaryText, options } = req.body;
    if (!summaryText || !options) {
        return res.status(400).json({ error: "Dados insuficientes para gerar a atividade." });
    }
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
         } else {
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
// 4️⃣ FUNÇÃO DE CORREÇÃO EM SEGUNDO PLANO (ATUALIZADA E CORRIGIDA)
// ==========================================================
async function corrigirProvas(jobId, studentSheetFiles, gabaritoString) {
  const job = jobs[jobId]; 
  const tempFilePaths = []; 
  studentSheetFiles.forEach(file => tempFilePaths.push(file.path));

  const generationConfig = {
      temperature: 0.1, 
  };
  const results = [];

  const gabaritoArray = gabaritoString.split(',').map(s => s.trim().toUpperCase());
  const totalQuestoes = gabaritoArray.length;
  // Cria um array de 'details' FALSOS para o caso de a prova ser invalidada
  const invalidDetails = gabaritoArray.map((_, i) => ({ "q": i + 1, "correct": false }));


  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    
    const totalImagens = studentSheetFiles.length;
    console.log(`[JOB ${jobId}] Iniciando correção de ${totalImagens} imagens com o gabarito: [${gabaritoString}]`);

    for (let i = 0; i < totalImagens; i++) {
      const studentFile = studentSheetFiles[i];
      const studentImagePart = fileToGenerativePart(studentFile.path, studentFile.mimetype);

      const percent = Math.round(((i + 1) / totalImagens) * 95); 
      job.progress = percent;
      job.message = `Processando imagem ${i + 1} de ${totalImagens}... (${studentFile.originalname})`;
      console.log(`[JOB ${jobId}] Progresso: ${percent}% - ${job.message}`);

      // ==========================================================
      // <<< MUDANÇA 1: O NOVO PROMPT (SIMPLIFICADO) >>>
      // ==========================================================
      // Pede APENAS os 'details'. A IA não é mais responsável pela 'grade'.
      const singleImagePrompt = `
        TASK: Analyze a student's answer sheet image against a provided answer key.

        INPUTS:
        1.  ANSWER KEY (string array): ["${gabaritoArray.join('","')}"]
        2.  IMAGE file: The student's filled-in answer sheet.

        INSTRUCTIONS:
        1.  **Parse Key:** The correct answers are in the ANSWER KEY array. The first item is for Q1, second for Q2, etc. Total questions = ${totalQuestoes}.
        2.  **Check Invalidation:** Look at the IMAGE. Is there a large, distinct 'X' mark in RED?
        3.  **Analyze Answers:** If NO red 'X', analyze the IMAGE to see which letter (A, B, C, D) the student marked for each question (1 to ${totalQuestoes}).
        4.  **Handle Ambiguity:** If a student marked MORE THAN ONE option, or the mark is unreadable, count as INCORRECT.
        5.  **Compare & Detail:** Compare the student's marks to the ANSWER KEY. Create a "details" list of true/false for each question.

        OUTPUT FORMAT: Respond ONLY with a single, valid JSON object. Do not add markdown or any other text.
        
        **If a RED 'X' is found (Invalidated):**
        {
          "details": ${JSON.stringify(invalidDetails)},
          "invalidated": true
        }

        **If NO red 'X' is found (Valid Test):**
        {
          "details": [
            { "q": 1, "correct": true_ou_false },
            { "q": 2, "correct": true_ou_false },
            ... (uma entrada para cada uma das ${totalQuestoes} questões)
          ],
          "invalidated": false
        }
      `;

      try {
        const result = await model.generateContent(
          [singleImagePrompt, studentImagePart],
          generationConfig
        );
        const fullResponseText = result.response.text();

        // ==========================================================
        // <<< MUDANÇA 2: A NOVA LÓGICA DE CÁLCULO >>>
        // ==========================================================
        let aiResponse;
        try {
            const cleanedText = fullResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
            aiResponse = JSON.parse(cleanedText);
        } catch (e) {
            console.error(`[JOB ${jobId}] Erro ao parsear JSON da IA para ${studentFile.originalname}:`, e.message);
            console.error("Texto recebido da IA:", fullResponseText);
            throw new Error(`A IA retornou um formato de JSON inválido para a imagem ${studentFile.originalname}.`);
        }

        // Verifica se a IA retornou os 'details'
        if (aiResponse && aiResponse.details) {
          
          // --- NOSSO CÓDIGO FAZ A LÓGICA ---
          // 1. Conta os acertos
          const correctCount = aiResponse.details.filter(d => d.correct).length;
          // 2. Cria a string da nota
          const gradeString = `${correctCount}/${totalQuestoes}`;
          // --- FIM DA LÓGICA ---

          console.log(`[JOB ${jobId}] Nota para ${studentFile.originalname}: ${gradeString}`);
          
          // Salva os dados corretos (nota calculada + detalhes da IA)
          results.push({ 
            fileName: studentFile.originalname || studentFile.filename, 
            grade: gradeString, // <-- A nossa nota (lógica)
            details: aiResponse.details // <-- Os detalhes da IA (visual)
          });

        } else {
          throw new Error(`A IA não retornou um JSON com a propriedade 'details' para a imagem ${studentFile.originalname}.`);
        }
        
      } catch (imageError) {
        console.error(`[JOB ${jobId}] Erro ao processar a imagem ${studentFile.originalname}:`, imageError.message);
        results.push({ 
          fileName: studentFile.originalname || studentFile.filename, 
          grade: `0/${totalQuestoes}`,
          details: invalidDetails // Usa os 'details' falsos
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000)); 
    } // Fim do loop for

    // --- FINALIZA O JOB COM SUCESSO ---
    console.log(`[JOB ${jobId}] Processamento de todas as imagens concluído.`);
    const finalResultsPayload = { results: results }; 
    job.status = "completed";
    job.progress = 100;
    job.message = "Correção concluída!";
    job.results = finalResultsPayload;

  } catch (error) {
    // --- FINALIZA O JOB COM FALHA ---
    console.error(`[JOB ${jobId}] Erro geral:`, error.message);
    job.status = "failed";
    job.error = error.message || "Ocorreu um erro geral ao corrigir as atividades.";
  } finally {
    // --- LIMPEZA DE ARQUIVOS ---
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
// 5️⃣ ENDPOINT: INICIAR VERIFICAÇÃO (Inalterado)
// ==========================================================
app.post("/start-verification", 
  upload.fields([
      { name: 'studentSheet', maxCount: 40 } 
  ]), 
  (req, res) => {
    
    const { gabarito } = req.body;

    if (!req.files || !req.files.studentSheet) {
      return res.status(400).json({ error: "É necessário enviar pelo menos uma imagem do aluno." });
    }
    
    if (!gabarito || gabarito.trim() === "") {
      return res.status(400).json({ error: "É necessário enviar o gabarito (ex: A,B,C)." });
    }
    
    const studentSheetFiles = Array.isArray(req.files.studentSheet) 
        ? req.files.studentSheet 
        : [req.files.studentSheet];

    if (studentSheetFiles.length === 0) {
      return res.status(400).json({ error: "Nenhuma imagem de aluno foi enviada." });
    }

    const jobId = uuidv4();

    jobs[jobId] = {
      status: "processing",
      progress: 0,
      message: "Iniciando verificação...",
      results: null
    };

    console.log(`[JOB ${jobId}] Verificação criada. Iniciando em segundo plano...`);

    corrigirProvas(jobId, studentSheetFiles, gabarito);

    res.status(202).json({ jobId: jobId });
  }
);


// ================================
// 6️⃣ INICIALIZAÇÃO DO SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
