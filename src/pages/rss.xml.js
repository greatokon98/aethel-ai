import rss from '@astrojs/rss';
import fs from 'node:fs';
import path from 'node:path';
import parseFrontmatter from 'front-matter';

export async function GET(context) {
  const postsDir = path.resolve('src/content/posts');
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md'));

  const posts = files.map((file) => {
    const content = fs.readFileSync(path.join(postsDir, file), 'utf-8');
    const { attributes } = parseFrontmatter(content);
    return {
      title: attributes.title || '',
      publishDate: new Date(attributes.publishDate || Date.now()),
      excerpt: attributes.excerpt || '',
      slug: (attributes.title || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    };
  });

  return rss({
    title: 'Aethel_AI',
    description: 'Smart tools for everyday life — no jargon, just results.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.title,
      pubDate: post.publishDate,
      description: post.excerpt,
      link: `/posts/${post.slug}/`,
    })),
  });
}
