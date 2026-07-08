import { GoogleGenAI } from '@google/genai';
import { Router } from 'express';
import { normalizeImageUrl } from '../utils.js';

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const router = Router();

const GROQ_KEY = process.env.GROQ_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
const PEXELS_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const VALID_CATS = ['AI Tools', 'Content Creation', 'Productivity', 'Workflow', 'AI News', 'Automation', 'Creativity', 'Entrepreneurship', 'Future of Work', 'Tech News', 'Business News'];

// Number of images returned from each provider search.
// Keep between 20–24 for best performance on free API tiers.
const IMAGE_SEARCH_RESULTS = 20;

const PIXABAY_CAT_MAP = {
  'Future of Work': 'business',
  'AI Tools': 'computer',
  'Content Creation': 'education',
  'Productivity': 'business',
  'Creativity': 'education',
  'AI News': 'science',
  'AI in Healthcare': 'health',
  'Automation': 'industry',
  'Entrepreneurship': 'business',
  'Workflow': 'business',
  'Industry': 'industry',
  'Tech News': 'technology',
  'Business News': 'business',
};

const SEARCH_CAT_MAP = {
  'Future of Work': 'business office',
  'AI Tools': 'technology computer',
  'Content Creation': null,
  'Productivity': 'business workflow',
  'Creativity': 'creative design',
  'AI News': 'technology science',
  'AI in Healthcare': 'health medical',
  'Automation': 'industry technology',
  'Entrepreneurship': 'business startup',
  'Workflow': 'business organization',
  'Industry': 'industry factory',
  'Tech News': 'technology news',
  'Business News': 'business news',
};

function getPixabayCategory(cat) { return PIXABAY_CAT_MAP[cat] || ''; }
function getSearchCategory(title, cat) {
  if (cat === 'Content Creation' && title) {
    const lower = title.toLowerCase();
    if (/\b(education|learning|teach|course|tutorial|class|student|school|college|university)\b/.test(lower)) return 'education';
    if (/\b(write|writing|author|story|storytelling|article|blog|content|creative)\b/.test(lower)) return 'creative writing';
    return 'creative content';
  }
  return SEARCH_CAT_MAP[cat] || '';
}

function extractKeywords(title, categories) {
  return title.replace(/[<>]/g, '').slice(0, 200).trim();
}

