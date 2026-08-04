// ═══════════════════════════════════════════════════════════════════
//  MAPCG Web Engine — Vercel Serverless Function (Node.js)
//  Прокси к Google Gemini API  —  УЛУЧШЕННАЯ ВЕРСИЯ (build-quality v3)
//
//  Что добавлено/улучшено для РЕАЛЬНОГО качества построек:
//    1. Серверная валидация JSON ответа с АВТО-КОРРЕКЦИЕЙ: если модель
//       вернула битый/пустой JSON, прокси сам делает ещё один запрос,
//       сообщает модели ошибку и просит выдать только валидный {plan,cubes}.
//       → резко снижает долю кривых построек (раньше мусор уходил клиенту).
//    2. Несколько попыток коррекции (до 2), т.к. и сама модель иногда
//       ошибается на первом заходе.
//    3. Модели вынесены в env (GEMINI_BUILD_MODEL / GEMINI_VISION_MODEL /
//       GEMINI_FALLBACK_MODEL) — можно поднять качество, не трогая код.
//    4. Опциональный responseSchema (ENABLE_RESPONSE_SCHEMA=1) —
//       принудительная JSON-схема {plan,cubes[]} на стороне модели.
//    5. Корректная связка schema+thinking: при включённой схеме thinking
//       отключается, чтобы не ловить известное зависание у части моделей.
//    6. Модели по умолчанию обновлены на актуальные GA-версии
//       (gemini-3.6-flash / gemini-3.5-flash-lite) — см. комментарий
//       у констант MODEL_BUILD/MODEL_VISION/FALLBACK_MODEL ниже.
//    7. temperature больше не отправляется для моделей линейки Gemini 3.5+
//       (Google официально считает temperature/top_p/top_k deprecated для
//       них и рекомендует не трогать — see buildGenerationConfig/shouldSendTemperature).
//
//  Переменные окружения (настрой в Vercel Dashboard → Environment Variables):
//    GEMINI_API_KEY       — основной ключ (если нет GEMINI_API_KEY_1..10)
//    GEMINI_API_KEY_1..10 — до 10 ключей для ротации (приоритет)
//    GEMINI_BUILD_MODEL   — модель для СБОРКИ (по умолч. gemini-3.6-flash)
//    GEMINI_VISION_MODEL  — модель для картинок (по умолч. gemini-3.6-flash)
//    GEMINI_FALLBACK_MODEL— запасная модель (по умолч. gemini-3.5-flash-lite)
//    ENABLE_RESPONSE_SCHEMA — "1" чтобы включить принудительную схему JSON
//    ALLOWED_ORIGINS      — опционально: список разрешённых Origin через запятую
//
//  Деплой: просто подключи репозиторий к Vercel или запусти `vercel --prod`
// ═══════════════════════════════════════════════════════════════════

const https = require("https");
const http = require("http");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Модели вынесены в env — можно переключать качество без правки кода.
//
// ── АКТУАЛЬНОСТЬ МОДЕЛЕЙ (проверено на дату правки) ────────────────
// gemini-3.1-flash-lite — Google официально объявила эту модель устаревшей,
// дата отключения назначена на 16 октября 2026. Она пока отвечает, но это
// модель "на выход"; для новой сборки использовать её как основную не стоит.
// Актуальные GA (generally available, "боевые") модели на замену:
//   gemini-3.6-flash       — основная линейка, GA. Лучше держит инструкции,
//                             меньше "зацикливаний" в агентных/многошаговых
//                             задачах, качественнее в пространственных/
//                             структурных рассуждениях — то, что нужно для
//                             генерации геометрии из кубов. Обгоняет по
//                             бенчмаркам даже более старую gemini-2.5-pro.
//   gemini-3.5-flash-lite  — GA, самая быстрая/дешёвая модель линейки 3.5,
//                             хороший выбор на роль fallback: если основная
//                             модель перегружена (502/503), эта отвечает
//                             быстро и почти всегда доступна.
// Если Google в будущем выпустит более новую стабильную модель, задайте её
// через переменные окружения ниже — код не нужно трогать.
const MODEL_BUILD = process.env.GEMINI_BUILD_MODEL || "gemini-3.6-flash";
const MODEL_VISION = process.env.GEMINI_VISION_MODEL || "gemini-3.6-flash";
// Fallback — сознательно ДРУГАЯ модель (не копия основной), чтобы при сбое
// именно build-модели на стороне Google (перегрузка/инцидент) запрос ушёл на
// независимо обслуживаемую модель, а не наткнулся на тот же самый сбой.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";

// Принудительная схема JSON (опционально). По умолчанию выключена, чтобы
// гарантированно не сломать работающий поток; включить можно env-переменной.
const ENABLE_SCHEMA = process.env.ENABLE_RESPONSE_SCHEMA === "1";

