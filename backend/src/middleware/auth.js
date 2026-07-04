const GITHUB_API = 'https://api.github.com';
const OWNER = process.env.GITHUB_OWNER || 'greatokon98';
const REPO = process.env.GITHUB_REPO || 'aethel-ai';

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const pat = authHeader.slice(7).trim();
  if (!pat) {
    return res.status(401).json({ error: 'Token is empty' });
  }

  try {
    const userRes = await fetch(`${GITHUB_API}/user`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: 'GitHub token is invalid or expired' });
    }

    const repoRes = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!repoRes.ok) {
      return res.status(403).json({ error: `Token does not have access to ${OWNER}/${REPO}` });
    }

    const user = await userRes.json();
    req.user = { login: user.login, name: user.name || user.login, avatar: user.avatar_url };
    req.pat = pat;
    next();
  } catch (err) {
    return res.status(502).json({ error: 'Failed to validate token: ' + err.message });
  }
}