async function enrichImagePrompt(title, categories) {
  const prompt = `You are an expert editorial art director and visual storyteller.

Given the blog title: "${title}" (category: ${categories || 'general'})

Analyze the topic and return ONLY two valid JSON objects separated by the delimiter "---IMAGE_KEYWORDS---".

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

Second JSON object (for image search fallback):

{
  "main_subject": "primary subject",
  "secondary_subject": "secondary element",
  "environment": "setting description",
  "style": "professional",
  "image_keywords": ["keyword1 keyword2", "keyword3 keyword4", "keyword5 keyword6"]
}

Rules:
- Understand the meaning and intent behind the title — don't illustrate words literally.
- Prioritize realism unless the topic clearly benefits from illustration or 3D.
- Choose colors that match the topic (tech→blues/cyan, finance→blue/white/green, health→clean whites/greens, travel→vibrant natural).
- If people improve the story, use natural expressions in authentic environments.
- One clear focal subject, strong visual hierarchy, negative space for text overlay.
- Professional magazine cover quality.
- For the image_keywords array, provide 3 keyword strings optimized for image search (each string is a complete query like "teacher classroom laptop").`;

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
  let imageKeywords = [];

  if (text) {
    const parts = text.split('---IMAGE_KEYWORDS---');
    try {
      const first = parts[0].replace(/^\s*json\s*/i, '').trim();
      fluxJson = JSON.parse(first);
    } catch {}
    try {
      const kwPart = parts.length > 1 ? parts[1] : parts[0];
      const kwParsed = JSON.parse(kwPart.replace(/^\s*json\s*/i, '').trim());
      imageKeywords = kwParsed.image_keywords || [];
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

  return { fluxPrompt, imageKeywords };
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
  const { fluxPrompt, imageKeywords } = await enrichImagePrompt(title, categories);
  console.log(`  [image] Flux prompt: "${fluxPrompt.slice(0, 80)}..."`);

  let image = await callFlux(HF_FLUX_SCHNELL, fluxPrompt, 60000);
  if (image) { console.log('  [image] <- FLUX.1-schnell'); return image; }

  const kws = imageKeywords || [];
  const cat = categories || '';
  const searchCat = getSearchCategory(title, cat);
  const pixCat = getPixabayCategory(cat);

  if (UNSPLASH_KEY && kws.length > 0) {
    console.log(`  [image] Flux failed, trying Unsplash with ${kws.length} keyword sets`);
    for (const kw of kws) {
      const enriched = searchCat ? `${kw} ${searchCat}` : kw;
      try {
        const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(enriched)}&per_page=10&orientation=landscape&client_id=${UNSPLASH_KEY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json();
          if (data.results && data.results.length > 0) {
            const raw = data.results[0].urls.raw;
            const finalUrl = raw.includes('?') ? raw.split('?')[0] + '?w=800' : raw + '?w=800';
            console.log(`  [image] <- Unsplash (keyword: "${enriched}")`);
            return finalUrl;
          }
        }
      } catch {}
    }
  }

  if (PEXELS_KEY && kws.length > 0) {
    console.log(`  [image] Unsplash failed, trying Pexels with ${kws.length} keyword sets`);
    const pexelsHeaders = { 'Authorization': PEXELS_KEY };
    for (const kw of kws) {
      const enriched = searchCat ? `${kw} ${searchCat}` : kw;
      try {
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(enriched)}&per_page=10&orientation=landscape`;
        const res = await fetch(url, { headers: pexelsHeaders, signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json();
          if (data.photos && data.photos.length > 0) {
            console.log(`  [image] <- Pexels (keyword: "${enriched}")`);
            return data.photos[0].src.medium;
          }
          if (data.photos && data.photos.length === 0 && enriched !== kw) {
            const fallbackUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(kw)}&per_page=10&orientation=landscape`;
            const fallbackRes = await fetch(fallbackUrl, { headers: pexelsHeaders, signal: AbortSignal.timeout(5000) });
            if (fallbackRes.ok) {
              const fallbackData = await fallbackRes.json();
              if (fallbackData.photos && fallbackData.photos.length > 0) {
                console.log(`  [image] <- Pexels (fallback kw: "${kw}")`);
                return fallbackData.photos[0].src.medium;
              }
            }
          }
        }
      } catch {}
    }
  }

  if (PIXABAY_KEY && kws.length > 0) {
    console.log(`  [image] Pexels failed, trying Pixabay with ${kws.length} keyword sets`);
    for (const kw of kws) {
      try {
        let url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(kw)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=10`;
        if (pixCat) url += `&category=${pixCat}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = await res.json();
          if (data.hits && data.hits.length > 0) {
            console.log(`  [image] <- Pixabay (keyword: "${kw}"${pixCat ? `, cat: ${pixCat}` : ''})`);
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
• Make every post interactive, educative, and relatable. Every sentence must serve the specific topic—no generic filler or formulaic content.

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
• Never end with a generic summary. End with an observation that leaves the reader thinking—one memorable, earned sentence tailored to the post's topic and body, not a generic wrap-up or call to action.
• If a summary is included, it must be specific to the content and the body of the post—never a generic recap.

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
• Make every post interactive, educative, and relatable. Every sentence must serve the specific topic—no generic filler or formulaic content.

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
• Never end with a generic summary. End with an observation that leaves the reader thinking—one memorable, earned sentence tailored to the post's topic and body, not a generic wrap-up or call to action.
• If a summary is included, it must be specific to the content and the body of the post—never a generic recap.

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
      max_tokens: 8192,
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

router.post('/images/generate', async (req, res) => {
  try {
    const { title, category } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    const url = await fetchFeaturedImage(title, category || '');
    const source = url.startsWith('data:') ? 'flux' :
      url.includes('unsplash.com') ? 'unsplash' :
      url.includes('pexels.com') ? 'pexels' :
      url.includes('pixabay.com') ? 'pixabay' : 'picsum';
    return res.json({ url, source });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/images/normalize', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }
    const normalized = await normalizeImageUrl(url);
    return res.json({ normalizedUrl: normalized });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/images/search', async (req, res) => {
  const { provider, query: rawQuery } = req.body;

  let searchQuery = extractKeywords(rawQuery || 'ai', '');

  async function fetchImages(term) {
    try {
      if (provider === 'unsplash') {
        if (!process.env.UNSPLASH_ACCESS_KEY) return [];
        const response = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(term)}&per_page=${IMAGE_SEARCH_RESULTS}`, {
          headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
        });
        const json = await response.json();
        return (json.results || []).map(img => ({
          src: img.urls.regular,
          preview: img.urls.regular,
          author: img.user?.name || '',
          provider: 'unsplash'
        }));
      }

      if (provider === 'pexels') {
        if (!process.env.PEXELS_API_KEY) return [];
        const response = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(term)}&per_page=${IMAGE_SEARCH_RESULTS}`, {
          headers: { 'Authorization': process.env.PEXELS_API_KEY }
        });
        const json = await response.json();
        return (json.photos || []).map(img => ({
          src: img.src.large,
          preview: img.src.medium,
          author: img.photographer || '',
          provider: 'pexels'
        }));
      }

      if (provider === 'pixabay') {
        if (!process.env.PIXABAY_API_KEY) return [];
        const response = await fetch(`https://pixabay.com/api/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(term)}&per_page=${IMAGE_SEARCH_RESULTS}`);
        const json = await response.json();
        return (json.hits || []).map(img => ({
          src: img.webformatURL,
          preview: img.webformatURL,
          author: img.user || '',
          provider: 'pixabay'
        }));
      }
    } catch (e) {
      console.error(`Error fetching from ${provider}:`, e);
      return [];
    }
    return [];
  }

  let results = await fetchImages(searchQuery);

  if (!results || results.length === 0) {
    const words = searchQuery.split(/[,\s]+/).filter(w => w.length > 2);
    for (const word of words) {
      results = await fetchImages(word);
      if (results && results.length > 0) break;
    }
  }

  if (!results || results.length === 0) {
    results = await fetchImages("artificial intelligence");
  }

  return res.json(results);
});

router.post('/content/complete', async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    const prompt = `You are an AI writing assistant that completes blog posts for Aethel_AI, a blog about AI and automation for everyday people.

Below is an existing blog post that was truncated (cut off mid-sentence). Your task is to COMPLETE it without changing a single word of the existing text.

EXISTING TITLE:
${title}

EXISTING CONTENT:
${body}

INSTRUCTIONS:
1. Do NOT modify, remove, or rewrite any existing text. Append only.
2. Analyze the writing style of the existing content — its sentence structure, vocabulary, use of examples, paragraph length, and overall tone.
3. Complete the content naturally from where it was cut off.
4. Target total article length: 800-1200 words (including existing content).
5. Maintain the "Aethel voice": professional yet conversational, insightful yet accessible, uses real-world examples, first-person when natural.
6. End with a "The Takeaway" section with 3 key points marked as **Takeaway 1**, **Takeaway 2**, **Takeaway 3**.
7. Format in Markdown.

Output ONLY the completed portion — the text that should be appended to the existing content. Do not repeat any existing text.`;

    const completed = await callGroq(prompt);
    if (!completed) {
      return res.status(500).json({ error: 'Completion failed: Groq returned empty response' });
    }

    return res.json({ completedContent: completed });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
