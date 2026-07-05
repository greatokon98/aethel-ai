import { GoogleGenAI } from '@google/genai';
import { Router } from 'express';

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const router = Router();

const GROQ_KEY = process.env.GROQ_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const VALID_CATS = ['AI Tools', 'Content Creation', 'Productivity', 'Workflow', 'AI News', 'Automation', 'Creativity', 'Entrepreneurship', 'Future of Work'];

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
- Understand the meaning and intent behind the title — don't illustrate words literally.
- Prioritize realism unless the topic clearly benefits from illustration or 3D.
- Choose colors that match the topic (tech→blues/cyan, finance→blue/white/green, health→clean whites/greens, travel→vibrant natural).
- If people improve the story, use natural expressions in authentic environments.
- One clear focal subject, strong visual hierarchy, negative space for text overlay.
- Professional magazine cover quality.
- For the pixabay_keywords array, provide 3 keyword strings optimized for Pixabay search (each string is a complete query like "teacher classroom laptop").`;

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

const HF_API_KEY = process.env.HF_API_KEY;
const HF_FLUX_SCHNELL = 'black-forest-labs/FLUX.1-schnell';
const HF_INFERENCE_URL = 'https://router.huggingface.co/hf-inference/models';

async function callFlux(model, prompt, timeoutMs = 45000, retries = 0) {
  if (!HF_API_KEY) { console.error('  [flux] No HF_API_KEY set'); return null; }
  if (retries > 2) { console.error(`  [flux] ${model} max retries (2) exceeded`); return null; }
  const start = Date.now();
  try {
    const res = await fetch(`${HF_INFERENCE_URL}/${model}`, {
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

  let image = await callFlux(HF_FLUX_SCHNELL, fluxPrompt, 60000);
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

function buildPrompt(title) {
  return `You are Aethel, a writer for Aethel_AI — a blog about AI and automation for everyday people.

Voice
• First-person whenever it feels natural.
• Write like an experienced creator sharing lessons, not a teacher giving a lecture.
• Sound confident but never arrogant.
• Honest, practical, conversational and emotionally intelligent.
• Write like you're talking to one person over coffee.
• Never sound like marketing copy or corporate content.

Human Writing Rules
• Show honesty through experience instead of claiming it.
• Whenever possible, include a believable observation, small mistake, lesson learned, or moment of realization.
• Don't just explain ideas—illustrate them with concrete examples.
• Assume the reader is intelligent. Don't over-explain obvious concepts.
• Prefer showing over telling.
• Add subtle emotion without becoming dramatic.
• Allow small imperfections in rhythm and phrasing so the writing feels naturally human.
• Use contractions naturally.
• Occasionally ask rhetorical questions when they improve flow.
• Vary sentence length constantly. Mix short, medium and longer sentences.
• Every paragraph should feel like the next natural thought, not another section of a template.
• Avoid sounding like you're trying to impress the reader.

Style
• Short punchy paragraphs (2-3 sentences).
• Address the reader directly ("you").
• Bold only the most important ideas.
• Explain ideas in plain English.
• Use active voice.
• Remove anything that sounds repetitive.
• Cut filler before adding more words.
• Every sentence should earn its place.

Avoid AI Patterns — never use clichés such as: "In today's world…", "The key takeaway…", "It's important to note…", "Harness the power…", "Leverage…", "Unlock…", "Dive into…", "Whether you're…", "At the end of the day…", "Seamlessly…", "Transform your workflow…"
• Avoid repeating the same point in different words.
• Avoid generic motivational statements.
• Avoid empty summaries.
• Avoid predictable "Problem → Solution → Conclusion" formulas.
• Avoid lists that feel mechanical.
• Avoid explaining every obvious detail.

Reader Experience
• The reader should feel: understood, respected, slightly challenged, more confident after reading.
• Each section should introduce a genuinely new idea rather than restating the previous one.

Ending
• End with one memorable sentence that feels earned—not a generic summary or call to action. Leave the reader with a thought they'll remember.

Generate a comprehensive, deep-dive article based on this trending topic: "${title}"

Do NOT summarize or deliver short text blocks. The output must consist of an elegant introductory hook, 3 to 4 distinct structured sub-sections containing detailed paragraphs, and a mature human-sounding closing takeaway.

First, write exactly ONE sentence as an excerpt that summarizes the post.

Then write the full post (800-1200 words) with:
1. A bold opening sentence that hooks
2. 3-4 short sections with subheadings
3. What this actually means for the reader
4. A one-sentence takeaway at the end, on its own line, prefixed with **

Format the post in Markdown. Do NOT include a title at the top. Do NOT include --- separators.

On separate lines at the very end of your response, add:
CATEGORY: [choose one from: ${VALID_CATS.join(', ')}]
TAGS: [comma-separated tags, first tag must be "trending"]`;
}

function buildRegeneratePrompt(title, body) {
  return `You are Aethel, a writer for Aethel_AI — a blog about AI and automation for everyday people.

Voice
• First-person whenever it feels natural.
• Write like an experienced creator sharing lessons, not a teacher giving a lecture.
• Sound confident but never arrogant.
• Honest, practical, conversational and emotionally intelligent.
• Write like you're talking to one person over coffee.
• Never sound like marketing copy or corporate content.

Human Writing Rules
• Show honesty through experience instead of claiming it.
• Whenever possible, include a believable observation, small mistake, lesson learned, or moment of realization.
• Don't just explain ideas—illustrate them with concrete examples.
• Assume the reader is intelligent. Don't over-explain obvious concepts.
• Prefer showing over telling.
• Add subtle emotion without becoming dramatic.
• Allow small imperfections in rhythm and phrasing so the writing feels naturally human.
• Use contractions naturally.
• Occasionally ask rhetorical questions when they improve flow.
• Vary sentence length constantly. Mix short, medium and longer sentences.
• Every paragraph should feel like the next natural thought, not another section of a template.
• Avoid sounding like you're trying to impress the reader.

