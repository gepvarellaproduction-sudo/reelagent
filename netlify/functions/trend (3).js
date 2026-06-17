// Cerca reference TikTok ITALIANI reali sulle parole chiave del reel.
// Ottimizzato per Netlify Pro (26s). Soglie: >= 50.000 views, >= 1.000 interazioni.
// Verifica che ogni URL sia VIVO prima di restituirlo (scarta i link morti).

function parseCount(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().toLowerCase().replace(/\s|views|view|like|likes|interazioni|\+/g, '');
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

// verifica che un URL TikTok risponda davvero (scarta i link morti)
async function linkVivo(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    // TikTok oEmbed: se il video esiste, risponde 200 con dati; se no, errore
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return !!(data && data.title !== undefined);
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { settore, tema } = JSON.parse(event.body);

    // 1. DB (istantaneo)
    let dbValidi = [];
    try {
      const dbRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/trends?settore=eq.${encodeURIComponent(settore)}&limit=10`,
        { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } }
      );
      if (dbRes.ok) { const d = await dbRes.json(); dbValidi = (d || []).filter(validoTikTok); }
    } catch {}

    // 2. Ricerca web mirata su TikTok ITALIA
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    let webCandidati = [];
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
          max_tokens: 800,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          system: `Trovi video TikTok ITALIANI reali legati al tema, da usare come reference per un reel.

REGOLE TASSATIVE:
- SOLO contenuti ITALIANI: creator italiani, video in lingua italiana, account italiani. Cerca con parole chiave in italiano. Scarta qualsiasi video straniero.
- Almeno 1 video STRETTAMENTE legato al TEMA indicato.
- Ogni video: ALMENO 50.000 views e 1.000 interazioni.
- URL tiktok.com REALE e funzionante. Preferisci video di account verificabili e noti. NON inventare URL: se non sei certo che il link esista, NON includerlo.
- Trova fino a 4 candidati (ne verificheremo l'esistenza dopo), così almeno qualcuno sopravvive al controllo.
- Sii VELOCE e diretto, niente ragionamenti ad alta voce.

Rispondi SOLO con JSON minimale:
{"trend":[{"descrizione":"breve in italiano","url":"https://www.tiktok.com/@account/video/...","views":"250000","interazioni":"18000","motivo":"breve in italiano"}]}`,
          messages: [{ role: 'user', content: `Tema: "${tema}" (settore ${settore}). Trova reference TikTok ITALIANI sul tema. Solo JSON.` }]
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
          webCandidati = (result.trend || []).filter(validoTikTok);
        } catch {}
      }
    } catch (e) {
      clearTimeout(timer);
    }

    // 3. Verifica che i link web siano VIVI (in parallelo, max ~4s totali)
    let webVivi = [];
    if (webCandidati.length) {
      const checks = await Promise.all(webCandidati.map(async t => ({ t, ok: await linkVivo(t.url) })));
      webVivi = checks.filter(c => c.ok).map(c => c.t);
    }

    // 4. Unisci web verificati + DB, togli duplicati
    const seen = new Set();
    const uniti = [];
    for (const t of [...webVivi, ...dbValidi]) {
      if (!seen.has(t.url)) { seen.add(t.url); uniti.push(t); }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ trend: uniti.slice(0, 3), verificati: true }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, trend: [] }) };
  }
};
