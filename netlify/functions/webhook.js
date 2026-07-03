// Webhook endpoint for programmatic content creation
// POST /api/webhook with JSON body and API key header
// Creates a new markdown post in the GitHub repo via GitHub API

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'greatokon98';
const REPO_NAME = 'aethel-ai';
const API_KEY = process.env.WEBHOOK_API_KEY;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildMarkdown({ title, excerpt, content, categories, tags, author, featuredImage }) {
  const date = new Date().toISOString().split('T')[0];
  const cats = categories ? categories.map(c => `  - ${c}`).join('\n') : '';
  const tgs = tags ? tags.map(t => `  - ${t}`).join('\n') : '';
  const featuredImageLine = featuredImage ? `featuredImage: "${featuredImage}"` : '';

  return `---
title: "${title}"
excerpt: "${excerpt || ''}"
publishDate: "${date}"
${featuredImageLine}
featured: false
categories:
${cats || '  - Uncategorized'}
tags:
${tgs || '  - automation'}
author: "${author || 'Aethel'}"
---

${content}
`;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = event.headers['x-api-key'] || event.headers['authorization'];
  if (API_KEY && apiKey !== API_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!GITHUB_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GitHub token not configured' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { title, content, excerpt, categories, tags, author, featuredImage } = body;

    if (!title || !content) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'title and content are required' }) };
    }

    const slug = slugify(title);
    const markdown = buildMarkdown({ title, excerpt, content, categories, tags, author, featuredImage });
    const filePath = `src/content/posts/${slug}.md`;

    const ghResponse = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'aethel-ai-webhook',
      },
      body: JSON.stringify({
        message: `New post: ${title}`,
        content: Buffer.from(markdown).toString('base64'),
      }),
    });

    if (!ghResponse.ok) {
      const err = await ghResponse.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'GitHub API error', details: err }) };
    }

    const ghData = await ghResponse.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        slug,
        url: `https://aethel-ai.netlify.app/posts/${slug}`,
        file: filePath,
        commit: ghData.commit?.sha,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
