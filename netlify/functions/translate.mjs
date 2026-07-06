// Translation proxy — Google Translate (free, no key) + Poe/Gemini optional

// Google Translate unofficial API (same as web client uses)
async function googleTranslate(text, sourceLang, targetLang) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sourceLang);
  url.searchParams.set("tl", targetLang);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) {
    throw new Error(`Google Translate ${res.status}`);
  }

  const data = await res.json();
  // Response: [[["translated","original",...],...],...,"detected_lang"]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Unexpected Google Translate response");
  }

  return data[0].map((seg) => seg[0]).join("");
}

// Detect VND amounts and convert to HKD
function convertCurrency(text, rate) {
  // Match patterns like: 50.000đ, 50,000 VND, 50000₫, 50.000 đồng, etc.
  const vndPattern = /(\d[\d.,]*)\s*(?:₫|đ|đồng|VND|vnd|dong)/gi;
  const conversions = [];

  let match;
  while ((match = vndPattern.exec(text)) !== null) {
    // Parse Vietnamese number format (50.000 = 50000, 50,000 = 50000)
    let numStr = match[1].replace(/\./g, "").replace(/,/g, "");
    const amount = parseInt(numStr, 10);
    if (amount > 0 && amount < 1e12) {
      const hkd = (amount / rate).toFixed(1);
      conversions.push({
        original: match[0],
        vnd: amount,
        hkd: parseFloat(hkd),
      });
    }
  }

  // Also match standalone large numbers that are likely VND (e.g., "50.000" on a menu)
  const standalonePattern = /\b(\d{2,3}(?:[.,]\d{3})+)\b/g;
  while ((match = standalonePattern.exec(text)) !== null) {
    let numStr = match[1].replace(/\./g, "").replace(/,/g, "");
    const amount = parseInt(numStr, 10);
    // Only consider amounts typical for VND (>= 1000)
    if (amount >= 1000 && amount < 1e9) {
      const already = conversions.some((c) => c.vnd === amount);
      if (!already) {
        const hkd = (amount / rate).toFixed(1);
        conversions.push({
          original: match[0],
          vnd: amount,
          hkd: parseFloat(hkd),
        });
      }
    }
  }

  return conversions;
}

// ── Poe text-only (optional) ──
async function translateWithPoe(apiKey, ocrText, exchangeRate, model) {
  const botName = model || "GPT-4o-Mini";
  const prompt = `將以下越南語翻譯成繁體中文，如有金額(VND)請換算港幣(1 HKD≈${exchangeRate} VND)。格式：原文：xxx\\n翻譯：xxx\\n💰 xxx VND ≈ xxx HKD\\n\\n${ocrText}`;

  const res = await fetch(`https://api.poe.com/bot/${botName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      version: "1.2",
      type: "query",
      query: [{ role: "user", content: prompt, content_type: "text/plain", attachments: [] }],
      user_id: "",
      conversation_id: `${Date.now()}`,
      message_id: `m${Date.now()}`,
    }),
  });

  if (!res.ok) throw new Error(`Poe ${res.status}`);

  const raw = await res.text();
  let result = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const p = JSON.parse(line.slice(6));
        if (p.text && !p.error_type) result += p.text;
        if (p.error_type) throw new Error(p.text);
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e;
      }
    }
  }
  return result;
}

// ── Gemini vision (optional) ──
async function translateWithGemini(apiKey, base64Image, mimeType, exchangeRate, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.0-flash"}:generateContent?key=${apiKey}`;
  const prompt = `分析圖片中的越南語文字，翻譯成繁體中文。如有金額(VND)換算港幣(1 HKD≈${exchangeRate} VND)。格式：原文：xxx\\n翻譯：xxx\\n💰 xxx`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Image } }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const { text, image, mimeType, backend, model, exchangeRate } = body;
    const rate = exchangeRate || 3200;

    // ── Gemini vision path ──
    if (backend === "gemini" && image) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return json({ error: "No GEMINI_API_KEY" }, 500);
      const translation = await translateWithGemini(key, image, mimeType, rate, model);
      return json({ translation, backend: "gemini" });
    }

    // ── Poe text path ──
    if (backend === "poe" && text) {
      const key = process.env.POE_API_KEY;
      if (!key) return json({ error: "No POE_API_KEY" }, 500);
      const translation = await translateWithPoe(key, text, rate, model);
      return json({ translation, backend: "poe" });
    }

    // ── Default: Google Translate (free, no key) ──
    if (!text) return json({ error: "Missing text" }, 400);

    // Split into lines and translate each
    const lines = text.split("\n").filter((l) => l.trim());
    const results = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const translated = await googleTranslate(line.trim(), "vi", "zh-TW");
        const currencies = convertCurrency(line, rate);

        let entry = `原文：${line.trim()}\n翻譯：${translated}`;
        for (const c of currencies) {
          entry += `\n💰 ${c.vnd.toLocaleString()} VND ≈ ${c.hkd} HKD`;
        }
        results.push(entry);
      } catch {
        // If one line fails, continue with others
        results.push(`原文：${line.trim()}\n翻譯：[翻譯失敗]`);
      }
    }

    // Also find currencies in the full text that might span lines
    const allCurrencies = convertCurrency(text, rate);

    return json({
      translation: results.join("\n\n"),
      currencies: allCurrencies,
      backend: "google",
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

export const config = {
  path: "/api/translate",
};