// Схема выходного JSON для сборки. Принуждает модель вернуть именно
// {"plan": "...", "cubes": [ ... ]}, а не произвольный текст.
const BUILD_SCHEMA = {
  type: "OBJECT",
  properties: {
    plan: { type: "STRING" },
    cubes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          tag: { type: "STRING" },
          tileMode: { type: "INTEGER" },
          materialName: { type: "STRING" },
          visible: { type: "BOOLEAN" },
          collisions: { type: "BOOLEAN" },
          physics: { type: "BOOLEAN" },
          position: { type: "OBJECT", properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, z: { type: "NUMBER" } } },
          rotation: { type: "OBJECT", properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, z: { type: "NUMBER" } } },
          scale: { type: "OBJECT", properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, z: { type: "NUMBER" } } },
        },
      },
    },
  },
};

// ── Утилиты ──────────────────────────────────────────────────────

function buildThinkingConfig(modelName, highEffort) {
  // Gemini 3.x использует thinkingLevel вместо thinkingBudget.
  // Нельзя передавать оба параметра одновременно — Gemini вернёт ошибку.
  if (/^gemini-3/.test(modelName))
    return { thinkingLevel: highEffort ? "high" : "low" };
  if (/^gemini-2\.5/.test(modelName))
    return { thinkingBudget: highEffort ? 8192 : 0 };
  return null;
}

// Начиная с Gemini 3.5 Flash / 3.6 Flash (и всех более новых моделей серии),
// Google официально считает temperature/top_p/top_k deprecated — их значения
// по умолчанию уже настроены под внутренние reasoning-механизмы модели, и
// ручная правка может УХУДШИТЬ качество структурированных ответов вместо
// улучшения. Поэтому для этих моделей параметр не отправляется вовсе.
// Для более старых моделей (2.x и ранний 3.1) temperature всё ещё осмысленна
// и оставлена как управляемый параметр.
function shouldSendTemperature(modelName) {
  if (/^gemini-3\.[5-9]/.test(modelName)) return false; // 3.5, 3.6, ...
  if (/^gemini-[4-9]/.test(modelName)) return false;    // будущие поколения
  return true;
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

// ✦ ВАЛИДАЦИЯ ответа сборки: проверяет, что текст — это валидный JSON
// с непустым массивом cubes, и что кубы выглядят как кубы (есть position/scale).
// Возвращает { ok, issue?, cubes?, cubesCount?, plan? }.
function validateBuildText(text) {
  const t = (text || "").trim();
  if (!t) return { ok: false, issue: "empty response" };
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch (e) {
    return { ok: false, issue: "invalid JSON: " + (e?.message || "parse error") };
  }
  const cubes = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.cubes) ? parsed.cubes : null);
  if (!cubes || !cubes.length) {
    return { ok: false, issue: "no non-empty cubes array" };
  }
  const sample = cubes[0];
  if (!sample || typeof sample !== "object" ||
      !sample.position || !sample.scale) {
    return { ok: false, issue: "cube entries missing position/scale" };
  }
  return {
    ok: true,
    cubes,
    cubesCount: cubes.length,
    plan: (parsed && typeof parsed.plan === "string") ? parsed.plan : null,
  };
}

