import { watch, existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const QUEUE_DIR = join(process.env.HOME || '/tmp', '.aethel-backup', 'queue');
const LOG_FILE = join(process.env.HOME || '/tmp', '.aethel-backup', 'daemon.log');
const STATE_FILE = join(process.env.HOME || '/tmp', '.aethel-backup', 'state.json');
const DEBOUNCE_MS = 60000;
const RETRY_INTERVAL = 300000;

let debounceTimer = null;
let pendingChanges = new Set();
let isRunning = false;
let offline = false;

if (!existsSync(QUEUE_DIR)) {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    writeFileSync(LOG_FILE, line + '\n', { flag: 'a' });
  } catch {}
}

function shouldIgnore(path) {
  const ignore = [
    'node_modules', '.git', 'dist', '.astro', '.vercel',
    '.netlify', '.DS_Store', '.env', 'secrets', '.vite',
    '*.log', '.deploy-hook-url',
  ];
  for (const i of ignore) {
    if (i.startsWith('*') && path.endsWith(i.slice(1))) return true;
    if (path.includes('/' + i + '/') || path.includes('/' + i) || path === i) return true;
  }
  return false;
}

function onFileChange(eventType, filename) {
  if (!filename || shouldIgnore(filename)) return;
  pendingChanges.add(filename);
  log(`Change detected: ${filename}`);

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (isRunning) {
      log('Backup already running, will queue after completion');
      return;
    }
    await runBackup();
  }, DEBOUNCE_MS);
}

async function runBackup() {
  isRunning = true;
  const changed = Array.from(pendingChanges);
  pendingChanges.clear();

  log(`Running backup (${changed.length} files changed)...`);

  try {
    execSync('node "' + join(ROOT, 'scripts', 'backup.mjs') + '"', {
      stdio: 'pipe',
      cwd: ROOT,
      timeout: 300000,
      env: { ...process.env },
    });
    log('Backup completed successfully');
    isRunning = false;
    processQueuedBackups();
  } catch (e) {
    log('Backup failed: ' + e.message);
    queueBackup();
    isRunning = false;
  }
}

function queueBackup() {
  offline = true;
  const queueFile = join(QUEUE_DIR, `backup-${Date.now()}.json`);
  const state = {
    timestamp: new Date().toISOString(),
    files: Array.from(pendingChanges),
    retries: 0,
  };
  writeFileSync(queueFile, JSON.stringify(state, null, 2));
  log('Backup queued to: ' + queueFile);
}

function processQueuedBackups() {
  try {
    const files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      offline = false;
      return;
    }

    log('Processing ' + files.length + ' queued backup(s)...');
    for (const file of files) {
      const filePath = join(QUEUE_DIR, file);
      try {
        const state = JSON.parse(readFileSync(filePath, 'utf-8'));
        execSync('node "' + join(ROOT, 'scripts', 'backup.mjs') + '"', {
          stdio: 'pipe',
          cwd: ROOT,
          timeout: 300000,
          env: { ...process.env },
        });
        unlinkSync(filePath);
        log('Queued backup processed: ' + file);
      } catch (e) {
        const state = JSON.parse(readFileSync(filePath, 'utf-8'));
        state.retries = (state.retries || 0) + 1;
        if (state.retries >= 5) {
          log('Dropping backup after 5 retries: ' + file);
          unlinkSync(filePath);
        } else {
          writeFileSync(filePath, JSON.stringify(state, null, 2));
          log('Retry failed, will try again: ' + file);
        }
      }
    }
    offline = files.length > 0;
  } catch {}
}

async function retryLoop() {
  setInterval(() => {
    if (!isRunning) {
      processQueuedBackups();
    }
  }, RETRY_INTERVAL);
}

log('=== Backup Daemon Started ===');
log('Watching: ' + ROOT);
log('Debounce: ' + DEBOUNCE_MS + 'ms');
log('Queue: ' + QUEUE_DIR);
log('');

try {
  watch(ROOT, { recursive: true }, onFileChange);
  log('File watcher active');
} catch (e) {
  log('Failed to start watcher: ' + e.message);
  process.exit(1);
}

retryLoop();

process.on('SIGINT', () => {
  log('Daemon stopped');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Daemon stopped');
  process.exit(0);
});
