
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isTemporaryError(status, message = "") {
  const text = message.toLowerCase();

  return (
    [408, 429, 500, 502, 503, 504].includes(status) ||
    text.includes("overloaded") ||
    text.includes("high demand") ||
    text.includes("temporarily unavailable")
  );
}

async function askGemini(model, prompt, image, mimeType) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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
    signal: AbortSignal.timeout(90000)
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
    fallbackModels: MODELS.length
  });
});

app.post("/analyze", upload.single("photo"), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Не указан GEMINI_API_KEY."
    });
  }

  if (!req.file) {
    return res.status(400).json({
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

  for (const model of MODELS) {
    // Две попытки для каждой модели при временной перегрузке.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `Пробуем ${model}, попытка ${attempt}/2`
        );

        const analysis = await askGemini(
          model,
          prompt,
          base64Image,
          req.file.mimetype
        );

        console.log(`Успешный ответ от ${model}`);

        return res.json({
          success: true,
          model,
          analysis
        });

      } catch (error) {
        lastError = error;

        console.error(
          `${model}, попытка ${attempt}:`,
          error.message
        );

        const temporary = isTemporaryError(
          error.status,
          error.message
        );

        // Если ошибка не временная, пробуем следующую модель.
        if (!temporary) {
          break;
        }

        // При временной ошибке ждём и повторяем запрос.
        if (attempt < 2) {
          await sleep(1200);
        }
      }
    }
  }

  console.error("Все модели Gemini недоступны:", lastError);

  const message = lastError?.message || "Все модели временно недоступны.";

  return res.status(503).json({
    success: false,
    error: `Не удалось получить ответ от Gemini. ${message}`,
    triedModels: MODELS
  });
});

app.use((error, req, res, next) => {
  console.error("Ошибка сервера:", error.message);

  res.status(400).json({
    error: error.message || "Ошибка загрузки фотографии."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AI ZOOM SERVER");
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log("Резервные модели Gemini включены.");
});
