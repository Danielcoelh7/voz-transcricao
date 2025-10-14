// server.js (Nova Versão com Chunking + Gemini)

import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { v4 as uuidv4 } from 'uuid';

// Imports para manipulação de áudio
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// Configura o caminho do FFmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// "Banco de dados" em memória para armazenar o status dos trabalhos
const jobs = {};

// Função para converter arquivo para o formato do Gemini
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType,
        },
    };
}

// ENDPOINT PARA INICIAR A TRANSCRIÇÃO
app.post("/transcribe-chunked", upload.single("audio"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
    }

    const jobId = uuidv4();
    const filePath = req.file.path;
    const outputDir = `uploads/${jobId}`;

    // Cria um diretório para os chunks
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    // Responde IMEDIATAMENTE ao usuário
    res.status(202).json({ jobId });

    // --- INICIA O PROCESSAMENTO EM SEGUNDO PLANO ---
    jobs[jobId] = { status: "splitting", transcription: null, progress: 0 };

    // 1. DIVIDIR O ÁUDIO EM PEDAÇOS DE 60 SEGUNDOS
    ffmpeg(filePath)
        .outputOptions([
            '-f segment',
            '-segment_time 60', // Pedaços de 60 segundos
            '-c copy' // Apenas copia o codec, mais rápido
        ])
        .output(`${outputDir}/chunk_%03d.mp3`) // Ex: chunk_000.mp3, chunk_001.mp3
        .on('end', async () => {
            // 2. TRANSCREVER CADA PEDAÇO EM SEQUÊNCIA
            jobs[jobId].status = "processing";
            const chunkFiles = fs.readdirSync(outputDir).sort();
            let fullTranscription = [];
            
            for (let i = 0; i < chunkFiles.length; i++) {
                const chunkPath = `${outputDir}/${chunkFiles[i]}`;
                try {
                    const audioPart = fileToGenerativePart(chunkPath, 'audio/mp3');
                    const prompt = "Transcreva o áudio a seguir na íntegra. Não adicione nenhum comentário além da transcrição pura do texto.";
                    
                    const response = await ai.models.generateContent({
                        model: "gemini-1.5-pro-latest",
                        contents: [audioPart, prompt],
                    });
                    
                    fullTranscription.push(response.response.text());
                    jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;

                } catch (error) {
                    console.error(`Erro ao processar o chunk ${chunkFiles[i]}:`, error);
                    fullTranscription.push(`[ERRO NA TRANSCRIÇÃO DO TRECHO ${i+1}]`);
                }
            }

            // 3. JUNTAR E FINALIZAR
            jobs[jobId] = {
                status: "completed",
                transcription: fullTranscription.join(' '),
                progress: 100
            };

            // 4. LIMPEZA
            fs.rmSync(outputDir, { recursive: true, force: true });
            fs.unlinkSync(filePath);
        })
        .on('error', (err) => {
            console.error('Erro no FFmpeg:', err);
            jobs[jobId] = { status: "failed", error: "Erro ao dividir o arquivo de áudio." };
            fs.unlinkSync(filePath);
        })
        .run();
});

// ENDPOINT PARA VERIFICAR O STATUS
app.get("/status/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: "Trabalho não encontrado." });
    }
    res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend com chunking rodando na porta ${PORT}`));

