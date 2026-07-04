import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM search_queries ORDER BY timestamp DESC LIMIT 200');
    return res.json({ queries: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Query is required' });
  try {
    const result = await pool.query(
      'INSERT INTO search_queries (query) VALUES ($1) RETURNING *',
      [query]
    );
    return res.json({ query: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
