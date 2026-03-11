require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const axios   = require('axios');
const analogs = require('./data/analogs.json');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pharma-tma-backend' });
});

// ══════════════════════════════════════════════════════════════
//  POST /recognize
//  Принимает фото (multipart) или base64 строку
//  Возвращает: { name, active, confidence }
// ══════════════════════════════════════════════════════════════
app.post('/recognize', upload.single('photo'), async (req, res) => {
  try {
    let imageBase64;

    if (req.file) {
      // Фото из формы
      imageBase64 = req.file.buffer.toString('base64');
    } else if (req.body.base64) {
      // Base64 строка
      imageBase64 = req.body.base64.replace(/^data:image\/\w+;base64,/, '');
    } else {
      return res.status(400).json({ error: 'Нет изображения' });
    }

    // Запрос к Google Vision API
    const visionRes = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_KEY}`,
      {
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
        }]
      }
    );

    const rawText = visionRes.data.responses[0]?.fullTextAnnotation?.text || '';
    if (!rawText) {
      return res.status(422).json({ error: 'Не удалось распознать текст на фото' });
    }

    // Ищем название лекарства в распознанном тексте
    const found = findDrugInText(rawText);
    if (!found) {
      return res.status(404).json({ error: 'Лекарство не найдено', rawText });
    }

    res.json(found);

  } catch (err) {
    console.error('recognize error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка распознавания' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /analogs
//  Принимает: { name } — название лекарства
//  Возвращает: { original, active, analogs: [...] }
// ══════════════════════════════════════════════════════════════
app.post('/analogs', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Нет названия' });

    const result = findAnalogs(name);
    if (!result) {
      return res.status(404).json({ error: 'Аналоги не найдены', name });
    }

    res.json(result);

  } catch (err) {
    console.error('analogs error:', err.message);
    res.status(500).json({ error: 'Ошибка поиска аналогов' });
  }
});

// ══════════════════════════════════════════════════════════════
//  POST /prices
//  Принимает: { names: ['Ибупрофен', 'Нурофен', ...] }
//  Возвращает цены с apteka.ru
// ══════════════════════════════════════════════════════════════
app.post('/prices', async (req, res) => {
  try {
    const { names } = req.body;
    if (!names || !names.length) return res.status(400).json({ error: 'Нет названий' });

    const prices = await getPrices(names);
    res.json({ prices });

  } catch (err) {
    console.error('prices error:', err.message);
    res.status(500).json({ error: 'Ошибка получения цен' });
  }
});

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function findDrugInText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const normalized = line.toLowerCase();
    for (const drug of analogs) {
      // Проверяем по торговому названию
      if (normalized.includes(drug.name.toLowerCase())) {
        return { name: drug.name, active: drug.active, confidence: 'high' };
      }
      // Проверяем по активному веществу
      if (normalized.includes(drug.active.toLowerCase())) {
        return { name: drug.name, active: drug.active, confidence: 'medium' };
      }
    }
  }
  return null;
}

function findAnalogs(name) {
  const normalized = name.toLowerCase().trim();

  // Ищем препарат по названию или активному веществу
  const found = analogs.find(d =>
    d.name.toLowerCase() === normalized ||
    d.active.toLowerCase() === normalized
  );

  if (!found) {
    // Попробуем нечёткий поиск
    const fuzzy = analogs.find(d =>
      d.name.toLowerCase().includes(normalized) ||
      normalized.includes(d.name.toLowerCase())
    );
    if (!fuzzy) return null;
    return buildAnalogsResult(fuzzy);
  }

  return buildAnalogsResult(found);
}

function buildAnalogsResult(drug) {
  // Все препараты с тем же активным веществом
  const group = analogs.filter(d =>
    d.active.toLowerCase() === drug.active.toLowerCase()
  );

  return {
    original: drug.name,
    active: drug.active,
    analogs: group.map(d => ({
      name: d.name,
      form: d.form || '',
      manufacturer: d.manufacturer || '',
    }))
  };
}

async function getPrices(names) {
  const results = {};

  for (const name of names) {
    try {
      const url = `https://www.apteka.ru/search/?q=${encodeURIComponent(name)}`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 5000,
      });

      // Простой парсинг цены из HTML
      const priceMatch = response.data.match(/(\d[\d\s]*)\s*₽/);
      results[name] = priceMatch
        ? { price: priceMatch[1].replace(/\s/g, ''), currency: '₽', source: 'apteka.ru' }
        : { price: null, source: 'apteka.ru' };

    } catch {
      results[name] = { price: null, source: 'apteka.ru' };
    }

    // Небольшая пауза между запросами
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
