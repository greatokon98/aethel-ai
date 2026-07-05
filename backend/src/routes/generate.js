import { Router } from 'express';

const router = Router();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const VALID_CATS = ['AI Tools', 'Content Creation', 'Productivity', 'Workflow', 'AI News', 'Automation', 'Creativity', 'Entrepreneurship', 'Future of Work'];

router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

    const prompt = `You are Aethel, a writer for Aethel_AI — a blog about AI and automation for everyday people.

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

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2500 },
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      throw new Error(`Gemini API error (${geminiRes.status}): ${err.slice(0, 200)}`);
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

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

    return res.json({
      content: {
        title: title,
        excerpt: excerpt,
        body: body,
        category: category,
        tags: tags,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
