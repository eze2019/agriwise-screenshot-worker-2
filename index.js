import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/screenshot", async (req, res) => {
  const { shareCode } = req.body;

  if (!shareCode) {
    return res.status(400).json({ error: "shareCode obrigatório" });
  }

  const url = `${process.env.APP_URL}/coleta/${shareCode}`;

  const browser = await chromium.launch({
    args: ["--no-sandbox"]
  });

  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 }
  });

  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForFunction(() => window.__MAP_READY__ === true, {
    timeout: 15000
  });

  const screenshot = await page.screenshot({ type: "png" });
  await browser.close();

  const filePath = `thumbnails/${shareCode}.png`;

  await supabase.storage
    .from("public")
    .upload(filePath, screenshot, {
      contentType: "image/png",
      upsert: true
    });

  const { data } = supabase.storage.from("public").getPublicUrl(filePath);

  await supabase
    .from("collection_shares")
    .update({ thumbnail_url: data.publicUrl })
    .eq("share_code", shareCode);

  res.json({ success: true, image: data.publicUrl });
});

app.listen(3000, () => {
  console.log("Screenshot worker rodando");
});
