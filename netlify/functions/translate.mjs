// Translation proxy — single Google Translate call + currency detection

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

  if (!res.ok) throw new Error(`Google Translate ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data?.[0])) throw new Error("Bad response");

  return data[0].map((seg) => seg[0]).join("");
}

function detectCurrency(text, rate) {
  const results = [];
  const seen = new Set();

  // Match: 50.000đ, 50,000 VND, 50000₫, etc.
  const patterns = [
    /(\d[\d.,]*)\s*(?:₫|đ|đồng|VND|vnd|dong)/gi,
    /\b(\d{2,3}(?:[.,]\d{3})+)\b/g, // standalone formatted numbers like 50.000
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const numStr = m[1].replace(/[.,]/g, "");
      const amount = parseInt(numStr, 10);
      if (amount >= 1000 && amount < 1e9 && !seen.has(amount)) {
        seen.add(amount);
        results.push({
          vnd: amount,
          hkd: (amount / rate).toFixed(1),
          original: m[0],
        });
      }
    }
  }
  return results;
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
    const { text, exchangeRate } = await req.json();
    if (!text?.trim()) return json({ error: "No text" }, 400);

    const rate = exchangeRate || 3200;

    // ONE single call to Google Translate for ALL text
    const translated = await googleTranslate(text.trim(), "vi", "zh-TW");

    // Detect currencies in original text
    const currencies = detectCurrency(text, rate);

    // Build paired result: original lines + translated lines
    const origLines = text.trim().split("\n").filter((l) => l.trim());
    const transLines = translated.split("\n").filter((l) => l.trim());

    const blocks = [];
    const maxLen = Math.max(origLines.length, transLines.length);

    for (let i = 0; i < maxLen; i++) {
      const orig = origLines[i]?.trim() || "";
      const trans = transLines[i]?.trim() || "";
      if (!orig && !trans) continue;

      let block = `原文：${orig}\n翻譯：${trans}`;

      // Check if this line has currency
      for (const c of currencies) {
        if (orig.includes(c.original)) {
          block += `\n💰 ${c.vnd.toLocaleString()} VND ≈ ${c.hkd} HKD`;
        }
      }
      blocks.push(block);
    }

    return json({
      translation: blocks.join("\n\n"),
      currencies,
      backend: "google",
    });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

export const config = {
  path: "/api/translate",
};
