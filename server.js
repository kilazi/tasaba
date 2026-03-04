const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const ejs = require('ejs');

let browser = null;
async function getBrowser() {
  if (!browser) {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
  }
  return browser;
}

const app = express();
const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load data
const neighborhoodData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/neighborhoods.json'), 'utf8'));
const neighborhoods = neighborhoodData.neighborhoods;

function fmt(n) { return n.toLocaleString('en-US'); }
function getNeighborhood(slug) { return neighborhoods.find(n => n.slug === slug); }

function estimateValue(neighborhood, m2, typology) {
  const typo = neighborhood.typology[typology];
  if (!typo) return null;
  const basePrice = typo.pricePerM2 * m2;
  return { low: Math.round(basePrice * 0.88), mid: Math.round(basePrice), high: Math.round(basePrice * 1.15), pricePerM2: typo.pricePerM2 };
}

const byPrice = [...neighborhoods].sort((a, b) => b.pricePerM2.avg - a.pricePerM2.avg);
const byGrowth = [...neighborhoods].sort((a, b) => b.pricePerM2.trend - a.pricePerM2.trend);

// Generate strategy analysis from market data (no AI needed)
function generateStrategy(n, m2, estimate, typology) {
  const trend = n.pricePerM2.trend;
  const avgPrice = n.pricePerM2.avg;
  const forSale = n.inventory.forSale;
  const forRent = n.inventory.forRent;
  // Use typology-specific rent data (Q1 2026 Zonaprop/Infobae sourced)
  const rentData = n.pricePerM2Rent || {};
  const typoKey = typology === 'monoambiente' ? 'mono' : typology === 'tresAmbientes' ? 'tres' : 'dos';
  const rentPerM2 = rentData[typoKey] || rentData.avg || 11;
  const monthlyRent = Math.round(rentPerM2 * m2);
  const annualRent = monthlyRent * 12;
  const grossYield = ((annualRent / estimate.mid) * 100).toFixed(1);

  const projected1yr = Math.round(estimate.mid * (1 + trend / 100));
  const projected3yr = Math.round(estimate.mid * Math.pow(1 + trend / 100, 3));
  const projected5yr = Math.round(estimate.mid * Math.pow(1 + trend / 100, 5));

  return {
    marketTiming: trend > 8 ? 'Optimo' : trend > 4 ? 'Favorable' : trend > 0 ? 'Estable' : 'Precaucion',
    demandScore: Math.min(100, Math.round(50 + trend * 4 + (forRent / (forSale + 1)) * 10)),
    competitiveProperties: forSale,
    sellVsWait: {
      recommendation: trend > 6 ? 'Vender ahora' : trend > 3 ? 'Buen momento para vender' : 'Considerar esperar 12-18 meses',
      confidence: trend > 6 ? 'Alta' : trend > 3 ? 'Media-Alta' : 'Media',
      reason: trend > 6
        ? `El mercado en ${n.name} esta en su punto mas alto con una apreciacion de +${trend}% anual. Los compradores estan activos y la demanda supera la oferta en las tipologias mas buscadas. Vender ahora permite capitalizar el momentum.`
        : trend > 3
        ? `${n.name} muestra crecimiento sostenido de +${trend}% anual. El mercado es favorable para vendedores, con buena absorcion de inventario. Es un buen momento para listar.`
        : `Con una tendencia de +${trend}%, el mercado sugiere que esperar 12-18 meses podria aumentar tu retorno en $${fmt(projected1yr - estimate.mid)}. Sin embargo, si necesitas liquidez, el mercado actual es aceptable.`,
      projected1yr,
      projected3yr,
      projected5yr,
      waitGain1yr: projected1yr - estimate.mid,
      waitGain3yr: projected3yr - estimate.mid,
      yearOverYear: [
        { year: 2026, price: estimate.mid },
        { year: 2027, price: projected1yr },
        { year: 2028, price: Math.round(estimate.mid * Math.pow(1 + trend / 100, 2)) },
        { year: 2029, price: projected3yr },
        { year: 2030, price: Math.round(estimate.mid * Math.pow(1 + trend / 100, 4)) },
        { year: 2031, price: projected5yr }
      ]
    },
    renovationAdvice: {
      recommendation: estimate.pricePerM2 < avgPrice * 0.95 ? 'Renovar antes de vender' : 'Vender en estado actual',
      confidence: estimate.pricePerM2 < avgPrice * 0.95 ? 'Alta' : 'Media',
      reason: estimate.pricePerM2 < avgPrice * 0.95
        ? `Tu propiedad esta valuada por debajo del promedio del barrio ($${fmt(avgPrice)}/m2 vs tu $${fmt(estimate.pricePerM2)}/m2). Una renovacion estrategica de cocina y bano puede aumentar el valor entre 10-18%, generando un retorno positivo sobre la inversion.`
        : `Tu propiedad esta alineada con el mercado. Renovaciones mayores no generarian un retorno suficiente. Recomendamos mejoras cosmeticas: pintura fresca, iluminacion LED, staging profesional — costo bajo con alto impacto en la percepcion del comprador.`,
      estimatedCost: Math.round(m2 * 150),
      estimatedValueIncrease: Math.round(estimate.mid * 0.12),
      roi: Math.round(((estimate.mid * 0.12) / (m2 * 150)) * 100),
      quickWins: [
        { item: 'Pintura completa', cost: Math.round(m2 * 15), impact: '+3-5% valor' },
        { item: 'Iluminacion LED', cost: Math.round(m2 * 8), impact: '+1-2% valor' },
        { item: 'Renovacion bano', cost: Math.round(m2 * 45), impact: '+4-6% valor' },
        { item: 'Staging profesional', cost: Math.round(m2 * 12), impact: '+2-4% percepcion' }
      ]
    },
    rentAnalysis: {
      monthlyRent,
      annualRent,
      grossYield: parseFloat(grossYield),
      recommendation: parseFloat(grossYield) > 5 ? 'Alquilar es competitivo frente a vender' : 'Vender tiene mejor retorno inmediato',
      sell: {
        immediateCapital: estimate.mid,
        reinvestmentYield: '5.5% anual (estimado)',
        annualPassiveIncome: Math.round(estimate.mid * 0.055),
        pros: ['Capital inmediato para reinvertir', 'Sin costos de mantenimiento', 'Sin riesgo de vacancia'],
        cons: ['Pierdes el activo fisico', 'Costos de escrituracion 3-5%', 'Impuesto a las ganancias']
      },
      shortTerm: {
        monthlyEstimate: Math.round(monthlyRent * 2.2),
        occupancyRate: '65-75%',
        annualGross: Math.round(monthlyRent * 2.2 * 12 * 0.70),
        annualNet: Math.round(monthlyRent * 2.2 * 12 * 0.70 * 0.72),
        netYield: ((monthlyRent * 2.2 * 12 * 0.70 * 0.72 / estimate.mid) * 100).toFixed(1),
        pros: ['Ingreso 2-3x mayor que alquiler tradicional', 'Flexibilidad de uso personal', 'Demanda turistica creciente en CABA'],
        cons: ['Gestion operativa intensiva', 'Regulacion municipal (habilitacion)', 'Desgaste acelerado del inmueble', 'Estacionalidad marcada']
      },
      longTerm: {
        monthlyEstimate: monthlyRent,
        annualGross: annualRent,
        annualNet: Math.round(annualRent * 0.88),
        netYield: ((annualRent * 0.88 / estimate.mid) * 100).toFixed(1),
        pros: ['Ingreso estable y predecible', 'Contratos de 2-3 anos', 'Menor gestion y desgaste', 'Ajuste semestral por ley'],
        cons: ['Menor rentabilidad bruta', 'Riesgo de morosidad', 'Proceso de desalojo lento', 'Actualizacion limitada por ley de alquileres']
      },
      breakEvenYears: Math.round(estimate.mid / (annualRent * 0.88)),
      verdict: parseFloat(grossYield) > 6
        ? `Con un rendimiento bruto de ${grossYield}%, alquilar tu propiedad es una opcion atractiva. El alquiler temporario ofrece mayor retorno pero requiere dedicacion. Para inversor pasivo, el alquiler tradicional es la opcion mas segura.`
        : `Con un rendimiento bruto de ${grossYield}%, la rentabilidad por alquiler es moderada para ${n.name}. Si no necesitas el ingreso mensual, vender y reinvertir podria generar mejor retorno ajustado por riesgo.`
    },
    marketInsight: forSale > 2000
      ? `${n.name} tiene alta oferta con ${fmt(forSale)} propiedades en venta. Esto genera un mercado competitivo donde el comprador tiene opciones. Es clave diferenciar tu propiedad con precio atractivo, fotos profesionales y descripcion detallada.`
      : forSale > 1000
      ? `${n.name} tiene oferta moderada (${fmt(forSale)} propiedades). La demanda se mantiene solida y las propiedades bien presentadas y correctamente valuadas se venden en 60-90 dias promedio.`
      : `${n.name} tiene baja oferta (${fmt(forSale)} propiedades). Esto favorece al vendedor — hay mas demanda que oferta. Propiedades en buena condicion se venden rapido y con poco margen de negociacion.`,
    targetBuyer: m2 < 35 ? 'Inversor o joven profesional' : m2 < 55 ? 'Pareja joven o profesional independiente' : m2 < 80 ? 'Familia en crecimiento' : 'Familia establecida o upgrade',
    timeToSell: forSale > 2000 ? '90-120 dias' : forSale > 1000 ? '60-90 dias' : '30-60 dias',
    negotiationMargin: trend > 5 ? '3-5% (mercado firme)' : '5-8% (mercado flexible)'
  };
}

