import { Router } from 'express';

const router = Router();

router.post('/validate', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false, error: 'Missing token' });
  }

  const pat = authHeader.slice(7).trim();
  if (!pat) {
    return res.status(401).json({ valid: false, error: 'Empty token' });
  }

  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!userRes.ok) {
      return res.json({ valid: false, error: 'Token invalid' });
    }

    const owner = process.env.GITHUB_OWNER || 'greatokon98';
    const repo = process.env.GITHUB_REPO || 'aethel-ai';
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json' },
    });

    const user = await userRes.json();
    return res.json({
      valid: repoRes.ok,
      user: { login: user.login, name: user.name || user.login, avatar: user.avatar_url },
      error: repoRes.ok ? null : `No access to ${owner}/${repo}`,
    });
  } catch (err) {
    return res.status(502).json({ valid: false, error: err.message });
  }
});

export default router;
