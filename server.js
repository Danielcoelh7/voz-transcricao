import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { v4 as uuidv4 } from 'uuid';

// Imports para manipulação de áudio
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// Configura o caminho do FFmpeg para a biblioteca estática
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());

// Carrega a chave da API do Gemini a partir das variáveis de ambiente do Render
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
        console.error("[ERRO] Nenhuma arquivo recebido.");
        return res.status(400).json({ error: "Nenhum arquivo de áudio enviado." });
    }

    const jobId = uuidv4();
    const filePath = req.file.path;
    const outputDir = `uploads/${jobId}`;

    console.log(`[JOB ${jobId}] Trabalho iniciado. Arquivo recebido em: ${filePath}`);

    // Cria um diretório temporário para os pedaços de áudio
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Responde IMEDIATAMENTE ao frontend com o ID do trabalho
    res.status(202).json({ jobId });

    // --- INICIA O PROCESSAMENTO PESADO EM SEGUNDO PLANO ---
    jobs[jobId] = { status: "splitting", transcription: null, progress: 0 };

    console.log(`[JOB ${jobId}] Iniciando o FFmpeg para dividir o arquivo.`);
    
    // Etapa 1: Dividir o áudio em pedaços (chunks)
    ffmpeg(filePath)
        .outputOptions(['-f segment', '-segment_time 60', '-c copy'])
        .output(`${outputDir}/chunk_%03d.mp3`)
        .on('progress', (progress) => {
            // Este log é para vermos se o FFmpeg está de fato trabalhando
            console.log(`[JOB ${jobId}] [FFmpeg] Progresso da divisão: ${progress.timemark}`);
        })
        .on('end', async () => {
            console.log(`[JOB ${jobId}] [FFmpeg] Divisão concluída com sucesso.`);
            
            // Etapa 2: Transcrever cada pedaço com o Gemini
            jobs[jobId].status = "processing";
            const chunkFiles = fs.readdirSync(outputDir).sort();
            console.log(`[JOB ${jobId}] Encontrados ${chunkFiles.length} chunks para processar.`);
            
            let fullTranscription = [];
            
            for (let i = 0; i < chunkFiles.length; i++) {
                const chunkPath = `${outputDir}/${chunkFiles[i]}`;
                try {
                    console.log(`[JOB ${jobId}] Processando o chunk: ${chunkFiles[i]}`);
                    const audioPart = fileToGenerativePart(chunkPath, 'audio/mp3');
                    const prompt = "Transcreva o áudio a seguir na íntegra. Não adicione nenhum comentário além da transcrição pura do texto.";
                    
                    const response = await ai.models.generateContent({
                        model: "gemini-1.5-flash", 
                        contents: [audioPart, prompt],
                    });
                    
                    fullTranscription.push(response.response.text());
                    jobs[jobId].progress = ((i + 1) / chunkFiles.length) * 100;

                } catch (error) {
                    console.error(`[JOB ${jobId}] Erro ao processar o chunk ${chunkFiles[i]} com Gemini:`, error);
                    fullTranscription.push(`[ERRO NA TRANSCRIÇÃO DO TRECHO ${i+1}]`);
                }
            }

            // Etapa 3: Juntar tudo e finalizar o trabalho
            console.log(`[JOB ${jobId}] Processamento de todos os chunks concluído.`);
            jobs[jobId] = {
                status: "completed",
                transcription: fullTranscription.join(' '),
                progress: 100
            };

            // Etapa 4: Limpar os arquivos temporários
            console.log(`[JOB ${jobId}] Limpando arquivos temporários.`);
            fs.rmSync(outputDir, { recursive: true, force: true });
            fs.unlinkSync(filePath);
        })
        .on('error', (err, stdout, stderr) => {
            // Este log captura erros específicos do FFmpeg
            console.error(`[JOB ${jobId}] [FFmpeg] ERRO FATAL:`, err.message);
            console.error(`[JOB ${jobId}] [FFmpeg] STDERR:`, stderr); // A saída de erro do FFmpeg é crucial
            jobs[jobId] = { status: "failed", error: "Erro ao dividir o arquivo de áudio." };
            
            // Garante a limpeza dos arquivos mesmo em caso de erro
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

// Configuração do servidor para rodar na porta fornecida pelo Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Backend com chunking rodando na porta ${PORT}`);
});
