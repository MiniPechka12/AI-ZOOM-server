
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

// Две модели для улучшения фотографий
const IMAGE_MODELS = [
  {
    id: "pro",
    name: "gemini-3-pro-image"
  },
  {
    id: "flash",
    name: "gemini-3.1-flash-image"
  }
];

// Защита от случайных платных запросов.
// По умолчанию обработка отключена.
const PAID_IMAGE_MODELS_ENABLED =
  process.env.ENABLE_PAID_IMAGE_MODELS === "true";

const ANALYSIS_TIMEOUT = 20000;
const IMAGE_TIMEOUT = 180000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
});

function createTimeout(timeout) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  return {
    controller,
    timer
  };
}

async function geminiRequest(
  model,
  parts,
  timeout,
  generationConfig
) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Не указан GEMINI_API_KEY.");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const { controller, timer } = createTimeout(timeout);

  try {
    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },

      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],

        generationConfig
      }),

      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        data.error?.message ||
        `Gemini HTTP ${response.status}`
      );

      error.status = response.status;

      throw error;
    }

    return data;

  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Модель ${model}: превышено время ожидания.`
      );
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

// ======================================
// АНАЛИЗ ФОТОГРАФИЙ
// ======================================

async function askGemini(
  model,
  prompt,
  image,
  mimeType
) {
  const data = await geminiRequest(
    model,

    [
      {
        text: prompt
      },

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
    throw new Error("Gemini не вернул текст.");
  }

  return analysis;
}

// ======================================
// ОБЩИЙ ПРОМПТ УЛУЧШЕНИЯ
// ======================================

function getEnhancementPrompt() {
  return `
You are a professional photographic restoration AI.

Carefully edit the supplied original photograph.

MAIN GOAL:
Improve technical image quality while keeping the photograph
as close as possible to the original.

STRICT PRESERVATION:
- Preserve the exact identity of every person.
- Preserve facial features and expressions.
- Preserve proportions and natural appearance.
- Preserve all objects and their positions.
- Preserve clothing and accessories.
- Preserve background and architecture.
- Preserve text, signs, labels and numbers.
- Preserve the original composition.
- Do not add or remove anything.
- Do not invent invisible details.
- Do not stylize the photograph.

QUALITY IMPROVEMENTS:
- Reduce digital noise.
- Reduce compression artifacts.
- Improve natural sharpness.
- Improve local clarity.
- Restore realistic textures.
- Correct mild exposure problems.
- Correct mild white balance problems.
- Preserve natural colors.
- Avoid halos and oversharpening.
- Avoid artificial skin textures.

IMPORTANT:
Do not redesign the photograph.
Do not create a different interpretation of the scene.
Make the smallest useful improvements necessary.

Return the edited image.
`;
}

// ======================================
// УЛУЧШЕНИЕ ОДНОЙ ФОТОГРАФИИ
// ======================================

async function enhanceWithGemini(
  model,
  image,
  mimeType
) {
  console.log(`[AI ZOOM] Запуск ${model.name}`);

  const data = await geminiRequest(
    model.name,

    [
      {
        text: getEnhancementPrompt()
      },

      {
        inline_data: {
          mime_type: mimeType,
          data: image
        }
      }
    ],

    IMAGE_TIMEOUT,

    {
      responseModalities: ["TEXT", "IMAGE"]
    }
  );

  const candidates = data.candidates || [];

  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];

    for (const part of parts) {
      const inlineData =
        part.inlineData || part.inline_data;

      if (inlineData?.data) {
        console.log(
          `[AI ZOOM] ${model.name}: изображение получено`
        );

        return {
          model: model.name,

          mimeType:
            inlineData.mimeType ||
            inlineData.mime_type ||
            "image/png",

          image: inlineData.data
        };
      }
    }
  }

  const reason = candidates[0]?.finishReason;

  throw new Error(
    `Модель ${model.name} не вернула изображение. Причина: ${reason || "неизвестна"}`
  );
}

// ======================================
// ГЛАВНАЯ СТРАНИЦА
// ======================================

app.get("/", (req, res) => {
  res.json({
    service: "AI ZOOM",
    status: "online"
  });
});

// ======================================
// ПРОВЕРКА СЕРВЕРА
// ======================================

app.get("/health", (req, res) => {
  res.json({
    service: "AI ZOOM",

    status: "online",

    analysisModels: ANALYSIS_MODELS,

    imageModels: IMAGE_MODELS,

    paidImageModelsEnabled:
      PAID_IMAGE_MODELS_ENABLED,

    features: {
      analysis: true,
      parallelEnhancement: true,
      offlineEnhancement: false
    }
  });
});

// ======================================
// АНАЛИЗ
// ======================================

app.post(
  "/analyze",
  upload.single("photo"),
  async (req, res) => {

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Не указан GEMINI_API_KEY."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Фотография не получена или имеет неподдерживаемый формат."
      });
    }

    const image =
      req.file.buffer.toString("base64");

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

Отвечай на русском языке.
`;

    for (const model of ANALYSIS_MODELS) {
      console.log(`[AI ZOOM] Анализ: ${model}`);

      try {
        const analysis = await askGemini(
          model,
          prompt,
          image,
          req.file.mimetype
        );

        return res.json({
          success: true,
          model,
          analysis
        });

      } catch (error) {
        console.error(
          `[AI ZOOM] Анализ ${model}:`,
          error.message
        );
      }
    }

    return res.status(503).json({
      success: false,
      error: "Все модели анализа временно недоступны."
    });
  }
);

