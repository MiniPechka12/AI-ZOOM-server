
require("dotenv").config();

const express = require("express");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

const ANALYSIS_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview"
];

const IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image"
];

const ANALYSIS_TIMEOUT = 8000;
const IMAGE_TIMEOUT = 90000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

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
    text.includes("timeout") ||
    text.includes("rate limit") ||
    text.includes("resource exhausted")
  );
}

async function geminiRequest(model, parts, timeout, generationConfig) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Не указан GEMINI_API_KEY.");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts
        }],
        generationConfig
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

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        `Модель ${model} не ответила за ${timeout / 1000} секунд.`
      );

      timeoutError.status = 408;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function askGemini(model, prompt, image, mimeType) {
  const data = await geminiRequest(
    model,
    [
      { text: prompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      }
    ],
    ANALYSIS_TIMEOUT,
    {
      temperature: 0.3,
      maxOutputTokens: 1800
    }
  );

  const analysis = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("\n")
    .trim();

  if (!analysis) {
    throw new Error("Gemini не вернул текстовый ответ.");
  }

  return analysis;
}

async function enhanceWithGemini(model, image, mimeType) {
  const prompt = `
You are a careful photo restoration assistant.

Edit the supplied photograph with a conservative restoration approach.

STRICT REQUIREMENTS:
- Preserve the original scene and composition.
- Do not add, remove, replace, or move any objects.
- Do not change faces, identity, facial features, expressions, or body proportions.
- Do not rewrite, invent, or alter any text, signs, labels, or numbers.
- Do not change clothing, background, architecture, or object shapes.
- Do not apply artistic styles or cinematic effects.
- Do not create imaginary details.

Only make restrained image-quality improvements:
- reduce visible digital noise;
- improve natural sharpness;
- improve clarity without artificial edges;
- correct mild exposure and white balance issues;
- preserve natural colors and realistic textures.

The result must look like the same original photograph,
with only subtle technical quality improvements.

Return the edited photograph, not a description.
`;

  const data = await geminiRequest(
    model,
    [
      { text: prompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      }
    ],
    IMAGE_TIMEOUT,
    {
      responseModalities: ["IMAGE"]
    }
  );

  const parts = data.candidates?.[0]?.content?.parts || [];

  const imagePart = parts.find(
    part => part.inlineData?.data || part.inline_data?.data
  );

  if (!imagePart) {
    throw new Error("Модель не вернула обработанное изображение.");
  }

  const inlineData = imagePart.inlineData || imagePart.inline_data;

  return {
    image: inlineData.data,
    mimeType: inlineData.mimeType || inlineData.mime_type || "image/png"
  };
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
    analysisModels: ANALYSIS_MODELS,
    imageModels: IMAGE_MODELS,
    features: {
      analysis: true,
      cloudEnhancement: true,
      offlineEnhancement: false
    }
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

  for (let index = 0; index < ANALYSIS_MODELS.length; index++) {
    const model = ANALYSIS_MODELS[index];

    console.log(
      `[AI ZOOM] Анализ ${index + 1}/${ANALYSIS_MODELS.length}: ${model}`
    );

    try {
      const analysis = await askGemini(
        model,
        prompt,
        base64Image,
        req.file.mimetype
      );

      console.log(`[AI ZOOM] Анализ выполнен: ${model}`);

      return res.json({
        success: true,
        model,
        analysis
      });
    } catch (error) {
      console.error(`[AI ZOOM] ${model}: ${error.message}`);

      if (!isTemporaryError(error.status, error.message)) {
        console.log("[AI ZOOM] Проверяем следующую модель.");
      }
    }
  }

  return res.status(503).json({
    success: false,
    error: "Все модели анализа временно недоступны."
  });
});

app.post("/enhance", upload.single("photo"), async (req, res) => {
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

  for (let index = 0; index < IMAGE_MODELS.length; index++) {
    const model = IMAGE_MODELS[index];

    console.log(
      `[AI ZOOM] Улучшение ${index + 1}/${IMAGE_MODELS.length}: ${model}`
    );

    try {
      const result = await enhanceWithGemini(
        model,
        base64Image,
        req.file.mimetype
      );

      console.log(`[AI ZOOM] Изображение обработано: ${model}`);

      return res.json({
        success: true,
        model,
        mimeType: result.mimeType,
        image: result.image
      });
    } catch (error) {
      console.error(`[AI ZOOM] Ошибка ${model}: ${error.message}`);

      if (!isTemporaryError(error.status, error.message)) {
        console.log("[AI ZOOM] Проверяем резервную модель.");
      }
    }
  }

  return res.status(503).json({
    success: false,
    error: "Все облачные модели улучшения временно недоступны."
  });
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
  console.log(`Моделей анализа: ${ANALYSIS_MODELS.length}`);
  console.log(`Моделей улучшения: ${IMAGE_MODELS.length}`);
});
