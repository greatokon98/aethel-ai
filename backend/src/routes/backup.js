import { Router } from 'express';

const router = Router();

const GITHUB_TOKEN = process.env.GH_TOKEN || null;
const REPO = process.env.GITHUB_REPO || 'greatokon98/aethel-ai';
const DRIVE_CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || null;
const DRIVE_CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || null;
const DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN || null;
const DRIVE_FOLDER_ID = process.env.BACKUP_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || null;
const DRIVE_KEY_B64 = process.env.GOOGLE_DRIVE_KEY || null;

function hasDriveCredentials() {
  return !!(DRIVE_CLIENT_ID && DRIVE_CLIENT_SECRET && DRIVE_REFRESH_TOKEN) || !!DRIVE_KEY_B64;
}

async function getDriveToken() {
  if (DRIVE_KEY_B64) {
    try {
      const key = JSON.parse(Buffer.from(DRIVE_KEY_B64, 'base64').toString());
      if (key.client_email && key.private_key) return 'service-account';
    } catch {}
  }
  if (!DRIVE_CLIENT_ID || !DRIVE_CLIENT_SECRET || !DRIVE_REFRESH_TOKEN) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: DRIVE_REFRESH_TOKEN,
      client_id: DRIVE_CLIENT_ID,
      client_secret: DRIVE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token;
}

async function driveFetch(token, path) {
  const base = 'https://www.googleapis.com/drive/v3' + path;
  const res = await fetch(base, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) return null;
  return res.json();
}

async function readDriveFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) return null;
  return res.text();
}

router.get('/status', async (_req, res) => {
  try {
    const workflowUrl = `https://api.github.com/repos/${REPO}/actions/workflows/backup.yml/runs?per_page=5&status=completed`;
    const headers = { Accept: 'application/vnd.github.v3+json' };
    if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

    const workflowResp = await fetch(workflowUrl, { headers });
    const workflowData = workflowResp.ok ? await workflowResp.json() : { workflow_runs: [] };
    const runs = workflowData.workflow_runs || [];

    const lastRun = runs.length > 0 ? {
      id: runs[0].id,
      status: runs[0].status,
      conclusion: runs[0].conclusion,
      timestamp: runs[0].created_at,
      htmlUrl: runs[0].html_url,
    } : null;

    const successCount = runs.filter(r => r.conclusion === 'success').length;
    const failCount = runs.filter(r => r.conclusion === 'failure').length;
    const healthScore = calculateHealth(lastRun, successCount, failCount);

    let latestMetrics = null;
    const driveToken = await getDriveToken();
    if (driveToken && DRIVE_FOLDER_ID) {
      try {
        const metaQ = `name='metadata' and '${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const metaFolder = await driveFetch(driveToken, `/files?q=${encodeURIComponent(metaQ)}&fields=files(id,name)`);
        if (metaFolder && metaFolder.files && metaFolder.files.length > 0) {
          const metaId = metaFolder.files[0].id;
          const files = await driveFetch(driveToken, `/files?q=${encodeURIComponent(`'${metaId}' in parents and trashed=false`)}&fields=files(id,name,createdTime)&orderBy=createdTime%20desc&pageSize=10`);
          if (files && files.files) {
            const metricsFile = files.files.find(f => f.name.startsWith('metrics-'));
            if (metricsFile) {
              const content = await readDriveFile(driveToken, metricsFile.id);
              if (content) latestMetrics = JSON.parse(content);
            }
          }
        }
      } catch {}
    }

    res.json({
      health: {
        score: healthScore,
        lastBackup: lastRun ? lastRun.timestamp : null,
        lastBackupConclusion: lastRun ? lastRun.conclusion : null,
        lastBackupUrl: lastRun ? lastRun.htmlUrl : null,
        totalRuns: runs.length,
        successCount,
        failCount,
        nextScheduled: getNextCronTime(),
        driveStatus: hasDriveCredentials() ? 'ok' : 'unconfigured',
        dbStatus: process.env.DATABASE_URL ? 'ok' : 'unavailable',
        repoStatus: 'ok',
        queueDepth: 0,
        latestMetrics,
      },
    });
  } catch (e) {
    res.json({
      health: {
        score: 0,
        error: e.message,
        driveStatus: 'error',
        dbStatus: process.env.DATABASE_URL ? 'ok' : 'unavailable',
        repoStatus: 'ok',
        latestMetrics: null,
      },
    });
  }
});

router.get('/metrics', async (_req, res) => {
  try {
    const driveToken = await getDriveToken();
    if (!driveToken || !DRIVE_FOLDER_ID) {
      return res.json({ metrics: null, error: 'Drive not configured' });
    }
    if (driveToken === 'service-account') {
      return res.json({ metrics: null, error: 'Metrics require OAuth (service account cannot list files via API on personal Drive)' });
    }

    const metaQ = `name='metadata' and '${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const metaFolder = await driveFetch(driveToken, `/files?q=${encodeURIComponent(metaQ)}&fields=files(id,name)`);
    if (!metaFolder || !metaFolder.files || metaFolder.files.length === 0) {
      return res.json({ metrics: null, error: 'Metadata folder not found' });
    }

    const metaId = metaFolder.files[0].id;
    const files = await driveFetch(driveToken, `/files?q=${encodeURIComponent(`'${metaId}' in parents and trashed=false`)}&fields=files(id,name,createdTime)&orderBy=createdTime%20desc&pageSize=20`);
    if (!files || !files.files) {
      return res.json({ metrics: null, error: 'No files found' });
    }

    const metricsFiles = files.files.filter(f => f.name.startsWith('metrics-') && f.name.endsWith('.json'));
    const allMetrics = [];
    for (const f of metricsFiles.slice(0, 10)) {
      try {
        const content = await readDriveFile(driveToken, f.id);
        if (content) allMetrics.push(JSON.parse(content));
      } catch {}
    }

    res.json({ metrics: allMetrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/trigger', async (_req, res) => {
  try {
    const deployUrl = `https://api.github.com/repos/${REPO}/actions/workflows/backup.yml/dispatches`;
    const headers = {
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

    const resp = await fetch(deployUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: 'main' }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }

    res.json({ success: true, message: 'Backup triggered' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function calculateHealth(lastRun, successCount, failCount) {
  let score = 100;
  if (!lastRun) {
    score -= 30;
  } else if (lastRun.conclusion === 'failure') {
    score -= 20;
  }
  const total = successCount + failCount;
  if (total > 0) {
    const successRate = successCount / total;
    if (successRate < 0.8) score -= 15;
    else if (successRate < 0.95) score -= 5;
  }
  return Math.max(0, score);
}

function getNextCronTime() {
  const now = new Date();
  const hours = now.getHours();
  const next = Math.ceil((hours + 1) / 6) * 6;
  const nextDate = new Date(now);
  nextDate.setHours(next, 0, 0, 0);
  if (nextDate <= now) nextDate.setDate(nextDate.getDate() + 1);
  return nextDate.toISOString();
}

export default router;