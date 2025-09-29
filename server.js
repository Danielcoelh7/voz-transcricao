import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import { GoogleGenAI } from "@google/genai"; 

const app = express();
const upload = multer({ dest: "uploads/" });

// A chave será lida da variável de ambiente GEMINI_API_KEY no Render
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// Inicializa o cliente Gemini
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

app.use(cors());

// Função auxiliar para converter o arquivo local em um objeto para a API do Gemini
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(path)).toString("base64"),
      mimeType,
    },
  };
}


app.post("/transcribe", upload.single("audio"), async (req, res) => {
    let filePath = req.file ? req.file.path : null;
    try {
        if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
        
        // 1. Prepara o arquivo (MP3) para o Gemini
        const audioPart = fileToGenerativePart(filePath, req.file.mimetype);

        const promptTranscription = "Transcreva o áudio a seguir na íntegra. Não adicione nenhum comentário além da transcrição pura do texto.";
        const promptSummary = "Com base no texto transcrito, gere um resumo conciso com os principais pontos em Português (no máximo 5 linhas).";

        // 2. Chamada para Transcrição
        // Nota: A API do Gemini pode ter latência para áudios longos.
        const transcriptionResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash", 
            contents: [audioPart, promptTranscription],
        });
        const transcricao = transcriptionResponse.text.trim();

        // 3. Chamada para Resumo (Usando o texto transcrito como entrada)
        const summaryResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            // Passamos a transcrição e o prompt de resumo.
            contents: [transcricao, promptSummary],
        });
        const resumo = summaryResponse.text.trim();

        // 4. Limpeza e Resposta
        fs.unlinkSync(filePath);

        res.json({ transcricao: transcricao, resumo: resumo });

    } catch (error) {
        console.error("❌ ERRO NO BACKEND (GEMINI):", error);
        
        // Trata erros de autenticação (Chave de API inválida)
        if (error.message && error.message.includes("API key not valid")) {
            return res.status(401).json({ error: "Erro de autenticação Gemini. Verifique se a GEMINI_API_KEY no Render está correta." });
        }
        
        // Garante que o arquivo temporário seja removido
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        res.status(500).json({ error: `Erro ao processar áudio: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend rodando na porta ${PORT}`));
