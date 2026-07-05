const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const HF_API_KEY = process.env.HF_API_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
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
  return items.slice(0, 5);
}

async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
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

async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2500,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq error (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function discoverTopics(headlines) {
  const discovered = [];

  console.log(`[Aethel_AI] Processing ${headlines.length} headlines sequentially...`);

  for (let i = 0; i < headlines.length; i++) {
    const item = headlines[i];
    console.log(`  -> Item ${i + 1}/${headlines.length}: "${(item.title || '').slice(0, 40)}..."`);

    const prompt = `You are a content strategist for Aethel_AI, a blog about AI and automation for everyday people.

Given this headline: "${item.title}"

Think like a curious, practical person trying to understand AI and improve their daily life.

Suggest ONE specific article topic that would help someone live better with AI, inspired by this headline. Focus on a topic people genuinely need clarity on — not hype, not product launches, but real practical guidance and understanding.

For the topic, provide:
- Topic title (catchy but clear, max 10 words)
- Why people need clarity on this (1 sentence max)

Format your response as:
Topic: [title] — [reason]`;

    try {
      const response = await callGemini(prompt);

      const topicRegex = /Topic:\s*(.+?)\s*\u2014\s*(.+)/;
      const match = topicRegex.exec(response);

      if (match) {
        discovered.push({ title: match[1].trim(), reason: match[2].trim() });
        console.log(`    -> Discovered: "${match[1].trim()}"`);
      } else {
        const parts = response.split(/\u2014|--|\u2013|-\s+/);
        if (parts.length >= 2) {
          const title = parts[0].replace(/.*Topic:\s*/, '').trim();
          const reason = parts.slice(1).join(' ').trim();
          if (title) {
            discovered.push({ title, reason });
            console.log(`    -> Discovered (fallback): "${title}"`);
          }
        }
      }
    } catch (error) {
      console.error(`  [!] Error processing item ${i + 1}:`, error.message);
    }

    if (i < headlines.length - 1) {
      console.log(`  [Pacing] Sleeping 4 seconds to protect Free Tier RPM thresholds...`);
      await sleep(4000);
    }
  }

  return discovered;
}

function extractKeywords(title, categories) {
  const stopWords = new Set(['how','to','the','a','an','is','are','was','were','for','with','in','on','at','and','or','of','its','this','that','what','why','when','where','which','who','does','do','can','will','has','have','had','but','not','all','be','by','from','it','no','so','up','if','as','about','into','than','then','them','they','your','you']);
  const words = title.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').filter(w => w.length >= 2 && !stopWords.has(w.toLowerCase()));
  if (categories) {
    categories.split(',').forEach(c => { const t = c.trim(); if (t) words.push(t); });
  }
  return [...new Set(words)].slice(0, 4).join(' ') || title.split(' ').slice(0, 3).join(' ');
}

async function enrichImagePrompt(title, categories) {
  const prompt = `You are an expert editorial art director and visual storyteller.

Given the blog title: "${title}" (category: ${categories || 'general'})

Analyze the topic and return ONLY two valid JSON objects separated by the delimiter "---PIXABAY---".

First JSON object (for Flux image generation):

{
  "title": "${title}",
  "visual_subject": "describe the main visual subject",
  "setting": "describe the environment or setting",
  "style": "realistic editorial photography or appropriate style",
  "lighting": "describe the lighting",
  "camera_angle": "describe the camera angle",
  "mood": "describe the mood",
  "avoid": ["text", "logos", "watermarks"]
}

Second JSON object (for Pixabay fallback search):

{
  "main_subject": "primary subject",
  "secondary_subject": "secondary element",
  "environment": "setting description",
  "style": "professional",
  "pixabay_keywords": ["keyword1 keyword2", "keyword3 keyword4", "keyword5 keyword6"]
}

Rules:
- Understand the meaning and intent behind the title.
- Prioritize realism unless the topic clearly benefits from illustration or 3D.
- Choose colors that match the topic.
- One clear focal subject, strong visual hierarchy, negative space for text overlay.
- Professional magazine cover quality.
- For the pixabay_keywords array, provide 3 keyword strings optimized for Pixabay search.`;

  let text = '';
  try {
    text = await callGemini(prompt);
    if (text) console.log(`  [enrich] Gemini succeeded (${text.length} chars)`);
  } catch (e) { console.error(`  [enrich] Gemini failed: ${e.message?.slice(0, 100)}`); }
  if (!text) {
    try {
      text = await callGroq(prompt);
      if (text) console.log(`  [enrich] Groq succeeded (${text.length} chars)`);
    } catch (e) { console.error(`  [enrich] Groq failed: ${e.message?.slice(0, 100)}`); }
  }

  let fluxJson = {};
  let pixabayKeywords = [];

  if (text) {
    const parts = text.split('---PIXABAY---');
    try {
      const first = parts[0].replace(/^\s*json\s*/i, '').trim();
      fluxJson = JSON.parse(first);
    } catch {}
    try {
      const pixPart = parts.length > 1 ? parts[1] : parts[0];
      const pixParsed = JSON.parse(pixPart.replace(/^\s*json\s*/i, '').trim());
      pixabayKeywords = pixParsed.pixabay_keywords || [];
    } catch {}
  }

  const fluxPrompt = [
    fluxJson.visual_subject || title,
    fluxJson.setting ? `in ${fluxJson.setting}` : '',
    fluxJson.style || 'editorial photography',
    fluxJson.lighting || 'natural lighting',
    fluxJson.camera_angle || '',
    `mood: ${fluxJson.mood || 'professional'}`,
    'high quality, detailed, sharp focus, no text, no logos, no watermarks',
  ].filter(Boolean).join(', ');

  return { fluxPrompt, pixabayKeywords };
}

const HF_FLUX_DEV = 'black-forest-labs/FLUX.1-dev';
const HF_FLUX_SCHNELL = 'black-forest-labs/FLUX.1-schnell';

async function callFlux(model, prompt, timeoutMs = 90000, retries = 0) {
  if (!HF_API_KEY) { console.error('  [flux] No HF_API_KEY set'); return null; }
  if (retries > 2) { console.error(`  [flux] ${model} max retries (2) exceeded`); return null; }
  const start = Date.now();
  try {
    const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      const sizeKb = (buffer.byteLength / 1024).toFixed(1);
      const base64 = Buffer.from(buffer).toString('base64');
      const mime = res.headers.get('content-type') || 'image/jpeg';
      console.log(`  [flux] ${model} OK — ${sizeKb}KB, ${mime}`);
      return `data:${mime};base64,${base64}`;
    }
    const errBody = await res.text().catch(() => '');
    console.error(`  [flux] ${model} HTTP ${res.status}: ${errBody.slice(0, 150)}`);
    if (res.status === 503) {
      const elapsed = Date.now() - start;
      const remaining = timeoutMs - elapsed - 3000;
      if (remaining <= 0) { console.error(`  [flux] ${model} 503 retry timed out`); return null; }
      let estimated = 10;
      try { estimated = JSON.parse(errBody).estimated_time || 10; } catch {}
      const waitMs = Math.min(estimated * 1000, remaining);
      console.log(`  [flux] ${model} 503 — waiting ${waitMs}ms (retry ${retries + 1})`);
      await new Promise(r => setTimeout(r, waitMs));
      return callFlux(model, prompt, remaining, retries + 1);
    }
    return null;
  } catch (e) {
    console.error(`  [flux] ${model} network error: ${e.message?.slice(0, 120)}`);
    return null;
  }
}

