
require("dotenv").config();

const express = require("express");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview"
];

const MODEL_TIMEOUT = 8000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Поддерживаются JPEG, PNG и WEBP."));
    }
  }
});

function isTemporaryError(status, message = "") {
  const text = String(message).toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    text.includes("overloaded") ||
    text.includes("high demand") ||
    text.includes("temporarily unavailable") ||
    text.includes("timeout")
  );
}

async function askGemini(model, prompt, image, mimeType) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: image
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1800
        }
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        data.error?.message || `Ошибка Gemini: ${response.status}`
      );

      error.status = response.status;
      throw error;
    }

    const analysis = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("\n")
      .trim();

    if (!analysis) {
      throw new Error("Gemini не вернул текстовый ответ.");
    }

    return analysis;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        `Модель ${model} не ответила за ${MODEL_TIMEOUT / 1000} секунд.`
      );

      timeoutError.status = 408;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/", (req, res) => {
  res.json({
    service: "AI ZOOM",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "AI ZOOM",
    ai: "Gemini",
    fallbackModels: MODELS.length,
    modelTimeoutSeconds: MODEL_TIMEOUT / 1000
  });
});

app.post("/analyze", upload.single("photo"), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "Не указан GEMINI_API_KEY."
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "Фотография не получена."
    });
  }

  const base64Image = req.file.buffer.toString("base64");

  const prompt = `
Ты — интеллектуальная система анализа фотографий AI ZOOM.
Внимательно изучи фотографию.

1. Определи видимые объекты.
2. Опиши сцену.
3. Обрати внимание на мелкие детали.
4. Если есть текст, попробуй его прочитать.
5. Оцени резкость, шум и освещение.
6. Разделяй факты и предположения.
7. Не выдумывай детали.

Отвечай на русском языке и структурируй ответ.
`;

  let lastError = null;

  for (let index = 0; index < MODELS.length; index++) {
    const model = MODELS[index];

    console.log(
      `[AI ZOOM] Модель ${index + 1}/${MODELS.length}: ${model}`
    );

    try {
      const analysis = await askGemini(
        model,
        prompt,
        base64Image,
        req.file.mimetype
      );

      console.log(`[AI ZOOM] Успешный ответ: ${model}`);

      return res.json({
        success: true,
        model,
        analysis
      });

    } catch (error) {
      lastError = error;

      console.error(
        `[AI ZOOM] ${model}: ${error.message}`
      );

      if (!isTemporaryError(error.status, error.message)) {
        console.error("[AI ZOOM] Ошибка не временная, проверяем следующую модель.");
      } else {
        console.log("[AI ZOOM] Модель недоступна, переключаемся дальше.");
      }
    }
  }

  console.error("[AI ZOOM] Все модели исчерпаны.");

  if (!res.headersSent) {
    return res.status(503).json({
      success: false,
      error: "Все резервные модели Gemini временно недоступны. Попробуй позже.",
      triedModels: MODELS
    });
  }
});

app.use((error, req, res, next) => {
  console.error("[AI ZOOM] Ошибка сервера:", error.message);

  if (!res.headersSent) {
    res.status(400).json({
      success: false,
      error: error.message || "Ошибка загрузки фотографии."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AI ZOOM SERVER");
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Резервных моделей: ${MODELS.length}`);
  console.log(`Тайм-аут модели: ${MODEL_TIMEOUT / 1000} секунд`);
});
