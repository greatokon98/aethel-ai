import { Router } from 'express';

const router = Router();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const VALID_CATS = ['AI Tools', 'Content Creation', 'Productivity', 'Workflow', 'AI News', 'Automation', 'Creativity', 'Entrepreneurship', 'Future of Work'];

async function fetchFeaturedImage(query) {
  if (UNSPLASH_KEY) {
    try {
      const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)},technology&w=1200&h=630&fit=crop`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Client-ID ${UNSPLASH_KEY}`, 'Accept-Version': 'v1' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        return `${data.urls.raw}&w=1200&h=630&fit=crop`;
      }
    } catch {}
  }
  if (PIXABAY_KEY) {
    try {
      const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=3`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.hits && data.hits.length > 0) {
          return data.hits[0].largeImageURL;
        }
      }
    } catch {}
  }
  const seed = encodeURIComponent(query.split(' ').slice(0, 5).join('-').toLowerCase());
  return `https://picsum.photos/seed/${seed}/1200/630`;
}

function buildPrompt(title) {
  return `You are Aethel, a writer for Aethel_AI — a blog about AI and automation for everyday people.

Your voice and style:
- First-person, honest, practical, anti-hype
- Short punchy paragraphs (2-3 sentences max)
- Bold for **emphasis** on key concepts
- No jargon — explain everything clearly
- Share real results and practical takeaways
- Address the reader directly ("you")
- Use subheadings as short questions or phrases
- End with a one-sentence takeaway

Write a blog post based on this trending topic: "${title}"

First, write exactly ONE sentence as an excerpt that summarizes the post.

Then write the full post (500-700 words) with:
1. A bold opening sentence that hooks
2. 3-4 short sections with subheadings
3. What this actually means for the reader
4. A one-sentence takeaway at the end, on its own line, prefixed with **

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

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2500 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    const isHtml = err.trim().startsWith('<!');
    const clean = isHtml ? 'API key invalid or not enabled. Check GEMINI_API_KEY in Render env vars.' : err.slice(0, 200);
    throw new Error(`Gemini error (${res.status}): ${clean}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2500,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const prompt = buildPrompt(title);
    let text = '';
    let used = '';

    if (GEMINI_KEY) {
      try {
        text = await callGemini(prompt);
        used = 'gemini';
      } catch (err) {
        console.warn('Gemini failed, trying OpenAI:', err.message);
      }
    }

    if (!text && OPENAI_KEY) {
      try {
        text = await callOpenAI(prompt);
        used = 'openai';
      } catch (err) {
        console.warn('OpenAI also failed:', err.message);
      }
    }

    if (!text) {
      return res.status(500).json({
        error: 'All AI providers failed. Check your API keys (GEMINI_API_KEY, OPENAI_API_KEY) in Render env vars.',
      });
    }

    const { body, excerpt, category, tags } = parseResponse(text);
    const featuredImage = await fetchFeaturedImage(title);

    return res.json({
      content: {
        title: title,
        excerpt: excerpt,
        body: body,
        category: category,
        tags: tags,
        featuredImage: featuredImage,
        _provider: used,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
