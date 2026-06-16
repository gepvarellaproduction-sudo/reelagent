// Cerca reference TikTok reali e pertinenti per Titano.
// Regole: ogni video deve essere inerente a settore + tema.
// Soglie minime: >= 10.000 views e >= 1.000 interazioni.
// Almeno 1 video deve essere strettamente legato al tema specifico del reel.

// --- util: estrae il primo numero da stringhe tipo "12.5K", "1,2M", "340.000" ---
function parseCount(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().toLowerCase().replace(/\s|views|view|like|likes|interazioni/g, '');
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; s = s.slice(0, -1); }
  // normalizza separatori: "1.234.567" o "1,2" -> numero
  s = s.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * mult);
}

const MIN_VIEWS = 10000;
const MIN_INTERAZIONI = 1000;

function validoTikTok(t) {
  if (!t || !t.url) return false;
  const url = String(t.url).toLowerCase();
  if (!url.includes('tiktok.com')) return false;
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

    // 1. Leggi i trend dal DB per il settore (riempito ogni notte da aggiorna-trend)
    let dbTrends = [];
    try {
      const dbRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/trends?settore=eq.${encodeURIComponent(settore)}&limit=12`,
        { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } }
      );
      if (dbRes.ok) dbTrends = await dbRes.json();
    } catch {}

    // Tieni dal DB solo quelli che rispettano le soglie
    const dbValidi = (dbTrends || []).filter(validoTikTok);

    // 2. Se ho abbastanza candidati validi nel DB, lascio che Claude scelga
    //    i piu' pertinenti a settore+tema (chiamata leggera, senza web search)
    if (dbValidi.length >= 3) {
      const rankRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 900,
          system: `Sei un selezionatore di reference TikTok per content creator. Ricevi una lista di video reali (gia' filtrati per soglie minime) e devi sceglierne 3 per ispirare un nuovo reel.

REGOLE OBBLIGATORIE:
- I 3 video devono essere INERENTI sia al settore sia al tema indicato.
- Almeno 1 dei 3 deve essere STRETTAMENTE legato al TEMA specifico del reel (non solo al settore generico). Mettilo per primo.
- Mantieni intatti url, views e interazioni di ciascun video: NON inventarli.
- Aggiorna solo il campo "motivo" spiegando perche' e' utile come riferimento per QUESTO tema.

Rispondi SOLO con JSON, nessun testo fuori:
{ "trend": [ { "descrizione": "...", "url": "...", "views": "...", "interazioni": "...", "motivo": "..." } ] }`,
          messages: [{
            role: 'user',
            content: `Settore: "${settore}"\nTema del reel: "${tema}"\n\nVideo disponibili (gia' validi per soglie):\n${JSON.stringify(dbValidi, null, 2)}\n\nScegli i 3 migliori secondo le regole. Il primo deve essere quello piu' vicino al tema. Solo JSON.`
          }]
        })
      });

      if (rankRes.ok) {
        const rankData = await rankRes.json();
        let raw = '';
        for (const b of (rankData.content || [])) { if (b.type === 'text') raw += b.text; }
        try {
          const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const m = clean.match(/\{[\s\S]*\}/);
          const result = JSON.parse(m?.[0] || '{}');
          // ri-filtro per sicurezza: solo quelli che superano ancora le soglie
          const puliti = (result.trend || []).filter(validoTikTok);
          if (puliti.length) {
            return { statusCode: 200, headers, body: JSON.stringify({ trend: puliti.slice(0, 3) }) };
          }
        } catch {}
      }

      // Fallback: i primi 3 validi del DB
      return { statusCode: 200, headers, body: JSON.stringify({ trend: dbValidi.slice(0, 3) }) };
    }

    // 3. DB insufficiente -> ricerca web dal vivo, con soglie esplicite nel prompt
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
        system: `Cerchi video TikTok REALI da usare come reference per un reel di un'attivita' locale italiana.

REGOLE OBBLIGATORIE:
- Trova 3 video TikTok reali e inerenti al SETTORE indicato.
- Almeno 1 dei 3 deve essere STRETTAMENTE legato al TEMA specifico del reel (mettilo per primo).
- Ogni video deve avere ALMENO 10.000 views e ALMENO 1.000 interazioni (like+commenti+condivisioni). Scarta quelli sotto soglia.
- Usa solo URL tiktok.com reali trovati nella ricerca. Non inventare link o numeri: se non sei sicuro dei numeri, cerca ancora o scarta il video.
- Il campo "interazioni" deve essere il totale stimato di like+commenti+condivisioni.

Rispondi SOLO con JSON, nessun testo fuori:
{ "trend": [ { "descrizione": "breve descrizione del video", "url": "URL tiktok.com reale", "views": "es. 250000", "interazioni": "es. 18000", "motivo": "perche' e' utile come riferimento per questo tema" } ] }`,
        messages: [{
          role: 'user',
          content: `Settore: "${settore}"\nTema del reel: "${tema}"\n\nTrova 3 reference TikTok secondo le regole. Il primo deve essere il piu' vicino al tema "${tema}". Solo JSON.`
        }]
      })
    });

    if (!response.ok) {
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Ricerca momentaneamente non disponibile — riprova tra qualche minuto', trend: [] }) };
    }

    const data = await response.json();
    let raw = '';
    for (const b of (data.content || [])) { if (b.type === 'text') raw += b.text; }

    let result;
    try {
      const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const m = clean.match(/\{[\s\S]*\}/);
      result = JSON.parse(m?.[0] || '{"trend":[]}');
    } catch { result = { trend: [] }; }

    // filtro finale: tieni solo i video che rispettano davvero le soglie e hanno URL TikTok
    const validi = (result.trend || []).filter(validoTikTok);

    return { statusCode: 200, headers, body: JSON.stringify({ trend: validi.slice(0, 3) }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, trend: [] }) };
  }
};