// ======================================
// ПАРАЛЛЕЛЬНОЕ УЛУЧШЕНИЕ
// ======================================

app.post(
  "/enhance",
  upload.single("photo"),
  async (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Фотография не получена или имеет неподдерживаемый формат."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Не указан GEMINI_API_KEY."
      });
    }

    // Защита от случайных расходов
    if (!PAID_IMAGE_MODELS_ENABLED) {
      return res.status(403).json({
        success: false,
        paidDisabled: true,
        error: "Генерация изображений отключена для защиты от платных запросов."
      });
    }

    const originalImage =
      req.file.buffer.toString("base64");

    const mimeType = req.file.mimetype;

    console.log(
      `[AI ZOOM] Получено фото: ${mimeType}, ${req.file.size} байт`
    );

    console.log(
      "[AI ZOOM] Запускаю две модели параллельно."
    );

    // Обе модели получают ОРИГИНАЛЬНУЮ фотографию.
    // Ни одна модель не использует результат другой.

    const tasks = IMAGE_MODELS.map(model =>
      enhanceWithGemini(
        model,
        originalImage,
        mimeType
      )
    );

    const settled = await Promise.allSettled(tasks);

    const results = {};

    for (let i = 0; i < IMAGE_MODELS.length; i++) {
      const model = IMAGE_MODELS[i];

      const result = settled[i];

      if (result.status === "fulfilled") {
        results[model.id] = {
          success: true,
          ...result.value
        };

      } else {
        console.error(
          `[AI ZOOM] ${model.name}:`,
          result.reason.message
        );

        results[model.id] = {
          success: false,
          model: model.name,
          error: result.reason.message
        };
      }
    }

    const anySuccess =
      results.pro.success ||
      results.flash.success;

    console.log(
      `[AI ZOOM] Pro: ${results.pro.success ? "OK" : "ERROR"}`
    );

    console.log(
      `[AI ZOOM] Flash: ${results.flash.success ? "OK" : "ERROR"}`
    );

    return res.status(anySuccess ? 200 : 502).json({
      success: anySuccess,

      results
    });
  }
);

// ======================================
// ОБРАБОТКА ОШИБОК
// ======================================

app.use((error, req, res, next) => {
  console.error(
    "[AI ZOOM] Ошибка сервера:",
    error.message
  );

  if (!res.headersSent) {
    res.status(400).json({
      success: false,
      error: error.message ||
        "Ошибка загрузки фотографии."
    });
  }
});

// ======================================
// ЗАПУСК
// ======================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("       AI ZOOM SERVER");
  console.log("================================");

  console.log(`Сервер запущен на порту ${PORT}`);

  console.log(
    `Моделей анализа: ${ANALYSIS_MODELS.length}`
  );

  console.log("Модели улучшения:");

  IMAGE_MODELS.forEach(model => {
    console.log(`- ${model.name}`);
  });

  console.log(
    `Платная обработка включена: ${PAID_IMAGE_MODELS_ENABLED}`
  );

  console.log("================================");
});
