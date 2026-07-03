export async function handler(event, context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const sources = [
    { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
    { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', name: 'The Verge AI' },
    { url: 'https://arstechnica.com/tag/ai/feed/', name: 'Ars Technica AI' },
  ];

  function extractItems(xml, source) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const ix = match[1];
      const title = (ix.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || '';
      const link = (ix.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1]?.trim() || '';
      const pubDate = (ix.match(/<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i) || [])[1]?.trim() || '';
      const desc = (ix.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1]?.trim() || '';
      if (title && link) items.push({ title, link, source, pubDate, description: desc });
    }
    return items;
  }

  try {
    const results = await Promise.allSettled(
      sources.map(async (s) => {
        const res = await fetch(s.url, {
          headers: { 'User-Agent': 'AethelAI/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        const xml = await res.text();
        return extractItems(xml, s.name);
      })
    );

    let allItems = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allItems.push(...r.value);
    }

    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(allItems.slice(0, 12)),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
}
