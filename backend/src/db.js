import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        is_read BOOLEAN DEFAULT FALSE
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS search_queries (
        id SERIAL PRIMARY KEY,
        query TEXT NOT NULL DEFAULT '',
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}

export { pool, initDb };
