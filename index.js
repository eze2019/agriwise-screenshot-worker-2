import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// 🔗 Inicialização do Supabase com variáveis de ambiente
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🔍 Health check para o Railway
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

    // 🌐 Lançando o browser para ambiente Docker
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 }
    });

    await page.goto(url, { 
      waitUntil: "networkidle", 
      timeout: 30000 
    });

    // ⏳ Espera o sinal do mapa
    await page.waitForFunction(
      () => window.__MAP_READY__ === true,
      { timeout: 15000 }
    ).catch(() => console.log("Aviso: __MAP_READY__ não detectado."));

    const screenshot = await page.screenshot({ type: "png" });

    // 📤 Upload para o Bucket configurado no Railway
    const filePath = `thumbnails/${shareCode}.png`;
    const { error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET) // ✅ CORREÇÃO: Usa 'screenshots-url' do Railway
      .upload(filePath, screenshot, {
        contentType: "image/png",
        upsert: true
      });

    if (uploadError) throw uploadError;

    // 🔗 Pega a URL pública do Bucket correto
    const { data: urlData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET) // ✅ CORREÇÃO: Usa 'screenshots-url' do Railway
      .getPublicUrl(filePath);

    // 💾 Atualiza o banco de dados
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
    if (browser) {
      await browser.close();
    }
  }
});

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 Worker rodando em http://${HOST}:${PORT}`);
  console.log(`🪣 Bucket configurado: ${process.env.SUPABASE_BUCKET}`);
});
