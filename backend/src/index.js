import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { initDb } from './db.js';
import { requireAuth } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import messagesRoutes from './routes/messages.js';
import searchRoutes from './routes/search.js';
import automationRoutes from './routes/automation.js';
import trendingRoutes from './routes/trending.js';
import popularRoutes from './routes/popular.js';
import generateRoutes from './routes/generate.js';
import healthRoutes from './routes/health.js';
import postsRoutes from './routes/posts.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Public routes (no auth)
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
// Protected routes
app.use('/api/messages', requireAuth, messagesRoutes);
app.use('/api/search-queries', requireAuth, searchRoutes);
app.use('/api/automation-runs', requireAuth, automationRoutes);
app.use('/api/trending', requireAuth, trendingRoutes);
app.use('/api/popular', requireAuth, popularRoutes);
app.use('/api/generate', requireAuth, generateRoutes);
app.use('/api/posts', requireAuth, postsRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Startup
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Aethel API running on port ${PORT}`);
      console.log(`Health: http://localhost:${PORT}/api/health`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
