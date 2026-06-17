// Cerca reference TikTok reali sulle PAROLE CHIAVE del reel.
// Ottimizzato per il piano Netlify Pro (timeout 26s).
// Obiettivo: almeno 1 reference forte (>= 50.000 views, >= 1.000 interazioni)
// strettamente legato al tema. Veloce: una sola ricerca mirata, poco testo.

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

const MIN_VIEWS = 50000;
const MIN_INTERAZIONI = 1000;

function validoTikTok(t) {
  if (!t || !t.url) return false;
  if (!String(t.url).toLowerCase().includes('tiktok.com')) return false;
  return parseCount(t.views) >= MIN_VIEWS && parseCount(t.interazioni) >= MIN_INTERAZIONI;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { settore, tema } = JSON.parse(event.body);

    // 1. PRIMA prova il DB (istantaneo)
    let dbValidi = [];
    try {
      const dbRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/trends?settore=eq.${encodeURIComponent(settore)}&limit=10`,
        { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } }
      );
      if (dbRes.ok) { const d = await dbRes.json(); dbValidi = (d || []).filter(validoTikTok); }
    } catch {}

    // 2. Ricerca web MIRATA e SNELLA (sotto i 26s)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 23000);

    let webValidi = [];
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 700,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          system: `Trovi 1-2 video TikTok REALI legati al tema indicato, da usare come reference per un reel.

REGOLE:
- Almeno 1 video STRETTAMENTE legato al TEMA (non solo al settore).
- Ogni video: ALMENO 50.000 views e 1.000 interazioni. URL tiktok.com reale.
- Sii VELOCE: poche ricerche, vai dritto al punto. Non spiegare, non ragionare ad alta voce.

Rispondi SOLO con JSON minimale, nessun testo fuori:
{"trend":[{"descrizione":"breve","url":"https://tiktok.com/...","views":"250000","interazioni":"18000","motivo":"breve"}]}`,
          messages: [{ role: 'user', content: `Tema: "${tema}" (settore ${settore}). Trova 1-2 reference TikTok forti sul tema. Solo JSON.` }]
        })
      });
      clearTimeout(timer);
      if (response.ok) {
        const data = await response.json();
        let raw = '';
        for (const b of (data.content || [])) { if (b.type === 'text') raw += b.text; }
        try {
          const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const m = clean.match(/\{[\s\S]*\}/);
          const result = JSON.parse(m?.[0] || '{"trend":[]}');
          webValidi = (result.trend || []).filter(validoTikTok);
        } catch {}
      }
    } catch (e) {
      clearTimeout(timer);
    }

    // 3. Unisci web + DB, togli duplicati
    const seen = new Set();
    const uniti = [];
    for (const t of [...webValidi, ...dbValidi]) {
      if (!seen.has(t.url)) { seen.add(t.url); uniti.push(t); }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ trend: uniti.slice(0, 3) }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, trend: [] }) };
  }
};
