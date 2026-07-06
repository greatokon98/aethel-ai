import { Router } from 'express';

const router = Router();

const OWNER = process.env.GITHUB_OWNER || 'greatokon98';
const REPO = process.env.GITHUB_REPO || 'aethel-ai';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

router.get('/', async (req, res) => {
  try {
    const { sort, date, search, category, status, limit } = req.query;
    const pat = req.pat;
    const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' };

    const listUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/posts?ref=${BRANCH}`;
    const listRes = await fetch(listUrl, { headers });
    if (!listRes.ok) return res.json([]);
    const files = await listRes.json();
    const mdFiles = files.filter(f => f.name.endsWith('.md'));

    const posts = (await Promise.all(mdFiles.map(async f => {
      try {
        const contentUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/src/content/posts/${f.name}?ref=${BRANCH}`;
        const cRes = await fetch(contentUrl, { headers });
        if (!cRes.ok) return null;
        const data = await cRes.json();
        const decoded = atob(data.content);
        const parsed = parseFrontmatter(decoded);
        return {
          slug: f.name.replace(/\.md$/, ''),
          title: parsed.attrs.title || f.name,
          publishDate: parsed.attrs.publishDate || null,
          categories: parsed.attrs.categories || [],
          excerpt: parsed.attrs.excerpt || '',
          draft: parsed.attrs.draft || false,
          featured: parsed.attrs.featured || false,
          tags: parsed.attrs.tags || [],
          featuredImage: parsed.attrs.featuredImage || '',
          author: parsed.attrs.author || 'Aethel',
          sha: data.sha,
        };
      } catch { return null; }
    }))).filter(Boolean);

    let results = posts;
    if (date) results = results.filter(p => p.publishDate && String(p.publishDate).startsWith(date));
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(p => (p.title || '').toLowerCase().includes(q));
    }
    if (category && category !== 'all') results = results.filter(p => (p.categories || []).includes(category));
    if (status === 'draft') results = results.filter(p => p.draft);
    else if (status === 'published') results = results.filter(p => !p.draft);

    results.sort((a, b) => new Date(b.publishDate || 0) - new Date(a.publishDate || 0));

    if (limit) results = results.slice(0, parseInt(limit, 10));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseFrontmatter(str) {
  var attrs = {};
  var body = str;
  var match = str.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    body = (match[2] || '').trim();
    var currentKey = null, currentList = null;
    match[1].split('\n').forEach(function(line) {
      var listMatch = line.match(/^\s+-\s+(.*)$/);
      var kvMatch = line.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        if (currentKey && currentList !== null) { attrs[currentKey] = currentList; currentList = null; }
        currentKey = kvMatch[1];
        var val = kvMatch[2].replace(/^"(.*)"$/, '$1');
        if (val === 'true') attrs[currentKey] = true;
        else if (val === 'false') attrs[currentKey] = false;
        else if (val === '') { currentList = []; attrs[currentKey] = []; }
        else attrs[currentKey] = val;
      } else if (listMatch && currentKey) {
        if (currentList === null) currentList = [];
        currentList.push(listMatch[1].replace(/^"(.*)"$/, '$1'));
      }
    });
    if (currentKey && currentList !== null) attrs[currentKey] = currentList;
  }
  return { attrs, body };
}

export default router;
