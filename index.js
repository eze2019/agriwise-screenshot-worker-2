import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// Inicialização do Supabase
// Certifique-se de que essas variáveis estão no painel do Railway!
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🔍 Health check (Essencial para o Railway saber que o app está vivo)
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// 📸 Endpoint para gerar screenshot
app.post("/screenshot", async (req, res) => {
  const { shareCode } = req.body;
  let browser = null;

  if (!shareCode) {
    return res.status(400).json({ error: "shareCode obrigatório" });
  }

  try {
    const url = `${process.env.APP_URL}/coleta/${shareCode}`;
    console.log(`Iniciando screenshot para: ${url}`);

    // Lançando o browser com flags de segurança para Docker/Linux
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage" // Importante para ambientes com pouca memória (shared memory)
      ]
    });

    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 }
    });

    // Timeout de 30 segundos para carregar a página
    await page.goto(url, { 
      waitUntil: "networkidle", 
      timeout: 30000 
    });

    // Espera o sinal do seu mapa (window.__MAP_READY__)
    await page.waitForFunction(
      () => window.__MAP_READY__ === true,
      { timeout: 15000 }
    ).catch(() => console.log("Aviso: __MAP_READY__ não detectado, tirando print assim mesmo."));

    const screenshot = await page.screenshot({ type: "png" });

    // Upload para o Supabase Storage
    const filePath = `thumbnails/${shareCode}.png`;
    const { error: uploadError } = await supabase.storage
      .from("public")
      .upload(filePath, screenshot, {
        contentType: "image/png",
        upsert: true
      });

    if (uploadError) throw uploadError;

    // Pega a URL pública
    const { data: urlData } = supabase.storage
      .from("public")
      .getPublicUrl(filePath);

    // Atualiza o banco de dados
    const { error: dbError } = await supabase
      .from("collection_shares")
      .update({ thumbnail_url: urlData.publicUrl })
      .eq("share_code", shareCode);

    if (dbError) throw dbError;

    res.json({ success: true, image: urlData.publicUrl });

  } catch (err) {
    console.error("Erro no Worker:", err.message);
    res.status(500).json({ error: "Erro ao gerar screenshot", details: err.message });
  } finally {
    // FECHA O BROWSER SEMPRE (Evita estouro de RAM no Railway)
    if (browser) {
      await browser.close();
    }
  }
});

// 🚀 Configuração de PORTA e HOST (Obrigatório para o deploy não falhar)
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0'; // Garante que o app aceite conexões externas no container

app.listen(PORT, HOST, () => {
  console.log(`🚀 Screenshot worker rodando em http://${HOST}:${PORT}`);
  console.log(`🔗 APP_URL configurada: ${process.env.APP_URL}`);
});

