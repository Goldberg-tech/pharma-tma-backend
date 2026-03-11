require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const axios   = require('axios');
const analogs = require('./data/analogs.json');

const app    = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pharma-tma-backend', drugs: analogs.length });
});

app.post('/recognize', upload.single('photo'), async (req, res) => {
  try {
    let imageBase64;
    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
    } else if (req.body.base64) {
      imageBase64 = req.body.base64.replace(/^data:image\/\w+;base64,/, '');
    } else {
      return res.status(400).json({ error: 'Нет изображения' });
    }

    if (!process.env.GOOGLE_VISION_KEY) {
      return res.status(500).json({ error: 'Vision API ключ не настроен' });
    }

    const visionRes = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_KEY}`,
      {
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
        }]
      },
      { timeout: 15000 }
    );

    const rawText = visionRes.data.responses[0]?.fullTextAnnotation?.text || '';
    if (!rawText) {
      return res.status(422).json({ error: 'Текст на фото не найден. Сделайте более чёткое фото.' });
    }

    const found = findDrugInText(rawText);
    if (!found) {
      return res.status(404).json({
        error: 'Лекарство не найдено на фото. Попробуйте ввести название вручную.',
        rawText: rawText.substring(0, 300)
      });
    }

    res.json(found);
  } catch (err) {
    console.error('recognize error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка распознавания: ' + (err.response?.data?.error?.message || err.message) });
  }
});

app.post('/analogs', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Нет названия' });

    console.log('Searching:', name);
    const result = findAnalogs(name);

    if (!result) {
      return res.status(404).json({ error: `«${name}» не найдено в базе` });
    }

    res.json(result);
  } catch (err) {
    console.error('analogs error:', err.message);
    res.status(500).json({ error: 'Ошибка поиска аналогов' });
  }
});

app.post('/prices', async (req, res) => {
  try {
    const { names } = req.body;
    if (!names || !names.length) return res.status(400).json({ error: 'Нет названий' });

    const prices = {};
    for (const name of names) {
      prices[name] = getStaticPrice(name);
    }

    res.json({ prices });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения цен' });
  }
});

function normalize(str) {
  return str.toLowerCase().trim().replace(/ё/g, 'е').replace(/[-\s]+/g, ' ');
}

function findDrugInText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  for (const drug of analogs) {
    const drugName   = normalize(drug.name);
    const drugActive = normalize(drug.active);
    for (const line of lines) {
      const normLine = normalize(line);
      if (normLine.includes(drugName) || (drugName.includes(normLine) && normLine.length > 3)) {
        return { name: drug.name, active: drug.active, confidence: 'high' };
      }
      if (normLine.includes(drugActive)) {
        return { name: drug.name, active: drug.active, confidence: 'medium' };
      }
    }
  }
  return null;
}

function findAnalogs(name) {
  const norm = normalize(name);
  let found = analogs.find(d => normalize(d.name) === norm);
  if (!found) found = analogs.find(d => normalize(d.active) === norm);
  if (!found) found = analogs.find(d => normalize(d.name).includes(norm) && norm.length >= 3);
  if (!found) found = analogs.find(d => norm.includes(normalize(d.name)) && normalize(d.name).length >= 3);
  if (!found) found = analogs.find(d => normalize(d.active).includes(norm) && norm.length >= 4);
  if (!found) return null;
  return buildAnalogsResult(found);
}

function buildAnalogsResult(drug) {
  const group = analogs.filter(d => normalize(d.active) === normalize(drug.active));
  return {
    original: drug.name,
    active:   drug.active,
    analogs:  group.map(d => ({ name: d.name, form: d.form || '', manufacturer: d.manufacturer || '' }))
  };
}

const STATIC_PRICES = {
  'Нурофен':{'price':'280'},
  'Ибупрофен':{'price':'45'},
  'МИГ 400':{'price':'190'},
  'Фаспик':{'price':'220'},
  'Бруфен':{'price':'260'},
  'Адвил':{'price':'310'},
  'Ибуклин':{'price':'130'},
  'Парацетамол':{'price':'35'},
  'Панадол':{'price':'140'},
  'Эффералган':{'price':'190'},
  'Цефекон Д':{'price':'80'},
  'Калпол':{'price':'160'},
  'Аспирин':{'price':'120'},
  'Ацетилсалициловая кислота':{'price':'25'},
  'Тромбо АСС':{'price':'130'},
  'Кардиомагнил':{'price':'210'},
  'Амоксициллин':{'price':'60'},
  'Флемоксин':{'price':'320'},
  'Хиконцил':{'price':'190'},
  'Аугментин':{'price':'420'},
  'Амоксиклав':{'price':'280'},
  'Азитромицин':{'price':'90'},
  'Сумамед':{'price':'520'},
  'Зитролид':{'price':'180'},
  'Азимед':{'price':'140'},
  'Хемомицин':{'price':'220'},
  'Лоратадин':{'price':'40'},
  'Кларитин':{'price':'310'},
  'ЛораГексал':{'price':'130'},
  'Эролин':{'price':'120'},
  'Цетиризин':{'price':'50'},
  'Зиртек':{'price':'380'},
  'Зодак':{'price':'210'},
  'Летизен':{'price':'160'},
  'Цетрин':{'price':'150'},
  'Омепразол':{'price':'55'},
  'Омез':{'price':'120'},
  'Лосек':{'price':'580'},
  'Гастрозол':{'price':'90'},
  'Ортанол':{'price':'200'},
  'Пантопразол':{'price':'70'},
  'Нольпаза':{'price':'290'},
  'Контролок':{'price':'480'},
  'Метформин':{'price':'65'},
  'Глюкофаж':{'price':'280'},
  'Сиофор':{'price':'230'},
  'Эналаприл':{'price':'45'},
  'Энап':{'price':'130'},
  'Ренитек':{'price':'290'},
  'Лизиноприл':{'price':'50'},
  'Диротон':{'price':'190'},
  'Симвастатин':{'price':'80'},
  'Зокор':{'price':'420'},
  'Вазилип':{'price':'260'},
  'Аторвастатин':{'price':'90'},
  'Липримар':{'price':'650'},
  'Аторис':{'price':'280'},
  'Но-шпа':{'price':'200'},
  'Дротаверин':{'price':'55'},
  'Диклофенак':{'price':'50'},
  'Вольтарен':{'price':'380'},
  'Ортофен':{'price':'65'},
  'Кетопрофен':{'price':'90'},
  'Кетонал':{'price':'280'},
  'Фастум гель':{'price':'310'},
  'Мелоксикам':{'price':'70'},
  'Мовалис':{'price':'520'},
  'Флуконазол':{'price':'55'},
  'Дифлюкан':{'price':'480'},
  'Микосист':{'price':'260'},
  'Флюкостат':{'price':'160'},
  'Сертралин':{'price':'120'},
  'Золофт':{'price':'680'},
  'Асентра':{'price':'340'},
};

function getStaticPrice(name) {
  const data = STATIC_PRICES[name];
  if (data) return { price: data.price, note: 'от', source: 'справочно' };
  return { price: null, source: 'нет данных' };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
