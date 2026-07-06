export async function normalizeImageUrl(url) {
  if (/\.(jpg|jpeg|png|gif|webp|avif)(\?|$)/i.test(url)) return url;
  if (/^data:image\//.test(url)) return url;
  if (/^https?:\/\/images\.(unsplash|pexels|pixabay)\.com\//.test(url)) return url;
  if (/^https?:\/\/picsum\.photos\//.test(url)) return url;

  const pexelsMatch = url.match(/pexels\.com\/photo\/[^/]*?(\d+)/);
  if (pexelsMatch) {
    return `https://images.pexels.com/photos/${pexelsMatch[1]}/pexels-photo-${pexelsMatch[1]}.jpeg`;
  }

  const unsplashMatch = url.match(/unsplash\.com\/photos\/([a-zA-Z0-9_-]+)/);
  if (unsplashMatch) {
    try {
      const html = await fetch(`https://unsplash.com/photos/${unsplashMatch[1]}`, {
        signal: AbortSignal.timeout(8000),
      }).then(r => r.text());
      const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
      if (m) {
        const base = m[1].split('?')[0];
        return base + '?w=800';
      }
    } catch {}
  }

  return url;
}
