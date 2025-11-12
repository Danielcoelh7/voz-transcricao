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
app.use(express.json()); // Middleware para JSON

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
// Função auxiliar: fileToGenerativePart
// ==========================
function fileToGenerativePart(path, mimeType) {
  try {
    return {
      inlineData: {
        data: Buffer.from(fs.readFileSync(path)).toString("base64"),
        mimeType,
      },
    };
  } catch (e) {
    console.error(`Erro ao ler arquivo ${path}: ${e.message}`);
    if (e.code === 'ENOENT') {
      return null; 
    }
    throw new Error(`Erro ao ler arquivo: ${path}`);
  }
}

// ==========================
// Função: getModel (Usa o modelo que funciona)
// ==========================
function getModel() {
    try {
        // Usando o modelo que sabemos que sua chave API suporta
        return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    } catch (err) {
        console.error("[ERRO FATAL] Não foi possível carregar o modelo 'gemini-2.0-flash'.", err.message);
        throw new Error("Não foi possível carregar o modelo de IA.");
    }
}


// ==========================================================
// 1️⃣ ENDPOINT DE TRANSCRIÇÃO (Atualizado)
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

  // DEPOIS (O CÓDIGO NOVO E CORRETO)
  ffmpeg(filePath)
    .outputOptions([
      "-f segment",         // 1. Diga que é para segmentar (dividir)
      "-segment_time 120",    // 2. Divida a cada 120 segundos
      "-acodec libmp3lame",   // 3. CONVERTA o áudio para o codec MP3 (essencial)
      "-ab 128k",             // 4. Defina o bitrate (128k é ótimo para voz)
      "-ar 44100"             // 5. Defina a taxa de amostragem (padrão)
    ])
    .output(`${outputDir}/chunk_%03d.mp3`) // 6. Salve os pedaços como .mp3
    .on("end", async () => {
    // 
      console.log(`[JOB ${jobId}] Divisão concluída.`);
      jobs[jobId].status = "processing";
      const chunkFiles = fs.readdirSync(outputDir).sort();
      console.log(`[JOB ${jobId}] ${chunkFiles.length} partes encontradas.`);

      let fullTranscription = [];
      let model;
      try {
        model = getModel();
      } catch (modelError) {
        console.error(`[JOB ${jobId}] Falha fatal:`, modelError.message);
        jobs[jobId] = { status: "failed", error: modelError.message };
        return; 
      }

      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = `${outputDir}/${chunkFiles[i]}`;
        try {
          console.log(`[JOB ${jobId}] Transcrevendo ${chunkFiles[i]}...`);
          const audioPart = fileToGenerativePart(chunkPath, "audio/mp3");
          if (!audioPart) continue; 
          
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
        const summaryModel = getModel();
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
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
        fs.unlinkSync(filePath);
      } catch(e) { console.error(`[JOB ${jobId}] Erro ao limpar arquivos: ${e.message}`); }
    })
    .on("error", (err) => {
      console.error(`[JOB ${jobId}] [FFmpeg] ERRO:`, err.message);
      jobs[jobId] = { status: "failed", error: "Erro ao dividir o áudio." };
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
      } catch(e) { console.error(`[JOB ${jobId}] Erro ao limpar arquivos pós-falha: ${e.message}`); }
    })
    .run();
});

