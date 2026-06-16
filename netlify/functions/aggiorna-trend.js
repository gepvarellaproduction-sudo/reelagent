// Function schedulata: ogni notte cerca reference TikTok per ogni settore
// e li salva nella tabella `trends` di Supabase.
//
// Lancio manuale: GET con ?settore=Ristorazione  -> aggiorna solo quel settore
//
// Soglie: >= 10.000 views e >= 1.000 interazioni. URL tiktok.com reali.

const SETTORI = [
  'Ristorazione', 'Moda e abbigliamento', 'Beauty e estetica', 'Fitness e sport',
  'Artigianato', 'Retail e negozi', 'Turismo e hospitality', 'Professioni e consulenza',
  'Tecnologia', 'Arte e creatività', 'Immobiliare', 'Salute e benessere',
  'Educazione e formazione', 'Altro'
];

function parseCount(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().toLowerCase().replace(/\s|views|view|like|likes|interazioni/g, '');
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; s = s.slice(0, -1); }
  s = s.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * mult);
}
const MIN_VIEWS = 10000;
const MIN_INTERAZIONI = 1000;
function validoTikTok(t) {
  if (!t || !t.url) return false;
  if (!String(t.url).toLowerCase().includes('tiktok.com')) return false;
  return parseCount(t.views) >= MIN_VIEWS && parseCount(t.interazioni) >= MIN_INTERAZIONI;
}

async function cercaSettore(settore) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `Cerchi video TikTok REALI e performanti nel settore indicato, da usare come reference per content creator di attivita' locali italiane.

REGOLE OBBLIGATORIE:
- Trova 5 video TikTok reali e inerenti al SETTORE.
- Ogni video deve avere ALMENO 10.000 views e ALMENO 1.000 interazioni. Scarta quelli sotto soglia.
- Usa solo URL tiktok.com reali trovati nella ricerca. Non inventare link o numeri.
- "interazioni" = totale stimato like+commenti+condivisioni.

Rispondi SOLO con JSON, nessun testo fuori:
{ "trend": [ { "descrizione": "...", "url": "URL tiktok.com reale", "views": "es. 250000", "interazioni": "es. 18000", "motivo": "perche' funziona / cosa lo rende efficace" } ] }`,
      messages: [{ role: 'user', content: `Settore: "${settore}". Trova 5 reference TikTok performanti del settore. Solo JSON.` }]
    })
  });
  if (!response.ok) return { trend: [], raw: `api ${response.status}` };
  const data = await response.json();
  let raw = '';
  for (const b of (data.content || [])) { if (b.type === 'text') raw += b.text; }
  let result;
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    result = JSON.parse(m?.[0] || '{"trend":[]}');
  } catch { return { trend: [], raw: raw.slice(0,200) }; }
  const tutti = result.trend || [];
  const validi = tutti.filter(validoTikTok);
  return { trend: validi, grezzi: tutti.length, raw: '' };
}

async function salvaSettore(settore, trend) {
  if (!trend.length) return 0;
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const h = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  await fetch(`${base}/rest/v1/trends?settore=eq.${encodeURIComponent(settore)}`, { method: 'DELETE', headers: h });
  const righe = trend.map(t => ({
    settore,
    descrizione: t.descrizione || '',
    url: t.url,
    views: String(t.views || ''),
    interazioni: String(t.interazioni || ''),
    motivo: t.motivo || '',
    updated_at: new Date().toISOString(),
  }));
  const res = await fetch(`${base}/rest/v1/trends`, { method: 'POST', headers: h, body: JSON.stringify(righe) });
  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`save ${res.status}: ${errTxt.slice(0,120)}`);
  }
  return righe.length;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const qsSettore = event.queryStringParameters && event.queryStringParameters.settore;
    const lista = qsSettore ? [qsSettore] : SETTORI;

    const report = {};
    for (const settore of lista) {
      try {
        const r = await cercaSettore(settore);
        const salvati = await salvaSettore(settore, r.trend);
        report[settore] = { grezzi: r.grezzi || 0, validi: r.trend.length, salvati, raw: r.raw || '' };
      } catch (e) {
        report[settore] = `errore: ${e.message}`;
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, aggiornati: report }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
