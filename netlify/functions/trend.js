// Legge i trend dal database Supabase invece di chiamare Claude ogni volta
// Questo elimina il problema di rate limit con 100+ utenti

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { settore, tema } = JSON.parse(event.body);

    // 1. Leggi trend dal database per questo settore
    const dbRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/trends?settore=eq.${encodeURIComponent(settore)}&limit=5`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        }
      }
    );

    let dbTrends = [];
    if (dbRes.ok) {
      dbTrends = await dbRes.json();
    }

    // 2. Se il DB ha trend freschi, usali
    if (dbTrends && dbTrends.length >= 3) {
      // Filtra per rilevanza rispetto al tema usando Claude (chiamata leggera, no web search)
      const rankRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          system: `Hai una lista di video TikTok. Scegli i 3 più rilevanti per il tema dato e aggiorna il campo "motivo" per spiegare la rilevanza specifica.
Rispondi SOLO con JSON: { "trend": [ { "descrizione": "...", "url": "...", "views": "...", "interazioni": "...", "motivo": "..." } ] }`,
          messages: [{
            role: 'user',
            content: `Tema: "${tema}"\nSettore: "${settore}"\n\nVideo disponibili:\n${JSON.stringify(dbTrends, null, 2)}\n\nScegli i 3 più rilevanti e aggiorna il motivo. Solo JSON.`
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
          if (result.trend?.length) {
            return { statusCode: 200, headers, body: JSON.stringify(result) };
          }
        } catch {}
      }

      // Fallback: restituisci i primi 3 dal DB senza ranking
      return { statusCode: 200, headers, body: JSON.stringify({ trend: dbTrends.slice(0, 3) }) };
    }

    // 3. Se il DB è vuoto, chiamata diretta con web search (fallback)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `Ricerca video TikTok reali nel settore richiesto. Rispondi SOLO con JSON.
Schema: { "trend": [ { "descrizione": "...", "url": "URL TikTok reale", "views": "...", "interazioni": "...", "motivo": "..." } ] }
Trova 3 video con 100.000+ views.`,
        messages: [{
          role: 'user',
          content: `Trova 3 video TikTok nel settore "${settore}" correlati a "${tema}". Solo JSON.`
        }]
      })
    });

    if (!response.ok) {
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Rate limit — riprova tra qualche minuto', trend: [] }) };
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

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, trend: [] }) };
  }
};