// ✦ ФОРМИРУЕТ корректирующий запрос: сообщает модели, что её прошлый ответ
// не распарсился, и просит вернуть ТОЛЬКО валидный JSON. Не раздувает контекст.
function buildCorrectionUser(issue, prevText) {
  let note = "";
  const t = (prevText || "").trim();
  if (t.length > 0 && t.length <= 4000) note = "\nYour previous (invalid) output was:\n" + t;
  else if (t.length > 4000) note = "\nYour previous output was large and is not replayed.";
  return `Your previous reply could not be parsed as valid JSON (${issue}).${note}
Please reply with a SINGLE valid JSON object of the form {"plan":"...","cubes":[ ... ]}.
Use only valid JSON: no code fences, no trailing commas, no commentary outside the object.
Every cube must have position/rotation/scale as {x,y,z} and a valid materialName from the provided list.
Keep the SAME object, structure, and level of detail as your previous attempt — only fix the JSON formatting/syntax problem, do not simplify the build or drop parts to make the JSON shorter.`;
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

  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve());
    req.on("error", (err) => reject(err));
  });
  const bodyRaw = Buffer.concat(chunks).toString("utf8");

  if (bodyRaw.length > 5.5 * 1024 * 1024) {
    res
      .writeHead(413, { "Content-Type": "application/json", ...cors })
      .end(JSON.stringify({ error: "Request payload too large. Try attaching fewer or smaller images." }));
    return;
  }

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
    const useSchema = !isVision && ENABLE_SCHEMA;
    const cfg = {
      maxOutputTokens: maxOutputTokens,
    };
    // temperature: только если пользователь явно её передал, ИЛИ модель не
    // входит в семейство, где Google просит оставить параметр нетронутым
    // (см. shouldSendTemperature). Явный body.temperature всегда уважается —
    // это осознанный выбор вызывающей стороны (например, коррекция JSON).
    if (typeof body.temperature === "number") {
      cfg.temperature = body.temperature;
    } else if (shouldSendTemperature(modelName)) {
      cfg.temperature = isVision ? 0.3 : 0.4;
    }
    // При включённой схеме отключаем thinking — избегаем известного зависания
    // связки responseMimeType=json + thinkingConfig у части моделей.
    // Структуру JSON в этом случае держит сама схема.
    if (!useSchema) {
      const thinkingConfig = buildThinkingConfig(modelName, highEffort);
      if (thinkingConfig) cfg.thinkingConfig = thinkingConfig;
    }
    if (!isVision) cfg.responseMimeType = "application/json";
    if (useSchema) cfg.responseSchema = BUILD_SCHEMA;
    return cfg;
  }

  const payloadBase = { contents };
  if (systemText) payloadBase.systemInstruction = { parts: [{ text: systemText }] };

  async function callGemini(modelName, apiKey, overrideConfig) {
    const t0 = Date.now();
    const generationConfig = overrideConfig
      ? { ...buildGenerationConfig(modelName), ...overrideConfig }
      : buildGenerationConfig(modelName);
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
        generationConfig,
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
        await sleep(600);
    }

    // Проход 2: если 502/503 — пробуем FALLBACK немедленно
    if (lastResult && OVERLOADED.includes(lastResult.resp.status) && usedModel !== FALLBACK_MODEL) {
      for (let i = 0; i < apiKeys.length; i++) {
        const result = await callGemini(FALLBACK_MODEL, apiKeys[i]);
        if (result.resp.status !== 429 && !OVERLOADED.includes(result.resp.status))
          return { ...result, usedModel: FALLBACK_MODEL };
        lastResult = { ...result, usedModel: FALLBACK_MODEL };
        if (i < apiKeys.length - 1) await sleep(600);
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
    // Fail fast on overloaded keys/models instead of sleeping up to 90s.
    const waitMs = Math.min(minRetryMs ?? 12000, 15000);
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

    let out = toOpenAIResponse(geminiData);

    // ✦ САМОИСЦЕЛЕНИЕ для сборки: если ответ не прошёл валидацию как
    // JSON с cubes[] — делаем до MAX_FIX попыток корректирующего запроса.
    let fixedCount = 0;
    let content = out.choices[0]?.message?.content || "";
    const isBuild = !isVision;

    if (isBuild) {
      const MAX_FIX = 2;
      let validation = content ? validateBuildText(content) : { ok: false, issue: "empty response" };
      while (!validation.ok && fixedCount < MAX_FIX) {
        const correctionUser = buildCorrectionUser(validation.issue, content);
        // Делаем отдельный запрос к той же модели с корректирующим сообщением.
        const fixMessages = [
          ...messages.filter((m) => m.role !== "assistant"),
          { role: "user", content: correctionUser },
        ];
        const fixSystem = systemText;
        const fixPayload = { contents: toGeminiRequest(fixMessages).contents };
        if (fixSystem) fixPayload.systemInstruction = { parts: [{ text: fixSystem }] };

        let fixOk = false;
        let fixText = "";
        for (const tryModel of [usedModel, FALLBACK_MODEL]) {
          let got = null;
          for (let k = 0; k < apiKeys.length; k++) {
            try {
              const r = await callGemini(tryModel, apiKeys[k], {
                // на коррекцию хватает меньшего лимита и больше структуры
                temperature: 0.2,
              });
              if (r.resp.status === 200) {
                try {
                  const gd = JSON.parse(r.text);
                  fixText = toOpenAIResponse(gd).choices[0]?.message?.content || "";
                } catch { fixText = ""; }
                got = r;
                break;
              }
            } catch {}
          }
          if (got && fixText) break;
        }
        if (!fixText) {
          // не смогли получить ответ на коррекцию — отдаём как есть
          break;
        }
        content = fixText;
        out = { choices: [{ message: { role: "assistant", content: fixText }, finish_reason: "stop" }], _gemini_finish_reason: "STOP" };
        fixedCount++;
        validation = validateBuildText(content);
      }

      // Если после всех попыток всё равно нет cubes — для сборки это ошибка.
      if (!validation.ok) {
        res
          .writeHead(502, { "Content-Type": "application/json", ...cors })
          .end(
            JSON.stringify({
              error: "The model could not produce valid JSON after " + (fixedCount + 1) + " attempt(s) (" + validation.issue + ").",
              _debug: { model: usedModel, elapsedMs, fixedCount },
            })
          );
        return;
      }

      // подмешиваем свежий план (если пришёл) и число кубов в _debug
      if (validation.plan) {
        try {
          const parsed = JSON.parse(content);
          if (!parsed.plan) { parsed.plan = validation.plan; content = JSON.stringify(parsed); }
        } catch {}
      }
      out.choices[0].message.content = content;
    }

    out._debug = {
      model: usedModel,
      elapsedMs,
      finishReason: out._gemini_finish_reason,
      outputChars: (out.choices[0].message.content || "").length,
      keyCount: apiKeys.length,
      // ✦ полезная метрика: исправил ли прокси ответ модели
      autoFixed: fixedCount > 0,
      fixAttempts: fixedCount,
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
