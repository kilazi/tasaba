const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const PDFDocument = require('pdfkit');

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
function generateStrategy(n, m2, estimate) {
  const trend = n.pricePerM2.trend;
  const avgPrice = n.pricePerM2.avg;
  const forSale = n.inventory.forSale;
  const forRent = n.inventory.forRent;
  const rentPerM2 = (n.pricePerM2Rent && n.pricePerM2Rent.avg) || 8;
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

Datos: barrio ${propertyInfo.neighborhood}, ${propertyInfo.m2}m2, ${propertyInfo.typology}, piso ${propertyInfo.floor || 'no especificado'}, amenities: ${propertyInfo.amenities || 'no especificados'}.

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
    const { neighborhood: slug, m2, typology, floor, amenities } = req.body;
    const n = getNeighborhood(slug);
    if (!n) return res.status(400).json({ error: 'Barrio no encontrado' });

    const sqm = parseInt(m2) || 40;
    const estimate = estimateValue(n, sqm, typology || 'dosAmbientes');

    // If photos provided and we have API key, do AI analysis
    let aiAnalysis = null;
    if (req.files && req.files.length > 0 && OPENAI_KEY) {
      const base64Images = req.files.map(f => f.buffer.toString('base64'));
      try {
        aiAnalysis = await analyzePhotos(base64Images, { neighborhood: n.name, m2: sqm, typology, floor, amenities });
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
    const strategy = generateStrategy(n, sqm, estimate);

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

// PDF report download
app.get('/api/report/:evalId/pdf', (req, res) => {
  const evalsFile = path.join(__dirname, 'data/evaluations.json');
  let evals = {};
  try { evals = JSON.parse(fs.readFileSync(evalsFile, 'utf8')); } catch(e) {}
  const evaluation = evals[req.params.evalId];
  if (!evaluation) return res.status(404).json({ error: 'Evaluacion no encontrada' });

  const r = evaluation.fullReport;
  const s = r.strategy;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=TasaBA-Informe-${req.params.evalId}.pdf`);
  doc.pipe(res);

  // Header
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#1a365d').text('TasaBA', { continued: true });
  doc.fontSize(10).font('Helvetica').fillColor('#999').text('  Informe de valuacion', { align: 'left' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e5e5e7').stroke();
  doc.moveDown(0.5);

  // Property info
  doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(`${r.neighborhood} — ${r.zone} — ${r.m2}m2 — ${new Date().toLocaleDateString('es-AR')}`);
  doc.moveDown(1);

  // Valuation
  doc.fontSize(28).font('Helvetica-Bold').fillColor('#1a365d').text(`USD $${fmt(r.estimatedPrice)}`);
  doc.fontSize(12).font('Helvetica').fillColor('#999').text(`Rango: $${fmt(r.priceRange.low)} — $${fmt(r.priceRange.high)}`);
  doc.moveDown(0.5);

  // Key metrics
  const metrics = [
    ['Demanda', `${s.demandScore}/100`],
    ['Mercado', s.marketTiming],
    ['Tiempo est. venta', s.timeToSell],
    ['Tendencia anual', `+${r.trend}%`],
    ['Precio/m2', `$${fmt(r.pricePerM2)}`],
    ['Ranking CABA', `#${r.rank} de ${r.totalBarrios}`]
  ];
  doc.moveDown(0.5);
  metrics.forEach(([label, val]) => {
    doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(label, { continued: true, width: 200 });
    doc.font('Helvetica-Bold').fillColor('#1a1a1a').text(`  ${val}`);
  });

  // AI Summary
  if (r.summary) {
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('RESUMEN IA');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(r.summary, { lineGap: 3 });
  }

  // Strategy: Sell vs Wait
  doc.moveDown(1);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('VENDER AHORA VS ESPERAR');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#16a34a').text(s.sellVsWait.recommendation);
  doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(s.sellVsWait.reason, { lineGap: 3 });
  doc.moveDown(0.3);
  doc.font('Helvetica').fillColor('#6b6b6b')
    .text(`Proyeccion 2027: $${fmt(s.sellVsWait.projected1yr)} (+$${fmt(s.sellVsWait.waitGain1yr)})`)
    .text(`Proyeccion 2029: $${fmt(s.sellVsWait.projected3yr)} (+$${fmt(s.sellVsWait.waitGain3yr)})`)
    .text(`Proyeccion 2031: $${fmt(s.sellVsWait.projected5yr)} (+$${fmt(s.sellVsWait.projected5yr - r.estimatedPrice)})`);

  // Strategy: Renovation
  doc.moveDown(1);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('RENOVAR VS VENDER ASI');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#16a34a').text(s.renovationAdvice.recommendation);
  doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(s.renovationAdvice.reason, { lineGap: 3 });
  doc.moveDown(0.3);
  doc.font('Helvetica').fillColor('#6b6b6b')
    .text(`Costo estimado: $${fmt(s.renovationAdvice.estimatedCost)}`)
    .text(`Aumento valor: +$${fmt(s.renovationAdvice.estimatedValueIncrease)}`)
    .text(`ROI: ${s.renovationAdvice.roi}%`);

  // Strategy: Rent Analysis
  doc.addPage();
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('VENDER VS ALQUILAR');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(s.rentAnalysis.verdict, { lineGap: 3 });
  doc.moveDown(0.5);

  // Rent comparison table
  const rentData = [
    ['', 'Vender', 'Temp.', 'Tradicional'],
    ['Capital/Ingreso', `$${fmt(s.rentAnalysis.sell.immediateCapital)}`, `$${fmt(s.rentAnalysis.shortTerm.monthlyEstimate)}/m`, `$${fmt(s.rentAnalysis.longTerm.monthlyEstimate)}/m`],
    ['Ingreso neto anual', `$${fmt(s.rentAnalysis.sell.annualPassiveIncome)}`, `$${fmt(s.rentAnalysis.shortTerm.annualNet)}`, `$${fmt(s.rentAnalysis.longTerm.annualNet)}`],
    ['Rendimiento', '5.5%', `${s.rentAnalysis.shortTerm.netYield}%`, `${s.rentAnalysis.longTerm.netYield}%`]
  ];
  rentData.forEach((row, i) => {
    const y = doc.y;
    const isHeader = i === 0;
    row.forEach((cell, j) => {
      const x = 50 + j * 125;
      doc.fontSize(9).font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fillColor(isHeader ? '#1a365d' : '#6b6b6b').text(cell, x, y, { width: 120 });
    });
    doc.moveDown(0.6);
  });

  // AI Features
  if (r.features && r.features.length) {
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('CARACTERISTICAS IA');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(r.features.join(', '), { lineGap: 3 });
  }

  if (r.positives && r.positives.length) {
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('ASPECTOS POSITIVOS');
    doc.moveDown(0.3);
    r.positives.forEach(p => doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(`+ ${p}`));
  }

  if (r.negatives && r.negatives.length) {
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('ASPECTOS A CONSIDERAR');
    doc.moveDown(0.3);
    r.negatives.forEach(n => doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(`- ${n}`));
  }

  // Market insight
  doc.moveDown(1);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('INSIGHT DE MERCADO');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(s.marketInsight, { lineGap: 3 });
  doc.moveDown(0.3);
  doc.text(`Comprador objetivo: ${s.targetBuyer}`);
  doc.text(`Margen de negociacion: ${s.negotiationMargin}`);

  // Similar neighborhoods
  if (r.similarBarrios && r.similarBarrios.length) {
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d').text('BARRIOS SIMILARES');
    doc.moveDown(0.3);
    r.similarBarrios.forEach(sb => {
      doc.fontSize(10).font('Helvetica').fillColor('#6b6b6b').text(`${sb.name}: $${fmt(sb.pricePerM2)}/m2 (tendencia +${sb.trend}%)`);
    });
  }

  // Disclaimer
  doc.moveDown(1.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#e5e5e7').stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor('#999').text(
    'Este informe es una estimacion generada por inteligencia artificial basada en datos de mercado publicos. No constituye una tasacion formal ni reemplaza la evaluacion de un profesional matriculado. Los valores son orientativos. Fuentes: ZonaProp, Argenprop, IDECBA.',
    { lineGap: 2, align: 'center' }
  );
  doc.moveDown(0.3);
  doc.fontSize(8).font('Helvetica').fillColor('#1a365d').text('TasaBA — tasaba-473141067823.us-central1.run.app', { align: 'center' });

  doc.end();
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