// OpenAI vision call
function analyzePhotos(base64Images, propertyInfo) {
  return new Promise((resolve, reject) => {
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Sos un tasador profesional de propiedades en Buenos Aires, Argentina. Analiza estas fotos y da una evaluacion detallada y profesional.

Datos: barrio ${propertyInfo.neighborhood}, ${propertyInfo.m2}m2, ${propertyInfo.typology}, piso ${propertyInfo.floor || 'no especificado'}, amenities: ${propertyInfo.amenities || 'no especificados'}. ${propertyInfo.notes ? 'Notas del propietario: ' + propertyInfo.notes : ''}

Responde en espanol rioplatense profesional. Devuelve SOLO JSON valido con estos campos:
{
  "condition": "Excelente|Muy Bueno|Bueno|Regular|Necesita Refaccion",
  "conditionScore": 1-10,
  "style": "Moderno|Clasico|Reciclado|Standard|Minimalista|Industrial",
  "features": ["4-6 caracteristicas que ves: luminosidad, vista, terminaciones, pisos, cocina, bano, ventanas, etc"],
  "positives": ["4 aspectos positivos profesionales"],
  "negatives": ["2-3 aspectos que podrian afectar el valor negativamente"],
  "adjustment": -15 a +25 (porcentaje de ajuste sobre promedio del barrio segun lo que ves),
  "summary": "3 oraciones — resumen profesional detallado de la propiedad",
  "renovationNotes": "1-2 oraciones sobre si conviene renovar algo especifico basado en las fotos",
  "photographyTips": "1 oracion sobre como mejorar las fotos para la venta",
  "stagingAdvice": "1 oracion sobre home staging que mejoraria la presentacion"
}`
        },
        ...base64Images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${img}`, detail: 'low' }
        }))
      ]
    }];

    const body = JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 900, temperature: 0.3 });
    const req = https.request({
      hostname: 'api.openai.com', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const content = parsed.choices[0].message.content;
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
          else reject(new Error('No JSON in response'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- ROUTES ---

// Sales homepage
app.get('/', (req, res) => {
  const avgPrice = Math.round(neighborhoods.reduce((s, n) => s + n.pricePerM2.avg, 0) / neighborhoods.length);
  const totalInventory = neighborhoods.reduce((s, n) => s + n.inventory.forSale, 0);
  res.render('home', { neighborhoods, avgPrice, totalInventory, fmt, lastUpdated: neighborhoodData.lastUpdated });
});

// Pricing page
app.get('/precios', (req, res) => {
  res.render('pricing');
});

// Ranking page
app.get('/ranking', (req, res) => {
  res.render('ranking', { neighborhoods, byPrice, byGrowth, fmt, lastUpdated: neighborhoodData.lastUpdated });
});

// AI Evaluation tool
app.get('/evaluar', (req, res) => {
  res.render('evaluate', { neighborhoods, fmt });
});

// Process AI evaluation
app.post('/api/evaluate', upload.array('photos', 5), async (req, res) => {
  try {
    const { neighborhood: slug, m2, typology, floor, amenities, address, notes } = req.body;
    const n = getNeighborhood(slug);
    if (!n) return res.status(400).json({ error: 'Barrio no encontrado' });

    const sqm = parseInt(m2) || 40;
    const estimate = estimateValue(n, sqm, typology || 'dosAmbientes');

    // If photos provided and we have API key, do AI analysis
    let aiAnalysis = null;
    if (req.files && req.files.length > 0 && OPENAI_KEY) {
      const base64Images = req.files.map(f => f.buffer.toString('base64'));
      try {
        aiAnalysis = await analyzePhotos(base64Images, { neighborhood: n.name, m2: sqm, typology, floor, amenities, notes });
        // Apply AI adjustment to estimate
        if (aiAnalysis.adjustment) {
          const adj = parseFloat(aiAnalysis.adjustment) / 100;
          estimate.mid = Math.round(estimate.mid * (1 + adj));
          estimate.low = Math.round(estimate.low * (1 + adj));
          estimate.high = Math.round(estimate.high * (1 + adj));
        }
      } catch(e) {
        console.error('AI analysis failed:', e.message);
      }
    }

    // Generate strategy analysis (always, no AI needed)
    const strategy = generateStrategy(n, sqm, estimate, typology || 'dosAmbientes');

    // Teaser: show enough to hook, hide the good stuff
    const teaser = {
      neighborhood: n.name,
      zone: n.zone,
      m2: sqm,
      estimatedPrice: estimate.mid,
      priceRange: { low: estimate.low, high: estimate.high },
      neighborhoodAvg: n.pricePerM2.avg,
      trend: n.pricePerM2.trend,
      marketTiming: strategy.marketTiming,
      demandScore: strategy.demandScore,
      timeToSell: strategy.timeToSell,
      sellRecommendation: strategy.sellVsWait.recommendation,
      hasPhotos: !!(aiAnalysis)
    };

    // If AI analyzed, add teaser bits
    if (aiAnalysis) {
      teaser.condition = aiAnalysis.condition;
      teaser.conditionScore = aiAnalysis.conditionScore;
      teaser.style = aiAnalysis.style;
      teaser.adjustment = aiAnalysis.adjustment;
    }

    // Full report (gated behind lead capture)
    const fullReport = {
      ...teaser,
      address: address || '',
      typology: typology || 'dosAmbientes',
      pricePerM2: estimate.pricePerM2,
      features: aiAnalysis ? aiAnalysis.features : [],
      positives: aiAnalysis ? aiAnalysis.positives : [],
      negatives: aiAnalysis ? aiAnalysis.negatives : [],
      summary: aiAnalysis ? aiAnalysis.summary : null,
      renovationNotes: aiAnalysis ? aiAnalysis.renovationNotes : null,
      photographyTips: aiAnalysis ? aiAnalysis.photographyTips : null,
      stagingAdvice: aiAnalysis ? aiAnalysis.stagingAdvice : null,
      strategy,
      typologyBreakdown: n.typology,
      inventory: n.inventory,
      subzones: n.subzones,
      highlights: n.highlights,
      rank: byPrice.findIndex(x => x.slug === n.slug) + 1,
      totalBarrios: neighborhoods.length,
      similarBarrios: neighborhoods
        .filter(x => x.slug !== n.slug)
        .sort((a, b) => Math.abs(a.pricePerM2.avg - n.pricePerM2.avg) - Math.abs(b.pricePerM2.avg - n.pricePerM2.avg))
        .slice(0, 3)
        .map(s => ({ name: s.name, pricePerM2: s.pricePerM2.avg, trend: s.pricePerM2.trend }))
    };

    // Store evaluation for later retrieval
    const evalId = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const evalsFile = path.join(__dirname, 'data/evaluations.json');
    let evals = {};
    try { evals = JSON.parse(fs.readFileSync(evalsFile, 'utf8')); } catch(e) {}
    evals[evalId] = { fullReport, created: new Date().toISOString() };
    fs.writeFileSync(evalsFile, JSON.stringify(evals));

    res.json({ ok: true, teaser, evalId });
  } catch(e) {
    console.error('Evaluation error:', e);
    res.status(500).json({ error: 'Error al procesar la evaluacion' });
  }
});

// Unlock full report (lead capture)
app.post('/api/unlock', (req, res) => {
  const { evalId, whatsapp, email, name } = req.body;
  if (!evalId || (!whatsapp && !email)) return res.status(400).json({ error: 'Datos incompletos' });

  // Save lead
  const leadsFile = path.join(__dirname, 'data/leads.json');
  let leads = [];
  try { leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8')); } catch(e) {}
  leads.push({ evalId, name, whatsapp, email, timestamp: new Date().toISOString() });
  fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));

  // Return full report
  const evalsFile = path.join(__dirname, 'data/evaluations.json');
  let evals = {};
  try { evals = JSON.parse(fs.readFileSync(evalsFile, 'utf8')); } catch(e) {}
  const evaluation = evals[evalId];
  if (!evaluation) return res.status(404).json({ error: 'Evaluacion no encontrada' });

  res.json({ ok: true, report: evaluation.fullReport });
});

// Waitlist
app.post('/api/waitlist', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  const file = path.join(__dirname, 'data/waitlist.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  list.push({ email, timestamp: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  res.json({ ok: true });
});

// Neighborhood pages (SEO, not prominently linked)
app.get('/barrio/:slug', (req, res) => {
  const n = getNeighborhood(req.params.slug);
  if (!n) return res.status(404).render('404');
  const rank = byPrice.findIndex(x => x.slug === n.slug) + 1;
  const growthRank = byGrowth.findIndex(x => x.slug === n.slug) + 1;
  const similar = neighborhoods.filter(x => x.slug !== n.slug)
    .sort((a, b) => Math.abs(a.pricePerM2.avg - n.pricePerM2.avg) - Math.abs(b.pricePerM2.avg - n.pricePerM2.avg))
    .slice(0, 3);
  res.render('neighborhood', { n, rank, growthRank, total: neighborhoods.length, similar, fmt, lastUpdated: neighborhoodData.lastUpdated });
});

// PDF report download — Puppeteer renders HTML template to PDF
app.get('/api/report/:evalId/pdf', async (req, res) => {
  try {
    const evalsFile = path.join(__dirname, 'data/evaluations.json');
    let evals = {};
    try { evals = JSON.parse(fs.readFileSync(evalsFile, 'utf8')); } catch(e) {}
    const evaluation = evals[req.params.evalId];
    if (!evaluation) return res.status(404).json({ error: 'Evaluacion no encontrada' });

    const r = evaluation.fullReport;
    const s = r.strategy;

    // Render EJS template to HTML
    const html = await ejs.renderFile(path.join(__dirname, 'views/report-pdf.ejs'), { r, s, fmt });

    // Generate PDF with Puppeteer
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });
    await page.close();

    // Build filename from address or neighborhood
    const label = (r.address || r.neighborhood || 'propiedad')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 60);
    const filename = `TasaBA-${label}-${r.m2}m2.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(pdfBuffer);
  } catch(e) {
    console.error('PDF generation error:', e);
    res.status(500).json({ error: 'Error al generar PDF' });
  }
});

// Sitemap
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://tasaba-473141067823.us-central1.run.app';
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `<url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n`;
  xml += `<url><loc>${base}/evaluar</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>\n`;
  xml += `<url><loc>${base}/precios</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>\n`;
  neighborhoods.forEach(n => {
    xml += `<url><loc>${base}/barrio/${n.slug}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
  });
  xml += '</urlset>';
  res.type('application/xml').send(xml);
});

app.use((req, res) => { res.status(404).render('404'); });

app.listen(PORT, () => { console.log(`TasaBA running on port ${PORT}`); });
