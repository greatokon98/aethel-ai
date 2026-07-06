window.AdminAPI = (function() {
  var CONFIG = {
    type: 'render',
    renderUrl: 'https://aethel-ai-e82y.onrender.com',
    owner: 'greatokon98',
    repo: 'aethel-ai',
    branch: 'main',
  };

  var GITHUB_PAT_KEY = 'aa_github_pat';
  var GITHUB_API = 'https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo;
  var BASE = CONFIG.type === 'render' ? CONFIG.renderUrl : '';

  function getPat() { return localStorage.getItem(GITHUB_PAT_KEY); }
  function storePat(token) { localStorage.setItem(GITHUB_PAT_KEY, token); }
  function removePat() { localStorage.removeItem(GITHUB_PAT_KEY); }
  function hasPat() { return !!getPat(); }

  function apiFetch(url, opts) {
    var pat = getPat();
    var o = opts || {};
    o.headers = o.headers || {};
    o.headers['Authorization'] = 'Bearer ' + pat;
    o.headers['Accept'] = 'application/vnd.github.v3+json';
    if (o.body && typeof o.body === 'object' && !(o.body instanceof FormData)) {
      o.body = JSON.stringify(o.body);
      o.headers['Content-Type'] = 'application/json';
    }
    return fetch(url, o).then(function(res) {
      if (!res.ok) {
        return res.json().then(function(e) {
          throw new Error(e.error || e.message || 'Request failed');
        }).catch(function(e) {
          if (e instanceof SyntaxError) throw new Error(res.statusText);
          throw e;
        });
      }
      return res.json();
    });
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---- GitHub file helpers (for posts/settings) ----
  function btoa(str) { return window.btoa(unescape(encodeURIComponent(str))); }
  function atob(str) {
    try { return decodeURIComponent(escape(window.atob(str))); } catch(e) { return window.atob(str); }
  }

  async function ghGetFile(path) {
    try {
      var data = await apiFetch(GITHUB_API + '/contents/' + path + '?ref=' + CONFIG.branch);
      return { content: atob(data.content), sha: data.sha };
    } catch(e) {
      if (e.message && e.message.indexOf('Not Found') !== -1) return null;
      throw e;
    }
  }

  async function ghSaveFile(path, content, sha) {
    var payload = { message: 'Update ' + path, content: btoa(content), branch: CONFIG.branch };
    if (sha) payload.sha = sha;
    var data = await apiFetch(GITHUB_API + '/contents/' + path, { method: 'PUT', body: payload });
    return data.content.sha;
  }

  async function ghDeleteFile(path, sha) {
    await apiFetch(GITHUB_API + '/contents/' + path, {
      method: 'DELETE',
      body: { message: 'Delete ' + path, sha: sha, branch: CONFIG.branch },
    });
  }

  // ---- Auth ----
  async function validatePat(token) {
    var pat = token || getPat();
    if (!pat) return false;
    try {
      if (CONFIG.type === 'render') {
        var data = await apiFetch(BASE + '/api/auth/validate');
        return data.valid;
      } else {
        var res = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/vnd.github.v3+json' },
        });
        if (!res.ok) return false;
        var repoRes = await fetch(GITHUB_API, {
          headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/vnd.github.v3+json' },
        });
        return repoRes.ok;
      }
    } catch(e) { return false; }
  }

  // ---- Posts (always GitHub) ----
  function parseFrontmatter(str) {
    var match = str.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { attrs: {}, body: str };
    var yaml = match[1];
    var body = (match[2] || '').trim();
    var attrs = {};
    var currentKey = null;
    var currentList = null;
    yaml.split('\n').forEach(function(line) {
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
    return { attrs: attrs, body: body };
  }

  function buildFrontmatter(attrs, body) {
    var lines = ['---'];
    Object.keys(attrs).forEach(function(key) {
      if (key === '_sha') return;
      var val = attrs[key];
      if (Array.isArray(val)) {
        lines.push(key + ':');
        val.forEach(function(item) { lines.push('  - "' + item + '"'); });
      } else if (typeof val === 'boolean') {
        lines.push(key + ': ' + (val ? 'true' : 'false'));
      } else if (val !== undefined && val !== null) {
        lines.push(key + ': "' + String(val).replace(/"/g, '\\"') + '"');
      }
    });
    lines.push('---');
    if (body) lines.push('', body);
    return lines.join('\n');
  }

  async function listPosts() {
    try {
      var data = await apiFetch(GITHUB_API + '/contents/src/content/posts?ref=' + CONFIG.branch);
    } catch(e) {
      if (e.message && e.message.indexOf('Not Found') !== -1) return [];
      throw e;
    }
    var files = data.filter(function(f) { return f.name.endsWith('.md'); });
    var posts = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        var content = await apiFetch(GITHUB_API + '/contents/src/content/posts/' + f.name);
        var decoded = atob(content.content);
        var parsed = parseFrontmatter(decoded);
        var slug = f.name.replace(/\.md$/, '');
        posts.push({
          slug: slug, name: f.name, sha: content.sha,
          title: parsed.attrs.title || slug, excerpt: parsed.attrs.excerpt || '',
          publishDate: parsed.attrs.publishDate || '',
          categories: parsed.attrs.categories || [], tags: parsed.attrs.tags || [],
          draft: parsed.attrs.draft || false, featured: parsed.attrs.featured || false, author: parsed.attrs.author || 'Aethel',
          featuredImage: parsed.attrs.featuredImage || '', body: parsed.body,
        });
      } catch(e) {}
    }
    posts.sort(function(a, b) { return new Date(b.publishDate) - new Date(a.publishDate); });
    return posts;
  }

  async function savePost(slug, attrs, body) {
    var content = buildFrontmatter(attrs, body);
    var path = 'src/content/posts/' + slug + '.md';
    var sha = attrs._sha || null;
    return ghSaveFile(path, content, sha);
  }

  async function deletePost(slug, sha) {
    return ghDeleteFile('src/content/posts/' + slug + '.md', sha);
  }

  // ---- Settings (always GitHub) ----
  var defaultSettings = {
    site: { title: 'Aethel_AI', tagline: 'Smart tools for everyday life — no jargon, just results.', description: 'A blog about AI, automation, and smart tools for everyday life.', copyright: 'All rights reserved.' },
    navigation: { links: [{ label: 'Home', url: '/' }, { label: 'Trending', url: '/trending', skipHeader: true }, { label: 'About', url: '/about' }, { label: 'Contact', url: '/contact' }] },
    social: { twitter: '#', github: '#', linkedin: '#' },
    design: { accentColor: '#3B82F6', accentHover: '#2563EB', primaryColor: '#0F1E36' },
    content: { heroCount: 3, postsPerPage: 12, sidebarWidgets: { search: true, trending: true, categories: true, popular: true, newsletter: true } },
    automation: { schedule: 'every 3 hours', lastRun: null, lastStatus: null },
  };

  async function loadSettings() {
    try {
      var file = await ghGetFile('src/config/site.json');
      if (!file) return JSON.parse(JSON.stringify(defaultSettings));
      var settings = JSON.parse(file.content);
      settings._sha = file.sha;
      return settings;
    } catch(e) {
      return JSON.parse(JSON.stringify(defaultSettings));
    }
  }

  async function saveSettings(settings) {
    var content = JSON.stringify(settings, null, 2);
    return ghSaveFile('src/config/site.json', content, settings._sha || null);
  }

  // ---- Messages ----
  async function loadMessages() {
    if (CONFIG.type === 'render') {
      var data = await apiFetch(BASE + '/api/messages');
      return { messages: data.messages || [] };
    } else {
      var file = await ghGetFile('data/messages.json');
      if (!file) return { messages: [], _sha: null };
      var data = JSON.parse(file.content);
      data._sha = file.sha;
      return data;
    }
  }

  async function saveMessages(data) {
    if (CONFIG.type === 'render') {
      return await apiFetch(BASE + '/api/messages', { method: 'POST', body: data });
    } else {
      var content = JSON.stringify({ messages: data.messages }, null, 2);
      return ghSaveFile('data/messages.json', content, data._sha || null);
    }
  }

  // ---- Search Queries ----
  async function loadSearchQueries() {
    if (CONFIG.type === 'render') {
      var data = await apiFetch(BASE + '/api/search-queries');
      return { queries: data.queries || [] };
    } else {
      try {
        var file = await ghGetFile('data/search-queries.json');
        if (!file) return { queries: [], _sha: null };
        var data = JSON.parse(file.content);
        data._sha = file.sha;
        return data;
      } catch(e) {
        return { queries: [], _sha: null };
      }
    }
  }

  async function saveSearchQueries(data) {
    if (CONFIG.type === 'render') {
      return await apiFetch(BASE + '/api/search-queries', { method: 'POST', body: data });
    } else {
      var content = JSON.stringify({ queries: data.queries }, null, 2);
      return ghSaveFile('data/search-queries.json', content, data._sha || null);
    }
  }

  // ---- Automation Runs ----
  async function loadAutomationRuns() {
    if (CONFIG.type === 'render') {
      var data = await apiFetch(BASE + '/api/automation-runs');
      return { runs: data.runs || [] };
    } else {
      try {
        var file = await ghGetFile('data/automation-runs.json');
        if (!file) return { runs: [], _sha: null };
        var data = JSON.parse(file.content);
        data._sha = file.sha;
        return data;
      } catch(e) {
        return { runs: [], _sha: null };
      }
    }
  }

  async function saveAutomationRuns(data) {
    if (CONFIG.type === 'render') {
      return await apiFetch(BASE + '/api/automation-runs', { method: 'POST', body: data });
    } else {
      var content = JSON.stringify({ runs: data.runs }, null, 2);
      return ghSaveFile('data/automation-runs.json', content, data._sha || null);
    }
  }

  async function triggerWorkflow() {
    if (CONFIG.type === 'render') {
      return await apiFetch(BASE + '/api/automation-runs/trigger', { method: 'POST' });
    } else {
      var pat = getPat();
      var res = await fetch('https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/actions/workflows/auto-content.yml/dispatches', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: CONFIG.branch }),
      });
      if (!res.ok) {
        var errText;
        try { var errJson = await res.json(); errText = errJson.message; } catch(e) { errText = res.statusText; }
        throw new Error(errText || 'Failed to trigger workflow');
      }
      return true;
    }
  }

  async function getWorkflowStatus() {
    var pat = getPat();
    if (!pat) return null;
    try {
      var res = await fetch('https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/actions/workflows/auto-content.yml/runs?per_page=5', {
        headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/vnd.github.v3+json' },
      });
      if (!res.ok) return null;
      var data = await res.json();
      return data.workflow_runs || [];
    } catch(e) { return null; }
  }

  // ---- Trending ----
  async function fetchTrending() {
    if (CONFIG.type === 'render') {
      try {
        var data = await apiFetch(BASE + '/api/trending');
        if (data && data.items && data.items.length) return data.items;
      } catch(e) {}
    }
    var feeds = [
      { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch' },
      { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', source: 'The Verge' },
      { url: 'https://feeds.arstechnica.com/arstechnica/index', source: 'Ars Technica' },
    ];
    var allItems = [];
    var proxy = 'https://api.rss2json.com/v1/api.json?rss_url=';
    for (var i = 0; i < feeds.length; i++) {
      try {
        var res = await fetch(proxy + encodeURIComponent(feeds[i].url));
        if (!res.ok) continue;
        var data = await res.json();
        if (data.status !== 'ok' || !data.items) continue;
        data.items.forEach(function(item) {
          allItems.push({
            title: item.title || '',
            description: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 200),
            pubDate: item.pubDate || item.pub_date || '',
            source: feeds[i].source, link: item.link || '',
          });
        });
      } catch(e) {}
    }
    allItems.sort(function(a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
    return allItems.slice(0, 30);
  }

  // ---- Popular ----
  async function fetchPopular() {
    if (CONFIG.type === 'render') {
      try {
        var data = await apiFetch(BASE + '/api/popular');
        if (data && data.items && data.items.length) return data.items;
      } catch(e) {}
    }
    var feeds = [
      { url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', source: 'NYT Tech' },
      { url: 'https://feeds.feedburner.com/TechCrunch', source: 'TechCrunch' },
      { url: 'https://www.wired.com/feed/rss', source: 'Wired' },
    ];
    var allItems = [];
    var proxy = 'https://api.rss2json.com/v1/api.json?rss_url=';
    for (var i = 0; i < feeds.length; i++) {
      try {
        var res = await fetch(proxy + encodeURIComponent(feeds[i].url));
        if (!res.ok) continue;
        var data = await res.json();
        if (data.status !== 'ok' || !data.items) continue;
        data.items.forEach(function(item) {
          allItems.push({
            title: item.title || '',
            description: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 200),
            pubDate: item.pubDate || item.pub_date || '',
            source: feeds[i].source, link: item.link || '',
          });
        });
      } catch(e) {}
    }
    allItems.sort(function(a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
    return allItems.slice(0, 30);
  }

  // ---- Public API ----
  return {
    CONFIG: CONFIG,
    getPat: getPat, storePat: storePat, removePat: removePat, hasPat: hasPat,
    validatePat: validatePat,
    listPosts: listPosts, savePost: savePost, deletePost: deletePost,
    parseFrontmatter: parseFrontmatter, buildFrontmatter: buildFrontmatter,
    loadSettings: loadSettings, saveSettings: saveSettings, defaultSettings: defaultSettings,
    loadMessages: loadMessages, saveMessages: saveMessages, generateId: generateId,
    loadSearchQueries: loadSearchQueries, saveSearchQueries: saveSearchQueries,
    loadAutomationRuns: loadAutomationRuns, saveAutomationRuns: saveAutomationRuns,
    triggerWorkflow: triggerWorkflow, getWorkflowStatus: getWorkflowStatus,
    fetchTrending: fetchTrending,
    fetchPopular: fetchPopular,
    getFile: ghGetFile, saveFile: ghSaveFile,
  };
})();