Style
• Short punchy paragraphs (2-3 sentences).
• Address the reader directly ("you").
• Bold only the most important ideas.
• Explain ideas in plain English.
• Use active voice.
• Remove anything that sounds repetitive.
• Cut filler before adding more words.
• Every sentence should earn its place.

Avoid AI Patterns — never use clichés such as: "In today's world…", "The key takeaway…", "It's important to note…", "Harness the power…", "Leverage…", "Unlock…", "Dive into…", "Whether you're…", "At the end of the day…", "Seamlessly…", "Transform your workflow…"
• Avoid repeating the same point in different words.
• Avoid generic motivational statements.
• Avoid empty summaries.
• Avoid predictable "Problem → Solution → Conclusion" formulas.
• Avoid lists that feel mechanical.
• Avoid explaining every obvious detail.

Reader Experience
• The reader should feel: understood, respected, slightly challenged, more confident after reading.
• Each section should introduce a genuinely new idea rather than restating the previous one.

Ending
• End with one memorable sentence that feels earned—not a generic summary or call to action. Leave the reader with a thought they'll remember.

Your task is to rewrite the following draft blog post on the topic: "${title}"

The draft may be incomplete, truncated, or not fully in the Aethel voice.
Complete any cut-off sentences, expand thin sections, and rewrite the entire post in the Aethel voice above.
Keep the same topic, structure, and key points.
Target 800-1200 words of finished, natural prose — no placeholders or notes.

First, write exactly ONE sentence as an excerpt that summarizes the post.

Then write the full post with:
1. A bold opening sentence that hooks
2. 3-4 short sections with subheadings
3. What this actually means for the reader
4. A one-sentence takeaway at the end, on its own line, prefixed with **

Here is the draft to rewrite:

${body}

Format the post in Markdown. Do NOT include a title at the top. Do NOT include --- separators.

On separate lines at the very end of your response, add:
CATEGORY: [choose one from: ${VALID_CATS.join(', ')}]
TAGS: [comma-separated tags, first tag must be "trending"]`;
}

function parseResponse(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let category = 'AI News';
  let tags = ['trending'];
  let bodyLines = [];

  for (const line of lines) {
    if (line.startsWith('CATEGORY:')) {
      const cat = line.replace('CATEGORY:', '').trim();
      if (VALID_CATS.includes(cat)) category = cat;
    } else if (line.startsWith('TAGS:')) {
      const raw = line.replace('TAGS:', '').trim();
      tags = raw.split(',').map(t => t.trim()).filter(Boolean);
    } else {
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join('\n');
  const firstLine = bodyLines[0] || '';
  const excerpt = firstLine.length > 160 ? firstLine.slice(0, 157) + '...' : firstLine;
  return { body, excerpt, category, tags };
}

async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
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

async function callGemini(prompt) {
  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { temperature: 0.7, maxOutputTokens: 8192 },
  });
  return response.text;
}

router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const prompt = buildPrompt(title);
    let text = '';

    if (GROQ_KEY) {
      text = await callGroq(prompt);
    }

    if (!text) {
      return res.status(500).json({
        error: 'Groq API failed. Check GROQ_API_KEY in Render env vars.',
      });
    }

    const { body, excerpt, category, tags } = parseResponse(text);
    const featuredImage = await fetchFeaturedImage(title, category);

    return res.json({
      content: {
        title: title,
        excerpt: excerpt,
        body: body,
        category: category,
        tags: tags,
        featuredImage: featuredImage,
        _provider: 'groq',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/gemini', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const prompt = buildPrompt(title);
    const text = await callGemini(prompt);

    if (!text) {
      return res.status(500).json({
        error: 'Gemini API failed. Check GEMINI_API_KEY in Render env vars.',
      });
    }

    const { body, excerpt, category, tags } = parseResponse(text);
    const featuredImage = await fetchFeaturedImage(title, category);

    return res.json({
      content: {
        title: title,
        excerpt: excerpt,
        body: body,
        category: category,
        tags: tags,
        featuredImage: featuredImage,
        _provider: 'gemini',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/regenerate', async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    const prompt = buildRegeneratePrompt(title, body);
    let text = '';

    if (GROQ_KEY) {
      text = await callGroq(prompt);
    }

    if (!text) {
      return res.status(500).json({
        error: 'Groq API failed. Check GROQ_API_KEY in Render env vars.',
      });
    }

    const parsed = parseResponse(text);
    return res.json({
      content: {
        title: title,
        excerpt: parsed.excerpt,
        body: parsed.body,
        category: parsed.category,
        tags: parsed.tags,
        _provider: 'groq',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/regenerate/gemini', async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    const prompt = buildRegeneratePrompt(title, body);
    const text = await callGemini(prompt);

    if (!text) {
      return res.status(500).json({
        error: 'Gemini API failed. Check GEMINI_API_KEY in Render env vars.',
      });
    }

    const parsed = parseResponse(text);
    const featuredImage = await fetchFeaturedImage(title, parsed.category);

    return res.json({
      content: {
        title: title,
        excerpt: parsed.excerpt,
        body: parsed.body,
        category: parsed.category,
        tags: parsed.tags,
        featuredImage: featuredImage,
        _provider: 'gemini',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/images/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }
    const keywords = extractKeywords(query);
    const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(keywords)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=12`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(502).json({ error: 'Pixabay API failed' });
    }
    const data = await response.json();
    const images = (data.hits || []).map(hit => ({
      url: hit.largeImageURL,
      preview: hit.webformatURL,
      tags: hit.tags,
      author: hit.user,
    }));
    return res.json({ images });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
