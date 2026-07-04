import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM messages ORDER BY created_at DESC');
    return res.json({ messages: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { name, email, subject, message } = req.body || {};
  try {
    const result = await pool.query(
      'INSERT INTO messages (name, email, subject, message) VALUES ($1, $2, $3, $4) RETURNING *',
      [name || '', email || '', subject || '', message || '']
    );
    return res.json({ message: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/:id/read', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE messages SET is_read = TRUE WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    return res.json({ message: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
