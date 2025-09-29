import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const upload = multer({ dest: "uploads/" });
const HF_TOKEN = process.env.HF_TOKEN;

app.use(cors());

app.post("/transcribe", upload.single("audio"), async (req, res) => {
    let filePath = req.file ? req.file.path : null;
    try {
        if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

        const audioBuffer = fs.readFileSync(filePath);
        const audioMimeType = req.file.mimetype; // Deve ser 'audio/mpeg' para MP3

        // Modelo Wav2Vec2 para Português
        const transcriptionResp = await fetch(
            "https://api-inference.huggingface.co/models/jonatasgrosman/wav2vec2-large-xlsr-53-portuguese",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${HF_TOKEN}`,
                    "Content-Type": audioMimeType, 
                },
                body: audioBuffer,
            }
        );

        // Verifica se a resposta foi bem-sucedida (status 2xx)
        if (!transcriptionResp.ok) {
            const errorText = await transcriptionResp.text();
            console.error(`❌ Erro HTTP ${transcriptionResp.status} do HF:`, errorText);
            try {
                const errorJson = JSON.parse(errorText);
                return res.status(transcriptionResp.status).json({ error: errorJson.error || "Erro na API do Hugging Face" });
            } catch (e) {
                // Se o erro não for JSON (como o 404), retorna a mensagem original
                return res.status(transcriptionResp.status).json({ error: `Erro na API do Hugging Face: Status ${transcriptionResp.status} - ${errorText.substring(0, 100)}` });
            }
        }

        const contentType = transcriptionResp.headers.get("content-type");
        let transcriptionData;
        if (contentType && contentType.includes("application/json")) {
            transcriptionData = await transcriptionResp.json();
        } else {
            const text = await transcriptionResp.text();
            console.error("❌ Retorno inesperado do HF (não JSON):", text);
            return res.status(500).json({ error: "Erro no Hugging Face: retorno inesperado" });
        }

        fs.unlinkSync(filePath);

        res.json({ transcricao: transcriptionData.text || "" });

    } catch (error) {
        console.error("❌ ERRO NO BACKEND:", error);
        // Garante que o arquivo temporário seja removido mesmo em caso de erro
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ error: "Erro ao processar áudio: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend rodando na porta ${PORT}`));
