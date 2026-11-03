
require("dotenv").config();

const express = require("express");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get("/", (req, res) => {
  res.json({ service: "AI ZOOM", status: "online" });
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "AI ZOOM",
    ai: "Gemini"
  });
});

app.post("/analyze", upload.single("photo"), async (req, res) => {
  try {
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

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
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
                  mime_type: req.file.mimetype,
                  data: base64Image
                }
              }
            ]
          }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1800
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini error:", data);

      return res.status(response.status).json({
        error: data.error?.message || "Ошибка Gemini API."
      });
    }

    const analysis = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("\n")
      .trim();

    if (!analysis) {
      return res.status(502).json({
        error: "Gemini не вернул ответ."
      });
    }

    res.json({
      success: true,
      model: "gemini-3.8-flash",
      analysis
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message || "Внутренняя ошибка сервера."
    });
  }
});

app.use((error, req, res, next) => {
  res.status(400).json({
    error: error.message || "Ошибка загрузки фотографии."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AI ZOOM SERVER");
  console.log(`Сервер запущен на порту ${PORT}`);
});
