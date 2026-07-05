import { Router } from 'express';

const router = Router();

const GROQ_KEY = process.env.GROQ_API_KEY;
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
          return data.hits[0].webformatURL;
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

Your voice and style:
- First-person, honest, practical, anti-hype
- Short punchy paragraphs (2-3 sentences max)
- Bold for **emphasis** on key concepts
- No jargon — explain everything clearly
- Share real results and practical takeaways
- Address the reader directly ("you")
- Use subheadings as short questions or phrases
- End with a one-sentence takeaway

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
    const featuredImage = await fetchFeaturedImage(title);

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

export default router;
