import { Router } from 'express';

const router = Router();

const FEEDS = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch' },
  { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', source: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', source: 'Ars Technica' },
];

const PROXY = 'https://api.rss2json.com/v1/api.json?rss_url=';

router.get('/', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const r = await fetch(PROXY + encodeURIComponent(feed.url));
        if (!r.ok) return [];
        const data = await r.json();
        if (data.status !== 'ok' || !data.items) return [];
        return data.items.map((item) => ({
          title: item.title || '',
          description: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 200),
          pubDate: item.pubDate || item.pub_date || '',
          source: feed.source,
          link: item.link || '',
        }));
      })
    );

    const items = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    return res.json({ items: items.slice(0, 20) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
