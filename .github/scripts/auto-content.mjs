const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'greatokon98/aethel-ai';
const API_BASE = `https://api.github.com/repos/${REPO}`;

const RSS_SOURCES = [
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
  { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', name: 'The Verge AI' },
  { url: 'https://arstechnica.com/tag/ai/feed/', name: 'Ars Technica AI' },
];

const TYPE_CYCLE = ['standard', 'trending', 'standard', 'popular', 'standard', 'trending', 'featured', 'standard'];

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function extractRSSItems(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const ix = match[1];
    const title = (ix.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || '';
    const link = (ix.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1]?.trim() || '';
    const pubDate = (ix.match(/<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i) || [])[1]?.trim() || '';
    if (title && link) items.push({ title, link, source, pubDate });
  }
  return items;
}

async function ghFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'aethel-ai-content-bot',
      Accept: 'application/vnd.github.v3+json',
      ...options.headers,
    },
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    console.error(`GitHub API error (${res.status}):`, err.slice(0, 200));
  }
  return res;
}

async function getExistingPosts() {
  const res = await ghFetch(`${API_BASE}/contents/src/content/posts`);
  if (!res.ok) return [];
  const files = await res.json();
  if (!Array.isArray(files)) return [];

  const posts = [];
  for (const f of files) {
    if (!f.name.endsWith('.md')) continue;
    const contentRes = await ghFetch(f.url);
    if (!contentRes.ok) continue;
    const data = await contentRes.json();
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    const titleMatch = decoded.match(/^title:\s*"(.+)"\s*$/m);
    posts.push({
      title: titleMatch ? titleMatch[1] : '',
      slug: f.name.replace(/\.md$/, ''),
      filename: f.name,
    });
  }
  return posts;
}