// ==========================================================
// 2️⃣ ENDPOINT DE STATUS (Universal)
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
// 3️⃣ ENDPOINT: GERADOR DE ATIVIDADES
// ==========================================================
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
        const model = getModel();
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
// 4️⃣ FUNÇÃO DE CORREÇÃO (MÚLTIPLA ESCOLHA) (Gabarito em Texto)
// ==========================================================
async function corrigirProvas(jobId, studentSheetFiles, gabaritoString) {
  const job = jobs[jobId]; 
  const tempFilePaths = []; 
  studentSheetFiles.forEach(file => tempFilePaths.push(file.path));
  const generationConfig = { temperature: 0.1 };
  const results = [];

  const gabaritoArray = gabaritoString.split(',').map(s => s.trim().toUpperCase());
  const totalQuestoes = gabaritoArray.length;
  const invalidDetails = gabaritoArray.map((_, i) => ({ "q": i + 1, "correct": false }));

  try {
    const model = getModel(); // Usa o modelo flash
    
    const totalImagens = studentSheetFiles.length;
    console.log(`[JOB ${jobId}] Iniciando correção de ${totalImagens} imagens com o gabarito: [${gabaritoString}]`);

    for (let i = 0; i < totalImagens; i++) {
      const studentFile = studentSheetFiles[i];
      const studentImagePart = fileToGenerativePart(studentFile.path, studentFile.mimetype);
      if (!studentImagePart) continue;

      const percent = Math.round(((i + 1) / totalImagens) * 95); 
      job.progress = percent;
      job.message = `Processando imagem ${i + 1} de ${totalImagens}... (${studentFile.originalname})`;
      console.log(`[JOB ${jobId}] Progresso: ${percent}% - ${job.message}`);

      // ESTE É O PROMPT CORRETO (MEIO-TERMO)
      const singleImagePrompt = `
       VOCÊ É UM SISTEMA DE CORREÇÃO AUTOMÁTICA DE PROVAS.

**GABARITO OFICIAL:**
${gabaritoArray.map((letra, idx) => `Questão ${idx + 1}: ${letra}`).join('\n')}

**SUA TAREFA:**
1. Olhe a IMAGEM da prova do aluno com MUITA ATENÇÃO
2. Para CADA questão (de 1 até ${totalQuestoes}), identifique qual alternativa o aluno marcou
3. Uma marcação válida é: um X, um círculo preenchido, ou qualquer marca clara em UMA alternativa
4. Se o aluno marcou MAIS DE UMA alternativa na mesma questão = ERRADO
5. Se não há marca legível = ERRADO
6. Se há um grande X VERMELHO na prova inteira = prova ANULADA

**IMPORTANTE:**
- Procure por marcações em CANETA, LÁPIS ou qualquer forma de preenchimento
- Mesmo que a marcação seja leve ou pequena, se estiver APENAS em uma alternativa, considere
- Compare a alternativa marcada pelo aluno com o gabarito oficial acima

**VERIFICAÇÃO DE ANULAÇÃO:**
Existe um grande X vermelho atravessando TODA a prova? (SIM ou NÃO)

**FORMATO DE RESPOSTA:**
Responda APENAS com JSON válido, sem markdown:

Se NÃO há X vermelho (prova válida):
{
  "invalidated": false,
  "details": [
    {"q": 1, "studentAnswer": "A", "correctAnswer": "${gabaritoArray[0]}", "correct": true},
    {"q": 2, "studentAnswer": "B", "correctAnswer": "${gabaritoArray[1]}", "correct": false},
    ... (uma entrada para cada questão até ${totalQuestoes})
  ]
}

Se HÁ X vermelho (prova anulada):
{
  "invalidated": true,
  "details": ${JSON.stringify(invalidDetails)}
}

**RESPONDA AGORA:**
`;

      try {
        const result = await model.generateContent(
          [singleImagePrompt, studentImagePart],
          generationConfig
        );
        const fullResponseText = result.response.text();
        let aiResponse;
        try {
            const cleanedText = fullResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
            aiResponse = JSON.parse(cleanedText);
        } catch (e) {
            console.error(`[JOB ${jobId}] Erro ao parsear JSON da IA para ${studentFile.originalname}:`, e.message);
            console.error("Texto recebido da IA:", fullResponseText);
            throw new Error(`A IA retornou um formato de JSON inválido para a imagem ${studentFile.originalname}.`);
        }

        if (aiResponse && aiResponse.details) {
          const correctCount = aiResponse.details.filter(d => d.correct).length;
          const gradeString = `${correctCount}/${totalQuestoes}`;
          console.log(`[JOB ${jobId}] Nota para ${studentFile.originalname}: ${gradeString}`);
          results.push({ 
            fileName: studentFile.originalname || studentFile.filename, 
            grade: gradeString,
            details: aiResponse.details || [] 
          });
        } else {
          throw new Error(`A IA não retornou um JSON com a propriedade 'details' para a imagem ${studentFile.originalname}.`);
        }
      } catch (imageError) {
        console.error(`[JOB ${jobId}] Erro ao processar a imagem ${studentFile.originalname}:`, imageError.message);
        results.push({ 
          fileName: studentFile.originalname || studentFile.filename, 
          grade: `0/${totalQuestoes}`,
          details: invalidDetails
        });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } 

    console.log(`[JOB ${jobId}] Processamento de todas as imagens concluído.`);
    const finalResultsPayload = { results: results }; 
    job.status = "completed";
    job.progress = 100;
    job.message = "Correção concluída!";
    job.results = finalResultsPayload;

  } catch (error) {
    console.error(`[JOB ${jobId}] Erro geral:`, error.message);
    job.status = "failed";
    job.error = error.message || "Ocorreu um erro geral ao corrigir as atividades.";
  } finally {
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
// 5️⃣ ENDPOINT: INICIAR VERIFICAÇÃO (MÚLT. ESCOLHA) (Gabarito em Texto)
// ==========================================================
app.post("/start-verification", 
  upload.fields([
      { name: 'studentSheet', maxCount: 40 } // Apenas as imagens
  ]), 
  (req, res) => {
    
    // Pega o gabarito do corpo do formulário
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

    console.log(`[JOB ${jobId}] Verificação (Múlt. Escolha) criada. Iniciando em segundo plano...`);
    // Passa o gabarito em TEXTO para a função
    corrigirProvas(jobId, studentSheetFiles, gabarito); 
    res.status(202).json({ jobId: jobId });
  }
);

// ==========================================================
// 6️⃣ FUNÇÃO: CORREÇÃO DISSERTATIVA (SEGUNDO PLANO)
// ==========================================================
async function corrigirProvasDissertativas(jobId, studentSheetFiles, gabarito, criterios, notaMaxima) {
  const job = jobs[jobId]; 
  const tempFilePaths = []; 
  studentSheetFiles.forEach(file => tempFilePaths.push(file.path));

  const generationConfig = {
      temperature: 0.3, 
  };
  const results = [];

  try {
    const model = getModel(); // Usa o modelo flash
    
    const totalImagens = studentSheetFiles.length;
    console.log(`[JOB ${jobId}] Iniciando correção DISSERTATIVA de ${totalImagens} imagens.`);

    for (let i = 0; i < totalImagens; i++) {
      const studentFile = studentSheetFiles[i];
      const studentImagePart = fileToGenerativePart(studentFile.path, studentFile.mimetype);
      if (!studentImagePart) continue;

      const percent = Math.round(((i + 1) / totalImagens) * 95); 
      job.progress = percent;
      job.message = `Corrigindo prova ${i + 1} de ${totalImagens}... (${studentFile.originalname})`;
      console.log(`[JOB ${jobId}] Progresso: ${percent}% - ${job.message}`);

      const dissertativaPrompt = `
        TAREFA: Você é um professor assistente. Sua tarefa é corrigir a prova dissertativa de um aluno contida em uma IMAGEM.
        CONTEXTO:
        1.  **GABARITO (RESPOSTA ESPERADA):** """${gabarito}"""
        2.  **CRITÉRIOS DE AVALIAÇÃO (OBSERVAÇÕES):** """${criterios}"""
        3.  **NOTA MÁXIMA:** ${notaMaxima}
        INSTRUÇÕES:
        1.  Leia e entenda o GABARITO e os CRITÉRIOS.
        2.  Leia a resposta do aluno na IMAGEM.
        3.  Compare a resposta do aluno com o GABARITO, aplicando os CRITÉRIOS.
        4.  Decida uma NOTA para o aluno, de 0 a ${notaMaxima}. A nota pode ser um número decimal (ex: 8.5).
        5.  Escreva um FEEDBACK detalhado, explicando por que o aluno tirou essa nota, o que ele acertou, e o que faltou de acordo com o GABARITO e os CRITÉRIOS.
        FORMATO DE SAÍDA:
        Responda APENAS com um objeto JSON válido. Não inclua markdown (como \`\`\`json) ou qualquer outro texto.
        
        {
          "nota": 8.5,
          "feedback": "O aluno demonstrou boa compreensão do Tópico 1, como pedido nos critérios. No entanto, a explicação sobre o Tópico 2 foi incompleta e não citou os exemplos do gabarito, por isso a nota não foi máxima."
        }
      `;

      try {
        const result = await model.generateContent(
          [dissertativaPrompt, studentImagePart],
          generationConfig
        );
        const fullResponseText = result.response.text();

        let aiResponse;
        try {
            const cleanedText = fullResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
            aiResponse = JSON.parse(cleanedText);
        } catch (e) {
            console.error(`[JOB ${jobId}] Erro ao parsear JSON da IA para ${studentFile.originalname}:`, e.message);
            console.error("Texto recebido da IA:", fullResponseText);
            throw new Error(`A IA retornou um formato de JSON inválido para a imagem ${studentFile.originalname}.`);
        }

        if (aiResponse && aiResponse.nota !== undefined && aiResponse.feedback) {
          console.log(`[JOB ${jobId}] Nota para ${studentFile.originalname}: ${aiResponse.nota}`);
          results.push({ 
            fileName: studentFile.originalname || studentFile.filename, 
            nota: aiResponse.nota.toString(),
            feedback: aiResponse.feedback 
          });
        } else {
          throw new Error(`A IA não retornou um JSON com 'nota' e 'feedback' para a imagem ${studentFile.originalname}.`);
        }
        
      } catch (imageError) {
        console.error(`[JOB ${jobId}] Erro ao processar a imagem ${studentFile.originalname}:`, imageError.message);
        results.push({ 
          fileName: studentFile.originalname || studentFile.filename, 
          nota: "Erro",
          feedback: `A IA falhou ao processar esta imagem.\n${imageError.message}`
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    } // Fim do loop for

    console.log(`[JOB ${jobId}] Processamento dissertativo concluído.`);
    const finalResultsPayload = { results: results }; 
    job.status = "completed";
    job.progress = 100;
    job.message = "Correção concluída!";
    job.results = finalResultsPayload;

  } catch (error) {
    console.error(`[JOB ${jobId}] Erro geral:`, error.message);
    job.status = "failed";
    job.error = error.message || "Ocorreu um erro geral ao corrigir as provas.";
  } finally {
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
// 7️⃣ ENDPOINT: INICIAR CORREÇÃO DISSERTATIVA
// ==========================================================
app.post("/start-dissertativa-correction", 
  upload.fields([
      { name: 'studentSheet', maxCount: 40 } 
  ]), 
  (req, res) => {
    
    const { gabaritoDissertativo, criteriosAvaliacao, notaMaxima } = req.body;

    if (!req.files || !req.files.studentSheet) {
      return res.status(400).json({ error: "É necessário enviar pelo menos uma imagem do aluno." });
    }
    
    if (!gabaritoDissertativo || !criteriosAvaliacao || !notaMaxima) {
      return res.status(400).json({ error: "Por favor, preencha o gabarito, os critérios e a nota máxima." });
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
      message: "Iniciando correção dissertativa...",
      results: null
    };

    console.log(`[JOB ${jobId}] Correção DISSERTATIVA criada. Iniciando em segundo plano...`);

    corrigirProvasDissertativas(jobId, studentSheetFiles, gabaritoDissertativo, criteriosAvaliacao, notaMaxima);

    res.status(202).json({ jobId: jobId });
  }
);


// ================================
// 8️⃣ INICIALIZAÇÃO DO SERVIDOR
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
