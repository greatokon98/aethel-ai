const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPO_OWNER = 'greatokon98';
const REPO_NAME = 'aethel-ai';

const SOURCES = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
  { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', name: 'The Verge AI' },
  { url: 'https://arstechnica.com/tag/ai/feed/', name: 'Ars Technica AI' },
];

function slugify(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

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

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AethelAI/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();

    // Try to extract article body content
    const bodyMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
    const content = bodyMatch ? bodyMatch[1] : html;

    // Remove scripts, styles, nav
    const cleaned = content
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');

    return stripHtml(cleaned).slice(0, 4000);
  } catch {
    return '';
  }
}

async function rewriteWithAI(title, originalText, sourceName) {
  if (!OPENAI_API_KEY) return null;

  const prompt = `You are a technology blog writer for Aethel_AI, a blog about AI and automation for everyday people. Your voice is: practical, insightful, slightly conversational, avoids jargon, explains concepts clearly, and focuses on real-world impact rather than hype.

Rewrite the following news article from ${sourceName} in your own voice. The goal is to create an original blog post that covers the same topic but with your unique perspective and tone.

Original article title: "${title}"

Original article text:
${originalText.slice(0, 3000)}

Write a blog post (600-800 words) with:
1. An engaging introduction that hooks the reader
2. 3-4 sections with subheadings
3. Practical takeaways or implications
4. A conclusion that ties it back to everyday relevance

Format in Markdown. Do not include a title at the top (frontmatter will be added separately).`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('OpenAI API error:', err);
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('OpenAI fetch error:', err);
    return null;
  }
}

async function getExistingTitles() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/src/content/posts`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'aethel-ai-autotrending',
      },
    });
    if (!res.ok) return [];
    const files = await res.json();
    const titles = [];
    for (const f of files) {
      if (!f.name.endsWith('.md')) continue;
      const contentRes = await fetch(f.url, {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'aethel-ai-autotrending',
        },
      });
      if (!contentRes.ok) continue;
      const data = await contentRes.json();
      const decoded = Buffer.from(data.content, 'base64').toString();
      const titleMatch = decoded.match(/^title:\s*"(.+)"\s*$/m);
      if (titleMatch) titles.push(titleMatch[1].toLowerCase());
    }
    return titles;
  } catch {
    return [];
  }
}

function isDuplicate(title, existingTitles) {
  const lower = title.toLowerCase();
  return existingTitles.some(t => lower.includes(t.slice(0, 30)) || t.includes(lower.slice(0, 30)));
}

function buildMarkdown({ title, content, source }) {
  const date = new Date().toISOString().split('T')[0];
  const slug = slugify(title);
  return {
    slug,
    markdown: `---
title: "${title}"
excerpt: "A rewritten take on trending AI news — originally reported by ${source}."
publishDate: "${date}"
featured: false
categories:
  - AI News
tags:
  - trending
  - AI news
author: "Aethel"
---

${content}
`,
  };
}

async function commitPost(slug, markdown) {
  const filePath = `src/content/posts/${slug}.md`;
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'aethel-ai-autotrending',
    },
    body: JSON.stringify({
      message: `Auto-generated trending post: ${slug}`,
      content: Buffer.from(markdown).toString('base64'),
    }),
  });
  return res.ok;
}

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Validate API key if configured
  const apiKey = process.env.AUTO_TRENDING_KEY;
  const reqKey = event.headers['x-api-key'];
  if (apiKey && reqKey !== apiKey) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!GITHUB_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GITHUB_TOKEN not configured' }) };
  }

  const results = { fetched: 0, rewritten: 0, errors: [] };

  try {
    // Fetch RSS items
    const rssResults = await Promise.allSettled(
      SOURCES.map(async (s) => {
        const res = await fetch(s.url, {
          headers: { 'User-Agent': 'AethelAI/1.0' },
          signal: AbortSignal.timeout(8000),
        });
        const xml = await res.text();
        return extractItems(xml, s.name);
      })
    );

    let allItems = [];
    for (const r of rssResults) {
      if (r.status === 'fulfilled') allItems.push(...r.value);
    }
    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // Check existing titles to avoid duplicates
    const existingTitles = await getExistingTitles();

    // Process top 3 items that aren't duplicates
    const toProcess = [];
    for (const item of allItems) {
      if (toProcess.length >= 3) break;
      if (!isDuplicate(item.title, existingTitles)) {
        toProcess.push(item);
      }
    }

    results.fetched = toProcess.length;

    for (const item of toProcess) {
      try {
        const articleText = await fetchArticleText(item.link);
        if (!articleText) {
          results.errors.push(`Failed to fetch article: ${item.title}`);
          continue;
        }

        if (!OPENAI_API_KEY) {
          results.errors.push('OPENAI_API_KEY not configured — skipping rewrite');
          continue;
        }

        const rewritten = await rewriteWithAI(item.title, articleText, item.source);
        if (!rewritten) {
          results.errors.push(`AI rewrite failed: ${item.title}`);
          continue;
        }

        const { slug, markdown } = buildMarkdown({
          title: item.title,
          content: rewritten,
          source: item.source,
        });

        const committed = await commitPost(slug, markdown);
        if (committed) {
          results.rewritten++;
        } else {
          results.errors.push(`Git commit failed: ${item.title}`);
        }
      } catch (err) {
        results.errors.push(`Error processing "${item.title}": ${err.message}`);
      }
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(results),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, results }),
    };
  }
}
