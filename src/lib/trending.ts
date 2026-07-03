export interface TrendingItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  description: string;
}

function extractRssItems(xml: string, source: string): TrendingItem[] {
  const items: TrendingItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = itemXml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() || '';
    const link = itemXml.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1]?.trim() || '';
    const pubDate = itemXml.match(/<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i)?.[1]?.trim() || '';
    const description = itemXml.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim() || '';

    if (title && link) {
      items.push({ title, link, source, pubDate, description });
    }
  }
  return items;
}

export async function fetchTrendingNews(): Promise<TrendingItem[]> {
  const sources = [
    { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
    { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', name: 'The Verge AI' },
    { url: 'https://arstechnica.com/tag/ai/feed/', name: 'Ars Technica AI' },
  ];

  try {
    const results = await Promise.allSettled(
      sources.map(async (source) => {
        const res = await fetch(source.url, {
          headers: { 'User-Agent': 'AethelAI/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        const xml = await res.text();
        return extractRssItems(xml, source.name);
      })
    );

    const allItems: TrendingItem[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      }
    }

    allItems.sort((a, b) => {
      const dateA = new Date(a.pubDate).getTime();
      const dateB = new Date(b.pubDate).getTime();
      return dateB - dateA;
    });

    return allItems.slice(0, 8);
  } catch {
    return [];
  }
}