async function commitPost(filename, markdown) {
  const path = `src/content/posts/${filename}`;
  const existingRes = await ghFetch(`${API_BASE}/contents/${path}`);
  const sha = existingRes.ok ? (await existingRes.json()).sha : undefined;

  const body = {
    message: `auto: ${filename.replace('.md', '')}`,
    content: Buffer.from(markdown, 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(`${API_BASE}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  if (res.ok) {
    console.log(`  \u2713 Committed: ${filename}`);
    return true;
  } else {
    const err = await res.text();
    console.error(`  \u2717 Commit failed: ${filename} \u2014 ${err.slice(0, 150)}`);
    return false;
  }
}

async function fetchHeadlines() {
  const results = await Promise.allSettled(
    RSS_SOURCES.map(async (s) => {
      const res = await fetch(s.url, {
        headers: { 'User-Agent': 'AethelAI/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      const xml = await res.text();
      return extractRSSItems(xml, s.name);
    })
  );

  let items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items.slice(0, 10);
}

async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2000 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function discoverTopics(headlines) {
  const headlineText = headlines.map(h => `- ${h.title} (${h.source})`).join('\n');

  const prompt = `You are a content strategist for Aethel_AI, a blog about AI and automation for everyday people.

Here are the latest AI news headlines:
${headlineText}

Think like a curious, practical person trying to understand AI and improve their daily life.

Based on these headlines and your knowledge of what people struggle with, suggest 2-3 specific article topics that would help someone live better with AI. Focus on topics people genuinely need clarity on \u2014 not hype, not product launches, but real practical guidance and understanding.

For each topic, provide:
- Topic title (catchy but clear, max 10 words)
- Why people need clarity on this (1 sentence max)

Format your response as a simple list:
1. Topic: [title] \u2014 [reason]
2. Topic: [title] \u2014 [reason]`;

  const response = await callGemini(prompt);

  const topics = [];
  const topicRegex = /\d+\.\s*Topic:\s*(.+?)\s*\u2014\s*(.+)/g;
  let match;
  while ((match = topicRegex.exec(response)) !== null) {
    topics.push({ title: match[1].trim(), reason: match[2].trim() });
  }

  if (topics.length === 0) {
    const lines = response.split('\n').filter(l => l.includes('Topic:'));
    for (const line of lines.slice(0, 3)) {
      const parts = line.split(/\u2014|--|–|-\s+/);
      if (parts.length >= 2) {
        topics.push({
          title: parts[0].replace(/.*Topic:\s*/, '').trim(),
          reason: parts.slice(1).join(' ').trim(),
        });
      }
    }
  }

  return topics;
}

async function fetchFeaturedImage(query) {
  const url = `https://source.unsplash.com/featured/1200x630/?${encodeURIComponent(query)},artificial-intelligence,technology`;
  return url;
}

async function writePost(topic, existingPosts) {
  const prompt = `You are Aethel, a writer for Aethel_AI \u2014 a blog about AI and automation for everyday people.

Your voice and style:
- First-person, honest, practical, anti-hype
- Short punchy paragraphs (2-3 sentences max)
- Bold for **emphasis** on key concepts
- No jargon \u2014 explain everything clearly
- Share real results and practical takeaways
- Address the reader directly ("you")
- Use subheadings as short questions or phrases
- End with a one-sentence takeaway

Write an in-depth, original blog post on this topic:
"${topic.title}"

The post should help someone who is curious but confused about this topic. Make it practical, clear, and genuinely useful.

Write 500-700 words with:
1. A bold opening sentence that hooks
2. 3-4 short sections with subheadings
3. What this actually means for the reader
4. A one-sentence takeaway at the end, on its own line, prefixed with **

Format in Markdown. Do NOT include a title at the top (frontmatter will be added separately). Do NOT include --- separators.`;

  const content = await callGemini(prompt);

  const typeIndex = existingPosts.length % TYPE_CYCLE.length;
  const postType = TYPE_CYCLE[typeIndex];

  const catPrompt = `Given this blog post title: "${topic.title}", which category best fits? Choose ONE from: AI Tools, Content Creation, Productivity, Workflow, AI News, Automation, Creativity, Entrepreneurship, Future of Work.
Reply with just the category name.`;

  let category = 'AI News';
  try {
    const catResponse = await callGemini(catPrompt);
    const validCats = ['AI Tools', 'Content Creation', 'Productivity', 'Workflow', 'AI News', 'Automation', 'Creativity', 'Entrepreneurship', 'Future of Work'];
    const matched = validCats.find(c => catResponse.includes(c));
    if (matched) category = matched;
  } catch {}

  const date = new Date().toISOString().split('T')[0];
  let slug = slugify(topic.title);

  let tags = ['AI', 'automation'];
  if (postType === 'trending') tags.push('trending');
  if (postType === 'popular') tags.push('popular');

  const isFeatured = postType === 'featured';
  const excerpt = topic.reason || `A clear, practical guide to understanding ${topic.title.toLowerCase()} and how it affects your everyday life.`;

  const markdown = `---
title: "${topic.title}"
excerpt: "${excerpt}"
publishDate: "${date}"
featuredImage: "${await fetchFeaturedImage(topic.title)}"
featured: ${isFeatured}
categories:
  - ${category}
tags:
${tags.map(t => `  - ${t}`).join('\n')}
author: "Aethel"
---

${content}
`;

  return { slug, markdown, type: postType };
}

async function main() {
  console.log('=== Aethel_AI Auto Content Pipeline ===');
  console.log(`Time: ${new Date().toISOString()}\n`);

  if (!GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not set');
    process.exit(1);
  }
  if (!GITHUB_TOKEN) {
    console.error('ERROR: GITHUB_TOKEN not set');
    process.exit(1);
  }

  console.log('Fetching existing posts...');
  const existingPosts = await getExistingPosts();
  console.log(`  Found ${existingPosts.length} existing posts\n`);

  const existingTitles = existingPosts.map(p => p.title.toLowerCase());
  const existingSlugs = new Set(existingPosts.map(p => p.slug));

  console.log('Fetching RSS headlines...');
  const headlines = await fetchHeadlines();
  console.log(`  Fetched ${headlines.length} headlines\n`);

  const lightweightHeadlines = headlines.map(item => ({
    title: item.title ? item.title.trim() : "",
    source: item.source,
    description: item.description ? item.description.replace(/<[^>]*>/g, '').slice(0, 100).trim() + "..." : ""
  }));

  console.log(`[Aethel_AI] Sanitized payload: ${lightweightHeadlines.length} headlines cleaned`);

  const batchSize = 3;
  const allDiscoveredTopics = [];

  for (let i = 0; i < lightweightHeadlines.length; i += batchSize) {
    const batch = lightweightHeadlines.slice(i, i + batchSize);
    console.log(`[Aethel_AI] Processing batch ${Math.floor(i / batchSize) + 1}...`);
    const batchTopics = await discoverTopics(batch);
    if (batchTopics && batchTopics.length > 0) {
      allDiscoveredTopics.push(...batchTopics);
    }
    if (i + batchSize < lightweightHeadlines.length) {
      console.log(`[Aethel_AI] Pausing 10s for API quota...`);
      await sleep(10000);
    }
  }

  const discovered = allDiscoveredTopics;
  console.log(`  Discovered ${discovered.length} topics:`);
  discovered.forEach(t => console.log(`    - ${t.title}: ${t.reason}`));
  console.log();

  let newTopics = discovered.filter(t => {
    const lower = t.title.toLowerCase();
    const isDup = existingTitles.some(et =>
      lower.includes(et.slice(0, 30)) || et.includes(lower.slice(0, 30))
    );
    if (isDup) console.log(`  Skipping (duplicate): ${t.title}`);
    return !isDup;
  });

  newTopics = newTopics.slice(0, 2);
  console.log(`  ${newTopics.length} new topics to write\n`);

  if (newTopics.length === 0) {
    console.log('Nothing new to write. Exiting.');
    return;
  }

  let committed = 0;
  for (const topic of newTopics) {
    console.log(`Writing: "${topic.title}"...`);
    try {
      let { slug, markdown, type } = await writePost(topic, existingPosts);

      if (existingSlugs.has(slug)) {
        let n = 1;
        while (existingSlugs.has(`${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
      }

      const filename = `${slug}.md`;
      console.log(`  Type: ${type}`);
      const success = await commitPost(filename, markdown);
      if (success) {
        committed++;
        existingSlugs.add(slug);
      }
      console.log();
    } catch (err) {
      console.error(`  Failed: ${err.message}\n`);
    }
  }

  console.log(`=== Done: ${committed} new posts published ===`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
