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

    let prompt = `Com base no resumo: "${summaryText}".\nElabore uma atividade escolar no nível ${options.difficulty} seguindo as regras:\n`;

    if (options.type === "dissertativa") {
        prompt += `- Crie exatamente ${options.quantity} questões dissertativas.\n- As perguntas devem incentivar o pensamento crítico.`;
        prompt += `\n- Não inclua respostas ou gabarito no final.`;

    } else if (options.type === "objetiva") {

        // --- BLOCO ATUALIZADO PARA V/F TIPO SEQUÊNCIA ---
        if (options.questionType === "verdadeiro ou falso") {
            prompt += `- Crie EXATAMENTE ${options.quantity} questões independentes de Verdadeiro/Falso no formato de sequência.\n`;
            prompt += `- Numere cada questão principal claramente (1., 2., 3., ... ${options.quantity}.).\n`;
            prompt += `- PARA CADA UMA DESSAS ${options.quantity} QUESTÕES, faça o seguinte:\n`;
            prompt += `    1. Crie 4 afirmações curtas sobre o texto (verdadeiras ou falsas).\n`;
            prompt += `    2. Formate CADA afirmação iniciando com parênteses vazios: ( ). Exemplo: ( ) Afirmação X.\n`;
            prompt += `    3. Após as 4 afirmações, inclua EXATAMENTE a frase: "Assinale a alternativa que apresenta a sequência correta, de cima para baixo:"\n`;
            prompt += `    4. Crie 4 alternativas (A, B, C, D), cada uma contendo uma sequência de 4 V's e F's (Exemplo: A) V, F, V, F).\n`;
            prompt += `    5. APENAS UMA dessas 4 alternativas (A, B, C, D) deve conter a sequência CORRETA de V/F baseada nas 4 afirmações que você criou para ESSA questão.\n`;
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
            // A lógica de extração continua a mesma e funcionará para [B,A,D]
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


// ===================================
// 4️⃣ ENDPOINT: VERIFICADOR DE GABARITO (ENDPOINT NOVO ADICIONADO)
// ===================================
app.post("/verify-answers", 
    upload.fields([
        { name: 'teacherKey', maxCount: 1 },
        { name: 'studentSheet', maxCount: 10 } // Permite até 10 imagens
    ]), 
    async (req, res) => {
        if (!req.files || !req.files.teacherKey || !req.files.studentSheet || req.files.studentSheet.length === 0) {
            return res.status(400).json({ error: "É necessário enviar o PDF do gabarito e pelo menos uma imagem do aluno." });
        }

        const teacherKeyFile = req.files.teacherKey[0];
        const studentSheetFiles = req.files.studentSheet; 
      const generationConfig = {
                temperature: 0.1, // Valor baixo (0.0 a 1.0) para respostas mais focadas e menos aleatórias
            };

        console.log(`[JOB CORREÇÃO] Iniciado. Gabarito: ${teacherKeyFile.path}, Respostas Aluno: ${studentSheetFiles.length} imagem(ns)`);

        const tempFilePaths = [teacherKeyFile.path];
        studentSheetFiles.forEach(file => tempFilePaths.push(file.path));

        // Array para guardar os resultados individuais
        const results = [];

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const teacherKeyPart = fileToGenerativePart(teacherKeyFile.path, teacherKeyFile.mimetype);

            // <<< MUDANÇA AQUI: Loop para processar cada imagem individualmente >>>
            for (const studentFile of studentSheetFiles) {
                console.log(`[JOB CORREÇÃO] Processando imagem: ${studentFile.originalname || studentFile.filename}`);
                const studentImagePart = fileToGenerativePart(studentFile.path, studentFile.mimetype);

                // <<< MUDANÇA AQUI: Prompt focado em UMA imagem por vez >>>
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
                    // <<< MUDANÇA 3: Passando a configurationConfig para a IA >>>
                    const result = await model.generateContent(
                        [singleImagePrompt, teacherKeyPart, studentImagePart],
                        generationConfig // Adicionado aqui
                    );
                    const fullResponseText = result.response.text();
                    const scoreMatch = fullResponseText.match(/NOTA: (\d+\/\d+)/);

                    if (scoreMatch && scoreMatch[1]) {
                        console.log(`[JOB CORREÇÃO] Nota para ${studentFile.originalname || studentFile.filename}: ${scoreMatch[1]}`);
                        results.push({ 
                            fileName: studentFile.originalname || studentFile.filename, 
                            grade: scoreMatch[1] 
                        });
                    } else {
                        console.error(`[JOB CORREÇÃO] Não foi possível extrair nota para ${studentFile.originalname || studentFile.filename}:`, fullResponseText);
                        results.push({ 
                            fileName: studentFile.originalname || studentFile.filename, 
                            grade: "Erro na extração" 
                        });
                    }
                } catch (imageError) {
                     console.error(`[JOB CORREÇÃO] Erro ao processar a imagem ${studentFile.originalname || studentFile.filename}:`, imageError.message);
                     results.push({ 
                        fileName: studentFile.originalname || studentFile.filename, 
                        grade: "Erro na IA" 
                    });
                }
                 await new Promise(resolve => setTimeout(resolve, 1000)); 
            } // Fim do loop for

            console.log("[JOB CORREÇÃO] Processamento de todas as imagens concluído.");
            res.json({ individualGrades: results });

        } catch (error) {
            console.error("[JOB CORREÇÃO] Erro geral:", error.message);
            res.status(500).json({ error: "Ocorreu um erro geral ao corrigir as atividades." });
        } finally {
            // Limpa TODOS os arquivos temporários
            tempFilePaths.forEach(path => {
                try {
                    if (fs.existsSync(path)) fs.unlinkSync(path);
                } catch (err) {
                    console.error(`Erro ao limpar arquivo temporário ${path}:`, err);
                }
            });
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












