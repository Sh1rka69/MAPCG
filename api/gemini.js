// ═══════════════════════════════════════════════════════════════════
//  MAPCG Web Engine — Vercel Serverless Function (Node.js)
//  Прокси к Google Gemini API с ротацией ключей, fallback-моделью
//  и обработкой rate limiting.
//
//  Переменные окружения (настрой в Vercel Dashboard → Environment Variables):
//    GEMINI_API_KEY       — основной ключ (если нет GEMINI_API_KEY_1..10)
//    GEMINI_API_KEY_1..10 — до 10 ключей для ротации (приоритет)
//    ALLOWED_ORIGINS      — опционально: список разрешённых Origin через запятую
//
//  Деплой: просто подключи репозиторий к Vercel или запусти `vercel --prod`
// ═══════════════════════════════════════════════════════════════════

const https = require("https");
const http = require("http");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_BUILD = "gemini-2.5-flash";
const MODEL_VISION = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.0-flash";

// ── Утилиты ──────────────────────────────────────────────────────

function buildThinkingConfig(modelName, highEffort) {
  if (/^gemini-2\.5/.test(modelName))
    return { thinkingBudget: highEffort ? 8192 : 0 };
  return null;
}

function getApiKeys() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  if (!keys.length && process.env.GEMINI_API_KEY?.trim())
    keys.push(process.env.GEMINI_API_KEY.trim());
  return keys;
}

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  const allowed = getAllowedOrigins();
  const allow = !allowed.length || allowed.includes(origin)
    ? origin || "*"
    : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function toGeminiRequest(messages) {
  let systemText = "";
  const contents = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n\n" : "") +
        (typeof msg.content === "string" ? msg.content : "");
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text || "" });
        } else if (part.type === "image_url") {
          const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(
            part.image_url?.url || ""
          );
          if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return { systemText, contents };
}

function toOpenAIResponse(geminiData) {
  const candidate = geminiData?.candidates?.[0];
  const finishReason = candidate?.finishReason || "unknown";
  const text = (candidate?.content?.parts || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  return {
    choices: [
      {
        message: { role: "assistant", content: text },
        finish_reason:
          finishReason === "MAX_TOKENS" ? "length" : finishReason.toLowerCase(),
      },
    ],
    _gemini_finish_reason: finishReason,
  };
}

function parseRetryDelayMs(raw) {
  try {
    const a = raw.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/);
    if (a) return Math.ceil(parseFloat(a[1]) * 1000) + 500;
    const b = raw.match(/retry in ([0-9.]+)\s*s/i);
    if (b) return Math.ceil(parseFloat(b[1]) * 1000) + 500;
  } catch {}
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * HTTPS fetch с сырым телом ответа (аналог fetch + text() в Workers).
 */
function httpsFetch(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, text });
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ── Основной обработчик Vercel ───────────────────────────────────

