import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let browser = null;
let processing = false;
const queue = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBrowser() {
  if (browser) return browser;

  console.log("Iniciando instância única do Chromium...");

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote"
    ]
  });

  browser.on("disconnected", () => {
    console.log("Chromium desconectado. A próxima requisição irá recriá-lo.");
    browser = null;
  });

  return browser;
}

async function closeBrowser() {
  if (!browser) return;

  try {
    await browser.close();
  } catch (error) {
    console.error("Erro ao fechar browser:", error.message);
  } finally {
    browser = null;
  }
}

async function generateScreenshot(shareCode) {
  const url = `${process.env.APP_URL}/screenshots/${shareCode}`;
  const activeBrowser = await getBrowser();
  const context = await activeBrowser.newContext({
    viewport: { width: 1200, height: 630 }
  });
  const page = await context.newPage();

  try {
    console.log(`Iniciando screenshot para: ${url}`);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
      console.log("Aviso: networkidle não foi atingido a tempo.");
    });

    await page.waitForFunction(
      () => window.__MAP_READY__ === true,
      { timeout: 15000 }
    ).catch(() => console.log("Aviso: __MAP_READY__ não detectado."));

    const screenshot = await page.screenshot({ type: "png" });

    const filePath = `thumbnails/${shareCode}.png`;
    const { error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(filePath, screenshot, {
        contentType: "image/png",
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .getPublicUrl(filePath);

    const { error: dbError } = await supabase
      .from("collection_shares")
      .update({ thumbnail_url: urlData.publicUrl })
      .eq("share_code", shareCode);

    if (dbError) throw dbError;

    return { success: true, image: urlData.publicUrl };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function generateScreenshotWithRetry(shareCode, maxRetries = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await generateScreenshot(shareCode);
    } catch (error) {
      lastError = error;
      console.error(`Tentativa ${attempt} falhou para ${shareCode}:`, error.message);

      if (
        error.message?.includes("Target page, context or browser has been closed") ||
        error.message?.includes("browserType.launch")
      ) {
        await closeBrowser();
      }

      if (attempt < maxRetries) {
        await sleep(3000);
      }
    }
  }

  throw lastError;
}

function enqueueScreenshot(shareCode) {
  return new Promise((resolve, reject) => {
    queue.push({ shareCode, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      const result = await generateScreenshotWithRetry(job.shareCode, 2);
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    }
  }

  processing = false;
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/screenshot", async (req, res) => {
  const { shareCode } = req.body;

  if (!shareCode) {
    return res.status(400).json({ error: "shareCode obrigatório" });
  }

  try {
    const result = await enqueueScreenshot(shareCode);
    return res.json(result);
  } catch (err) {
    console.error("Erro no Worker:", err.message);
    return res.status(500).json({
      error: "Erro ao gerar screenshot",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 Worker rodando em http://${HOST}:${PORT}`);
  console.log(`🪣 Bucket configurado: ${process.env.SUPABASE_BUCKET}`);
});

async function shutdown() {
  console.log("Encerrando worker...");
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