async function fetchFeaturedImage(title, categories) {
  const { fluxPrompt, pixabayKeywords } = await enrichImagePrompt(title, categories);
  console.log(`  [image] Flux prompt: "${fluxPrompt.slice(0, 80)}..."`);

  let image = await callFlux(HF_FLUX_DEV, fluxPrompt, 120000);
  if (image) { console.log('  [image] <- FLUX.1-dev'); return image; }

  image = await callFlux(HF_FLUX_SCHNELL, fluxPrompt, 60000);
  if (image) { console.log('  [image] <- FLUX.1-schnell'); return image; }

  if (PIXABAY_KEY && pixabayKeywords.length > 0) {
    console.log(`  [image] Flux failed, trying Pixabay with ${pixabayKeywords.length} keyword sets`);
    for (const kw of pixabayKeywords) {
      try {
        const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(kw)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=3`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json();
          if (data.hits && data.hits.length > 0) {
            console.log(`  [image] <- Pixabay (keyword: "${kw}")`);
            return data.hits[0].webformatURL;
          }
        }
      } catch {}
    }
  }

  const seed = encodeURIComponent((title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40));
  console.log('  [image] <- Picsum (last resort)');
  return `https://picsum.photos/seed/${seed || 'default'}/1200/630`;
}

async function writePost(topic, existingPosts, postType) {
  const prompt = `You are Aethel, a writer for Aethel_AI \u2014 a blog about AI and automation for everyday people.

Voice
\u2022 First-person whenever it feels natural.
\u2022 Write like an experienced creator sharing lessons, not a teacher giving a lecture.
\u2022 Sound confident but never arrogant.
\u2022 Honest, practical, conversational and emotionally intelligent.
\u2022 Write like you're talking to one person over coffee.
\u2022 Never sound like marketing copy or corporate content.

Human Writing Rules
\u2022 Show honesty through experience instead of claiming it.
\u2022 Whenever possible, include a believable observation, small mistake, lesson learned, or moment of realization.
\u2022 Don't just explain ideas\u2014illustrate them with concrete examples.
\u2022 Assume the reader is intelligent. Don't over-explain obvious concepts.
\u2022 Prefer showing over telling.
\u2022 Add subtle emotion without becoming dramatic.
\u2022 Allow small imperfections in rhythm and phrasing so the writing feels naturally human.
\u2022 Use contractions naturally.
\u2022 Occasionally ask rhetorical questions when they improve flow.
\u2022 Vary sentence length constantly. Mix short, medium and longer sentences.
\u2022 Every paragraph should feel like the next natural thought, not another section of a template.
\u2022 Avoid sounding like you're trying to impress the reader.

Style
\u2022 Short punchy paragraphs (2-3 sentences).
\u2022 Address the reader directly ("you").
\u2022 Bold only the most important ideas.
\u2022 Explain ideas in plain English.
\u2022 Use active voice.
\u2022 Remove anything that sounds repetitive.
\u2022 Cut filler before adding more words.
\u2022 Every sentence should earn its place.

Avoid AI Patterns \u2014 never use clich\u00e9s such as: "In today's world\u2026", "The key takeaway\u2026", "It's important to note\u2026", "Harness the power\u2026", "Leverage\u2026", "Unlock\u2026", "Dive into\u2026", "Whether you're\u2026", "At the end of the day\u2026", "Seamlessly\u2026", "Transform your workflow\u2026"
\u2022 Avoid repeating the same point in different words.
\u2022 Avoid generic motivational statements.
\u2022 Avoid empty summaries.
\u2022 Avoid predictable "Problem \u2192 Solution \u2192 Conclusion" formulas.
\u2022 Avoid lists that feel mechanical.
\u2022 Avoid explaining every obvious detail.

Reader Experience
\u2022 The reader should feel: understood, respected, slightly challenged, more confident after reading.
\u2022 Each section should introduce a genuinely new idea rather than restating the previous one.

Ending
\u2022 End with one memorable sentence that feels earned\u2014not a generic summary or call to action. Leave the reader with a thought they'll remember.

Write an in-depth, original blog post on this topic:
"${topic.title}"

The post should help someone who is curious but confused about this topic. Make it practical, clear, and genuinely useful.

Generate a comprehensive, deep-dive article. Do NOT summarize or deliver short text blocks. The output must consist of an elegant introductory hook, 3 to 4 distinct structured sub-sections containing detailed paragraphs, and a mature human-sounding closing takeaway.

Write 800-1200 words with:
1. A bold opening sentence that hooks
2. 3-4 short sections with subheadings
3. What this actually means for the reader
4. A one-sentence takeaway at the end, on its own line, prefixed with **

Format in Markdown. Do NOT include a title at the top (frontmatter will be added separately). Do NOT include --- separators.`;

  const content = await callGemini(prompt);

  if (!postType) {
    const typeIndex = existingPosts.length % TYPE_CYCLE.length;
    postType = TYPE_CYCLE[typeIndex];
  }

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
featuredImage: "${await fetchFeaturedImage(topic.title, category)}"
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

  const discovered = await discoverTopics(lightweightHeadlines);
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

  newTopics = newTopics.slice(0, 5);
  console.log(`  ${newTopics.length} new topics to write\n`);

  if (newTopics.length === 0) {
    console.log('Nothing new to write. Exiting.');
    return;
  }

  let committed = 0;
  for (let i = 0; i < newTopics.length; i++) {
    const topic = newTopics[i];
    const postType = i < 2 ? 'trending' : 'standard';
    console.log(`Writing: "${topic.title}"...`);
    try {
      let { slug, markdown, type } = await writePost(topic, existingPosts, postType);

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
