import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM automation_runs ORDER BY timestamp DESC LIMIT 50');
    return res.json({ runs: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { status, result } = req.body || {};
  try {
    const r = await pool.query(
      'INSERT INTO automation_runs (status, result) VALUES ($1, $2) RETURNING *',
      [status || '', result || '']
    );
    return res.json({ run: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/trigger', async (req, res) => {
  const pat = req.pat;
  const owner = process.env.GITHUB_OWNER || 'greatokon98';
  const repo = process.env.GITHUB_REPO || 'aethel-ai';

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/auto-content.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (!ghRes.ok) {
      const err = await ghRes.text();
      return res.status(502).json({ error: 'GitHub workflow trigger failed', detail: err.slice(0, 200) });
    }

    await pool.query(
      'INSERT INTO automation_runs (status, result) VALUES ($1, $2)',
      ['triggered', 'Workflow dispatched via admin panel']
    );

    return res.json({ triggered: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

export default router;
