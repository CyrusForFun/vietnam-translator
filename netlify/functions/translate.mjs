// Poe API proxy — receives extracted text, returns Chinese translation

const POE_BOT_URL = "https://api.poe.com/bot/";
const PROTOCOL_VERSION = "1.2";

function generateId() {
  return `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

function buildPrompt(ocrText, exchangeRate) {
  return `你是一個專業的越南語翻譯助手，專門幫助香港旅客在越南旅行。

以下是從圖片中 OCR 提取的文字（可能有少許辨識錯誤，請根據上下文自動修正）：

---
${ocrText}
---

請執行以下任務：

1. 將所有越南語文字翻譯成繁體中文
2. 如果有其他語言（英文等），也一併翻譯
3. 如果發現任何越南盾金額（VND/₫/đ/dong），自動換算成港幣
   匯率：1 HKD ≈ ${exchangeRate} VND

回覆格式（每段文字）：

原文：[原文，修正明顯 OCR 錯誤後]
翻譯：[繁體中文翻譯]
💰 [如有金額：X VND ≈ Y HKD]

注意：
- 翻譯要自然通順
- 如果是菜單/餐牌，保持格式整齊
- 金額四捨五入到小數點後一位
- 如果文字無意義或無法辨認，回覆：「無法辨識文字內容」
- 直接給結果，不要多餘解釋`;
}

function parseSSE(raw) {
  const lines = raw.split("\n");
  let result = "";
  let error = null;
  for (const line of lines) {
    if (line.startsWith("event: error")) {
      // Next data line is the error
      continue;
    }
    if (line.startsWith("data: ")) {
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.error_type || payload.allow_retry !== undefined) {
          error = payload.text || "Unknown bot error";
        } else if (payload.text) {
          result += payload.text;
        }
      } catch {
        // skip
      }
    }
  }
  return { result, error };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
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

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.POE_API_KEY;
  if (!apiKey) {
    return json({ error: "Server missing POE_API_KEY" }, 500);
  }

  try {
    const body = await req.json();
    const { text, botName, exchangeRate } = body;

    if (!text || !text.trim()) {
      return json({ error: "No text to translate" }, 400);
    }

    const model = botName || "GPT-4o-Mini";
    const prompt = buildPrompt(text.trim(), exchangeRate || 3200);

    const queryBody = {
      version: PROTOCOL_VERSION,
      type: "query",
      query: [
        {
          role: "user",
          content: prompt,
          content_type: "text/plain",
          attachments: [],
        },
      ],
      user_id: "",
      conversation_id: generateId(),
      message_id: generateId(),
    };

    const botRes = await fetch(`${POE_BOT_URL}${model}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(queryBody),
    });

    if (!botRes.ok) {
      const errText = await botRes.text();
      return json({ error: `API error (${botRes.status}): ${errText}` }, 502);
    }

    const rawSSE = await botRes.text();
    const { result, error } = parseSSE(rawSSE);

    if (error) {
      return json({ error: `Bot error: ${error}` }, 502);
    }

    if (!result) {
      return json({ translation: rawSSE || "（空白回應）" });
    }

    return json({ translation: result });
  } catch (err) {
    return json({ error: `Server error: ${err.message}` }, 500);
  }
}

export const config = {
  path: "/api/translate",
};
