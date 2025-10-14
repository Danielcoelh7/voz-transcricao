import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
// Correção na importação para usar a classe correta
import { GoogleGenerativeAI } from "@google/generative-ai"; 
import { v4 as uuidv4 } from 'uuid';

// Imports para manipulação de áudio
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// Configura o caminho do FFmpeg para a biblioteca estática
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

// Carrega a chave da API do Gemini a partir das variáveis de ambiente
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// <-- ALTERAÇÃO: A classe se chama GoogleGenerativeAI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// "Banco de dados" em memória para armazenar o status dos trabalhos de transcrição
const jobs = {};

// Função auxiliar para converter um arquivo local para o formato da API do Gemini
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType,
        },
    };
}

// 1. ENDPOINT PARA INICIAR A TRANSCRIÇÃO DE FORMA ASSÍNCRONA
app.post("/transcribe-chunked", upload.single("audio"), (req, res) => {
    if (!req.file) {
        console.error("[ERRO] Nenhum arquivo recebido.");
        return res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
    }

    const jobId = uuidv4();
    const filePath = req.file.path;
    const outputDir = `uploads/${jobId}`;

    console.log(`[JOB ${jobId}] Trabalho iniciado. Arquivo recebido em: ${filePath}`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    res.status(202).json({ jobId });

    // --- INICIA O PROCESSAMENTO PESADO EM SEGUNDO PLANO ---
    jobs[jobId] = { status: "splitting", transcription: null, progress: 0 };

    console.log(`[JOB ${jobId}] Iniciando o FFmpeg para dividir o arquivo.`);
    
    ffmpeg(filePath)
        .outputOptions(['-f segment', '-segment_time 60', '-c copy'])
        .output(`${outputDir}/chunk_%03d.mp3`)
        .on('progress', (progress) => {
            console.log(`[JOB ${jobId}] [FFmpeg] Progresso da divisão: ${progress.timemark}`);
        })
        .on('end', async () => {
            console.log(`[JOB ${jobId}] [FFmpeg] Divisão concluída com sucesso.`);
            
            jobs[jobId].status = "processing";
            const chunkFiles = fs.readdirSync(outputDir).sort();
            console.log(`[JOB ${jobId}] Encontrados ${chunkFiles.length} chunks para processar.`);
            
            let fullTranscription = [];
            
            // <-- ALTERAÇÃO 1: Seleciona o modelo ANTES do loop
            // Usar "-latest" é a prática recomendada para estabilidade
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

            for (let i = 0; i < chunkFiles.length; i++) {
                const chunkPath = `${outputDir}/${chunkFiles[i]}`;
                try {
                    console.log(`[JOB ${jobId}] Processando o chunk: ${chunkFiles[i]}`);
                    const audioPart = fileToGenerativePart(chunkPath, 'audio/mp3');
                    const prompt = "Transcreva o áudio a seguir na íntegra. Não adicione nenhum comentário além da transcrição pura do texto.";
                    
                    // <-- ALTERAÇÃO 2: Chama 'generateContent' no objeto 'model'
                    const result = await model.generateContent([prompt, audioPart]);

                    // <-- ALTERAÇÃO 3: Extrai o texto da resposta corretamente
                    const response = result.response;
                    const text = response.text();
                    
                    fullTranscription.push(text);
                    jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;

                } catch (error) {
                    console.error(`[JOB ${jobId}] Erro ao processar o chunk ${chunkFiles[i]} com Gemini:`, error);
                    fullTranscription.push(`[ERRO NA TRANSCRIÇÃO DO TRECHO ${i+1}]`);
                }
            }

            console.log(`[JOB ${jobId}] Processamento de todos os chunks concluído.`);
            jobs[jobId] = {
                status: "completed",
                transcription: fullTranscription.join(' '),
                progress: 100
            };

            console.log(`[JOB ${jobId}] Limpando arquivos temporários.`);
            fs.rmSync(outputDir, { recursive: true, force: true });
            fs.unlinkSync(filePath);
        })
        .on('error', (err, stdout, stderr) => {
            console.error(`[JOB ${jobId}] [FFmpeg] ERRO FATAL:`, err.message);
            console.error(`[JOB ${jobId}] [FFmpeg] STDERR:`, stderr);
            jobs[jobId] = { status: "failed", error: "Erro ao dividir o arquivo de áudio." };
            
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
        })
        .run();
});

// 2. ENDPOINT PARA O FRONTEND VERIFICAR O STATUS DO TRABALHO
app.get("/status/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: "Trabalho não encontrado." });
    }

    res.json(job);
});

// Configuração do servidor para rodar na porta fornecida pelo ambiente (ex: Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Backend com chunking rodando na porta ${PORT}`);
});
