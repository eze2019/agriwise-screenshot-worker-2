import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let browser = null;
let running = false;
const queue = [];

async function getBrowser() {
  if (browser) return browser;

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
    browser = null;
  });

  return browser;
}

async function generateAndUploadScreenshot(shareCode) {
  const url = `${process.env.APP_URL}/screenshots/${shareCode}`;
  console.log(`Iniciando screenshot para: ${url}`);

  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    viewport: { width: 1200, height: 630 }
  });

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    await page.waitForFunction(
      () => window.__MAP_READY__ === true,
      { timeout: 15000 }
    ).catch(() => console.log("Aviso: __MAP_READY__ não detectado."));

    try {
      await page.waitForSelector("canvas", { timeout: 5000 });
    } catch (_) {}

    await page.waitForTimeout(2000);

    const screenshot = await page.screenshot({
      type: "png"
    });

    const filePath = `thumbnails/${shareCode}.png`;

    const { error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(filePath, screenshot, {
        contentType: "image/png",
        upsert: true
      });

    if (uploadError) {
      throw new Error(`Erro no upload Supabase: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .getPublicUrl(filePath);

    const publicUrl = urlData?.publicUrl;

    if (!publicUrl) {
      throw new Error("Não foi possível obter a URL pública da imagem.");
    }

    const { error: dbError } = await supabase
      .from("collection_shares")
      .update({ thumbnail_url: publicUrl })
      .eq("share_code", shareCode);

    if (dbError) {
      throw new Error(`Erro ao atualizar banco: ${dbError.message}`);
    }

    return {
      success: true,
      image: publicUrl,
      filePath
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function processQueue() {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      const result = await generateAndUploadScreenshot(job.shareCode);
      job.resolve(result);
    } catch (error) {
      console.error("Erro no Worker:", error);
      job.reject(error);
    }
  }

  running = false;
}

function enqueue(shareCode) {
  return new Promise((resolve, reject) => {
    queue.push({ shareCode, resolve, reject });
    processQueue();
  });
}

app.get("/", (req, res) => {
  res.send("Worker screenshot rodando");
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.get("/screenshot/:shareCode", async (req, res) => {
  try {
    const { shareCode } = req.params;

    if (!shareCode) {
      return res.status(400).json({
        error: "shareCode é obrigatório"
      });
    }

    const result = await enqueue(shareCode);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao gerar screenshot",
      message: error.message
    });
  }
});

app.post("/screenshot", async (req, res) => {
  try {
    const { shareCode } = req.body;

    if (!shareCode) {
      return res.status(400).json({
        error: "shareCode é obrigatório"
      });
    }

    const result = await enqueue(shareCode);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao gerar screenshot",
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Servidor iniciado em http://${HOST}:${PORT}`);
  console.log(`Bucket configurado: ${process.env.SUPABASE_BUCKET}`);
});
