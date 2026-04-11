import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();

app.use(cors());
app.use(express.json());

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

async function processQueue() {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      const browserInstance = await getBrowser();
      const context = await browserInstance.newContext({
        viewport: { width: 1280, height: 720 }
      });

      const page = await context.newPage();

      console.log("Iniciando screenshot para:", job.url);

      await page.goto(job.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      const buffer = await page.screenshot({
        fullPage: true
      });

      await page.close().catch(() => {});
      await context.close().catch(() => {});

      job.resolve(buffer);
    } catch (error) {
      console.error("Erro no Worker:", error);
      job.reject(error);
    }
  }

  running = false;
}

function enqueue(url) {
  return new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
    processQueue();
  });
}

app.get("/", (req, res) => {
  res.send("Worker screenshot rodando");
});

app.post("/screenshot", async (req, res) => {
  try {
    const { shareCode } = req.body;

    if (!shareCode) {
      return res.status(400).json({
        error: "shareCode é obrigatório"
      });
    }

    const url = `https://app.agriwise.com.br/screenshots/${shareCode}`;
    const image = await enqueue(url);

    res.set("Content-Type", "image/png");
    res.send(image);
  } catch (error) {
    console.error("Erro ao gerar screenshot:", error);

    res.status(500).json({
      error: "Erro ao gerar screenshot",
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor iniciado na porta", PORT);
});
