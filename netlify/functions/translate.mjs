// Poe API proxy for image translation
// Uploads image to Poe, queries vision model, returns translation

const POE_UPLOAD_URL = "https://www.quora.com/poe_api/file_upload_3RD_PARTY_POST";
const POE_BOT_URL = "https://api.poe.com/bot/";
const PROTOCOL_VERSION = "1.2";

function generateId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

async function uploadImage(apiKey, base64Data, mimeType) {
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const ext = mimeType.includes("png") ? "png" : "jpg";
  const fileName = `capture.${ext}`;

  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mimeType }), fileName);

  // Poe upload uses raw API key (no "Bearer" prefix)
  const res = await fetch(POE_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: apiKey },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${res.status}: ${errText}`);
  }

  const data = await res.json();

  // Poe returns { attachment_url: "...", mime_type: "..." }
  if (!data.attachment_url) {
    throw new Error(`Unexpected upload response: ${JSON.stringify(data)}`);
  }

  return {
    url: data.attachment_url,
    content_type: data.mime_type || mimeType,
    name: fileName,
  };
}

function buildPrompt(exchangeRate) {
  return `你是一個專業的越南語翻譯助手，專門幫助香港旅客在越南旅行。請分析這張圖片中所有可見的文字，然後：

1. 提取圖片中所有可見文字（越南語或其他語言）
2. 將每段文字翻譯成繁體中文
3. 如果發現任何越南盾（VND/₫）金額，自動換算成港幣（HKD）
   匯率：1 HKD ≈ ${exchangeRate} VND

回覆格式（每段文字用以下格式）：

原文：[越南語原文]
翻譯：[繁體中文翻譯]
${exchangeRate ? "💰 [如有金額：X VND ≈ Y HKD]" : ""}

注意事項：
- 翻譯要自然通順，不要逐字翻譯
- 如果是菜單，保持菜名格式整齊
- 如果是路牌/標誌，簡潔明瞭
- 金額換算四捨五入到小數點後一位
- 如果圖片中沒有文字，回覆：「未偵測到文字」
- 不要加任何多餘解釋，直接給翻譯結果`;
}

function parseSSE(raw) {
  const lines = raw.split("\n");
  let result = "";
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.text) {
          result += payload.text;
        }
      } catch {
        // skip non-JSON data lines
      }
    }
  }
  return result;
}

export default async function handler(req) {
  // Handle CORS preflight
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
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { image, mimeType, botName, exchangeRate } = body;

    // Use server env var — frontend never needs to send the key
    const apiKey = process.env.POE_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server missing POE_API_KEY env var" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!image) {
      return new Response(
        JSON.stringify({ error: "Missing image data" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const model = botName || "GPT-4o";

    // Step 1: Upload image to Poe
    let attachment;
    try {
      attachment = await uploadImage(apiKey, image, mimeType || "image/jpeg");
    } catch (uploadErr) {
      return new Response(
        JSON.stringify({ error: `Image upload failed: ${uploadErr.message}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 2: Query the bot with the image
    const prompt = buildPrompt(exchangeRate || 3200);
    const queryBody = {
      version: PROTOCOL_VERSION,
      type: "query",
      query: [
        {
          role: "user",
          content: prompt,
          content_type: "text/markdown",
          attachments: [attachment],
        },
      ],
      user_id: "",
      conversation_id: generateId(),
      message_id: generateId(),
    };

    // Poe bot query also uses raw API key (no "Bearer" prefix)
    const botRes = await fetch(`${POE_BOT_URL}${model}`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(queryBody),
    });

    if (!botRes.ok) {
      const errText = await botRes.text();
      return new Response(
        JSON.stringify({
          error: `Bot query failed (${botRes.status}): ${errText}`,
          debug: { model, attachmentUrl: attachment.url },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 3: Parse SSE response
    const rawResponse = await botRes.text();
    const translatedText = parseSSE(rawResponse);

    if (!translatedText) {
      // If SSE parsing got nothing, return raw (might be plain JSON)
      try {
        const jsonRes = JSON.parse(rawResponse);
        return new Response(
          JSON.stringify({ translation: jsonRes.text || JSON.stringify(jsonRes) }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch {
        return new Response(JSON.stringify({ translation: rawResponse || "（空白回應）" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ translation: translatedText }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Server error: ${err.message}` }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export const config = {
  path: "/api/translate",
};