module.exports = async (req, res) => {
  const origin = req.headers["origin"] || "";
  const cors = corsHeaders(origin);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== "POST") {
    res
      .writeHead(405, { "Content-Type": "application/json", ...cors })
      .end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const apiKeys = getApiKeys();
  if (!apiKeys.length) {
    res
      .writeHead(500, { "Content-Type": "application/json", ...cors })
      .end(
        JSON.stringify({
          error:
            "No API keys configured. Add GEMINI_API_KEY_1 (and optionally GEMINI_API_KEY_2, GEMINI_API_KEY_3) in Vercel Dashboard → Environment Variables.",
        })
      );
    return;
  }

  // Читаем тело запроса
  let bodyRaw = "";
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => (bodyRaw += chunk));
    req.on("end", resolve);
    req.on("error", reject);
  });

  let body;
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    res
      .writeHead(400, { "Content-Type": "application/json", ...cors })
      .end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages?.length) {
    res
      .writeHead(400, { "Content-Type": "application/json", ...cors })
      .end(JSON.stringify({ error: "messages field is required" }));
    return;
  }

  const isVision = body.mode === "vision";
  const model = isVision ? MODEL_VISION : MODEL_BUILD;
  const highEffort = !isVision;

  const maxOutputTokens = Math.min(
    Math.max(
      typeof body.max_tokens === "number" ? body.max_tokens : isVision ? 1200 : 24000,
      500
    ),
    isVision ? 2000 : 32000
  );

  const { systemText, contents } = toGeminiRequest(messages);

  function buildGenerationConfig(modelName) {
    const thinkingConfig = buildThinkingConfig(modelName, highEffort);
    const cfg = {
      temperature: typeof body.temperature === "number" ? body.temperature : isVision ? 0.3 : 0.6,
      maxOutputTokens: maxOutputTokens,
    };
    if (thinkingConfig) cfg.thinkingConfig = thinkingConfig;
    if (!isVision) cfg.responseMimeType = "application/json";
    return cfg;
  }

  const payloadBase = { contents };
  if (systemText) payloadBase.systemInstruction = { parts: [{ text: systemText }] };

  async function callGemini(modelName, apiKey) {
    const t0 = Date.now();
    const result = await httpsFetch(
      `${GEMINI_BASE}/${modelName}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
      },
      JSON.stringify({
        ...payloadBase,
        generationConfig: buildGenerationConfig(modelName),
      })
    );
    return { resp: { status: result.status }, text: result.text, elapsedMs: Date.now() - t0 };
  }

  async function callWithKeyRotation(modelName) {
    const OVERLOADED = [502, 503];
    let lastResult = null;
    let minRetryMs = null;
    let usedModel = modelName;

    // Проход 1: основная модель, все ключи
    for (let i = 0; i < apiKeys.length; i++) {
      let result = await callGemini(usedModel, apiKeys[i]);

      if (result.resp.status === 404 && usedModel !== FALLBACK_MODEL) {
        usedModel = FALLBACK_MODEL;
        result = await callGemini(usedModel, apiKeys[i]);
      }

      const { status } = result.resp;

      if (status !== 429 && !OVERLOADED.includes(status))
        return { ...result, usedModel };

      if (status === 429) {
        const ms = parseRetryDelayMs(result.text);
        if (ms !== null && (minRetryMs === null || ms < minRetryMs))
          minRetryMs = ms;
      }

      lastResult = { ...result, usedModel };

      if (OVERLOADED.includes(status) && i < apiKeys.length - 1)
        await sleep(1500);
    }

    // Проход 2: если 502/503 — пробуем FALLBACK немедленно
    if (lastResult && OVERLOADED.includes(lastResult.resp.status) && usedModel !== FALLBACK_MODEL) {
      for (let i = 0; i < apiKeys.length; i++) {
        const result = await callGemini(FALLBACK_MODEL, apiKeys[i]);
        if (result.resp.status !== 429 && !OVERLOADED.includes(result.resp.status))
          return { ...result, usedModel: FALLBACK_MODEL };
        lastResult = { ...result, usedModel: FALLBACK_MODEL };
        if (i < apiKeys.length - 1) await sleep(1500);
      }
    }

    // Проход 3: все ключи на 429 — пробуем FALLBACK_MODEL
    if (usedModel !== FALLBACK_MODEL) {
      let fallbackMinRetryMs = null;
      for (let i = 0; i < apiKeys.length; i++) {
        const result = await callGemini(FALLBACK_MODEL, apiKeys[i]);
        const { status } = result.resp;
        if (status !== 429 && !OVERLOADED.includes(status))
          return { ...result, usedModel: FALLBACK_MODEL };
        if (status === 429) {
          const ms = parseRetryDelayMs(result.text);
          if (ms !== null && (fallbackMinRetryMs === null || ms < fallbackMinRetryMs))
            fallbackMinRetryMs = ms;
        }
        lastResult = { ...result, usedModel: FALLBACK_MODEL };
      }
      if (fallbackMinRetryMs !== null && (minRetryMs === null || fallbackMinRetryMs < minRetryMs))
        minRetryMs = fallbackMinRetryMs;
    }

    // Проход 4: ждём retryDelay, финальный проход
    const waitMs = Math.min(minRetryMs ?? 62000, 90000);
    await sleep(waitMs);

    for (const tryModel of [modelName, FALLBACK_MODEL]) {
      for (let i = 0; i < apiKeys.length; i++) {
        const result = await callGemini(tryModel, apiKeys[i]);
        if (result.resp.status !== 429 && !OVERLOADED.includes(result.resp.status))
          return { ...result, usedModel: tryModel };
        lastResult = { ...result, usedModel: tryModel };
      }
    }

    return lastResult;
  }

  try {
    const { resp, text: rawText, elapsedMs, usedModel } = await callWithKeyRotation(model);

    if (resp.status !== 200) {
      let errMsg = `Gemini API error (${resp.status})`;
      let retryAfterSec = null;
      try {
        const e = JSON.parse(rawText);
        if (e?.error?.message) errMsg = e.error.message;
      } catch {}
      if (resp.status === 429) {
        const ms = parseRetryDelayMs(rawText);
        retryAfterSec = ms ? Math.ceil(ms / 1000) : 65;
        errMsg = `All API keys are rate-limited. Try again in ~${retryAfterSec}s.`;
      } else if (resp.status === 502 || resp.status === 503) {
        retryAfterSec = 20;
        errMsg = `The AI model (and its fallback) are both overloaded right now. Wait about ${retryAfterSec}s and press Build again.`;
      }
      const debug = { model: usedModel, elapsedMs, keyCount: apiKeys.length };
      if (retryAfterSec !== null) debug.retryAfterSec = retryAfterSec;
      res
        .writeHead(resp.status, { "Content-Type": "application/json", ...cors })
        .end(JSON.stringify({ error: errMsg, _debug: debug }));
      return;
    }

    let geminiData;
    try {
      geminiData = JSON.parse(rawText);
    } catch {
      res
        .writeHead(502, { "Content-Type": "application/json", ...cors })
        .end(
          JSON.stringify({
            error: "Gemini returned invalid JSON",
            _debug: { model: usedModel, elapsedMs },
          })
        );
      return;
    }

    const out = toOpenAIResponse(geminiData);
    out._debug = {
      model: usedModel,
      elapsedMs,
      finishReason: out._gemini_finish_reason,
      outputChars: (out.choices[0].message.content || "").length,
      keyCount: apiKeys.length,
    };

    if (!out.choices[0].message.content && out._gemini_finish_reason === "MAX_TOKENS") {
      res
        .writeHead(502, { "Content-Type": "application/json", ...cors })
        .end(
          JSON.stringify({
            error: "Response exceeded token limit (empty MAX_TOKENS). Simplify the request.",
            _debug: { model: usedModel, elapsedMs },
          })
        );
      return;
    }

    res
      .writeHead(200, { "Content-Type": "application/json", ...cors })
      .end(JSON.stringify(out));
  } catch (err) {
    res
      .writeHead(502, { "Content-Type": "application/json", ...cors })
      .end(
        JSON.stringify({
          error: "Gemini request failed: " + (err?.message || String(err)),
        })
      );
  }
};
