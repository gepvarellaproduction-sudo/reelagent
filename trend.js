exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const { settore, tema, obiettivi } = JSON.parse(event.body);
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
        system: `Sei un ricercatore di trend TikTok per social media italiani.
Cerca video TikTok REALI, verificati e recenti nel settore richiesto.
Rispondi SOLO con JSON valido. Nessun testo fuori dal JSON. Nessun backtick.
Schema: { "trend": [ { "descrizione": "titolo descrittivo del video", "url": "URL TikTok reale e verificato", "views": "numero views (es. 2.3M)", "interazioni": "like+commenti stimati (es. 45K)", "motivo": "perche questo video e rilevante per il brief" } ] }
Trova esattamente 3 video con almeno 100.000 views e 1.000 interazioni.`,
        messages: [{
          role: 'user',
          content: `Cerca 3 video TikTok REALI nel settore "${settore}" correlati all'argomento "${tema}"${obiettivi?.length ? ` con obiettivo ${obiettivi.join(', ')}` : ''}.
Requisiti minimi: 100.000 views e 1.000 interazioni ciascuno.
Usa la ricerca web per trovare URL TikTok reali e verificati.
Rispondi SOLO con il JSON.`
        }]
      }),
    });
    if (!response.ok) { const err = await response.text(); return { statusCode: response.status, headers, body: JSON.stringify({ error: err }) }; }
    const data = await response.json();
    let raw = '';
    for (const b of (data.content || [])) { if (b.type === 'text') raw += b.text; }
    let result;
    try {
      const clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      const m = clean.match(/\{[\s\S]*\}/);
      result = JSON.parse(m?.[0] || '{"trend":[]}');
    } catch { result = { trend: [] }; }
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
