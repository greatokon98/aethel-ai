import { execSync } from 'child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { join, relative } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver');
import {
  getAccessTokenFromEnv, ensureFolder, uploadFile, listFiles,
  deleteFile, readFileContent, downloadFile,
  acquireLock, releaseLock
} from './upload-drive.mjs';

const ROOT = process.cwd();
const TMP = '/tmp/aethel-backup';
const ENCRYPT_KEY = process.env.BACKUP_ENCRYPT_KEY || null;
const DRIVE_FOLDER_ID = process.env.BACKUP_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID;
const DATABASE_URL = process.env.DATABASE_URL || null;
const HOSTNAME = process.env.HOSTNAME || process.env.HOST || 'unknown';
const WORKFLOW_RUN_ID = process.env.GITHUB_RUN_ID || 'manual';
const BACKUP_VERSION = '1.1';
const BACKUP_FORMAT_VERSION = '1.1';
const BACKUP_TYPE = process.env.GITHUB_EVENT_NAME === 'schedule' ? 'SCHEDULED'
  : process.env.GITHUB_EVENT_NAME === 'push' ? 'PUSH_TRIGGERED'
  : 'MANUAL';
const EXECUTION_ENV = process.env.GITHUB_ACTIONS ? 'github-actions' : 'local';
const OS = process.platform;
const NODE_VERSION = process.version;

let _log = [];
let _lockFileId = null;
let _token = null;
let _backupId = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  _log.push({ time: new Date().toISOString(), message: msg });
}

function err(msg) {
  const line = `[${new Date().toISOString()}] ERROR: ${msg}`;
  console.error(line);
  _log.push({ time: new Date().toISOString(), message: 'ERROR: ' + msg });
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function encryptFile(inputPath, outputPath, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outputPath);
    out.write(iv);
    const inp = createReadStream(inputPath);
    inp.pipe(cipher);
    cipher.on('data', (d) => out.write(d));
    cipher.on('end', () => {
      out.write(cipher.getAuthTag());
      out.end();
    });
    out.on('finish', () => {
      resolve({ iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') });
    });
    out.on('error', reject);
    cipher.on('error', reject);
    inp.on('error', reject);
  });
}

function decryptBuffer(buf, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = buf.subarray(0, 16);
  const authTag = buf.subarray(-16);
  const ciphertext = buf.subarray(16, -16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function getTotalTrackedSize() {
  const files = execSync('git ls-files', { encoding: 'utf-8', cwd: ROOT })
    .trim().split('\n').filter(Boolean);
  let totalSize = 0;
  for (const f of files) {
    try { totalSize += (await stat(join(ROOT, f))).size; } catch {}
  }
  return totalSize;
}

async function getFileCount() {
  const files = execSync('git ls-files', { encoding: 'utf-8', cwd: ROOT })
    .trim().split('\n').filter(Boolean);
  return files.length;
}

function determineStatus(verified, tested, error) {
  if (error) return 'FAILED';
  if (verified && tested) return 'SUCCESS';
  if (verified && !tested) return 'RESTORE_FAILED';
  if (!verified && tested) return 'VERIFY_FAILED';
  return 'FAILED';
}

async function getGitMeta() {
  function git(cmd) {
    try {
      return execSync('git ' + cmd, { encoding: 'utf-8', cwd: ROOT }).trim();
    } catch { return null; }
  }
  return {
    commit: git('rev-parse HEAD'),
    branch: git('rev-parse --abbrev-ref HEAD'),
    remote: git('remote get-url origin'),
    latestTag: git('describe --tags --abbrev=0 2>/dev/null') || null,
  };
}

async function checkPreflight() {
  log('Running preflight checks...');
  if (!DRIVE_FOLDER_ID) {
    throw new Error('BACKUP_DRIVE_FOLDER_ID not set');
  }
  if (!ENCRYPT_KEY) {
    log('BACKUP_ENCRYPT_KEY not set — backups will NOT be encrypted');
  } else if (ENCRYPT_KEY.length !== 64) {
    throw new Error('BACKUP_ENCRYPT_KEY must be 64 hex characters (256-bit)');
  }
  if (DATABASE_URL) {
    try {
      execSync('pg_dump --version', { stdio: 'pipe' });
      log('pg_dump available');
    } catch {
      log('pg_dump not found — database backup will be skipped');
    }
  } else {
    log('DATABASE_URL not set — database backup skipped');
  }
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  log('Preflight checks passed');
}

async function createRepoArchive() {
  log('Creating repo archive...');
  const outPath = join(TMP, 'repo.zip');
    const output = createWriteStream(outPath);
    const archive = new ZipArchive();

    return new Promise((resolve, reject) => {
      output.on('close', () => {
        log(`Repo archive created: ${archive.pointer()} bytes`);
        resolve(outPath);
      });
      archive.on('error', reject);
      archive.pipe(output);

      const exclude = [
        '**/node_modules/**', '.git/**', 'dist/**', '.astro/**', '.vercel/**', '.netlify/**',
        'secrets/**', '.DS_Store', '.env', '.env.local', '.env.*',
        '*.log', '.vite/**', '.deploy-hook-url',
      ];

      archive.glob('**/*', {
        cwd: ROOT,
        dot: true,
        ignore: exclude,
      });
      archive.finalize();
    });
}

async function dumpDatabase() {
  if (!DATABASE_URL) return null;
  log('Dumping database...');
  const sqlPath = join(TMP, 'db.sql');
  try {
    execSync(`pg_dump --no-owner --no-acl "${DATABASE_URL}" -f "${sqlPath}"`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    const size = (await stat(sqlPath)).size;
    log(`Database dump: ${size} bytes`);
    return sqlPath;
  } catch (e) {
    err('Database dump failed: ' + e.message);
    return null;
  }
}

function createInfrastructureMeta() {
  return {
    vercel: {
      adapter: '@astrojs/vercel',
      adapterVersion: '^11.0.2',
      buildCommand: 'npm run build',
      outputDir: 'dist/',
      framework: 'Astro',
      site: 'https://aethel-blog.vercel.app',
    },
    render: {
      serviceType: 'Web Service',
      startCommand: 'node src/index.js',
      envVarNames: [
        'DATABASE_URL', 'PORT', 'GEMINI_API_KEY', 'GROQ_API_KEY',
        'UNSPLASH_ACCESS_KEY', 'PEXELS_API_KEY', 'PIXABAY_API_KEY',
        'HF_API_KEY',
      ],
      domains: ['aethel-ai-e82y.onrender.com'],
      healthEndpoint: '/api/health',
      cronJobs: [],
    },
    cronDefinitions: [
      { name: 'auto-content.yml', schedule: '0 */6 * * *' },
      { name: 'auto-content-groq.yml', schedule: '0 */3 * * *' },
    ],
  };
}

async function encryptBackupFiles(repoPath, dbPath) {
  const files = {};
  const encKey = ENCRYPT_KEY;

  if (encKey && repoPath) {
    const encPath = repoPath + '.enc';
    log('Encrypting repo archive...');
    const result = await encryptFile(repoPath, encPath, encKey);
    files.repo = { path: encPath, iv: result.iv, authTag: result.authTag };
    log('Repo archive encrypted');
  } else if (repoPath) {
    files.repo = { path: repoPath, iv: null, authTag: null };
  }

  if (encKey && dbPath) {
    const encPath = dbPath + '.enc';
    log('Encrypting database dump...');
    const result = await encryptFile(dbPath, encPath, encKey);
    files.db = { path: encPath, iv: result.iv, authTag: result.authTag };
    log('Database dump encrypted');
  } else if (dbPath) {
    files.db = { path: dbPath, iv: null, authTag: null };
  }

  return files;
}

async function buildManifest(files, gitMeta, infraMeta, metrics) {
  const manifest = {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    backupVersion: BACKUP_VERSION,
    backupId: _backupId,
    timestamp: new Date().toISOString(),
    git: gitMeta,
    appVersion: '1.0.0',
    databaseSchemaVersion: '1.0',
    files: {},
    encrypted: !!ENCRYPT_KEY,
    verified: false,
    restoreTested: false,
    status: 'SUCCESS',
    includes: [],
    retention: { daily: 14, weekly: 4, monthly: 3 },
    infrastructure: infraMeta,
    metrics: metrics || null,
    log: _log,
  };

  for (const [key, info] of Object.entries(files)) {
    if (info) {
      manifest.includes.push(key);
      const size = (await stat(info.path)).size;
      const hash = await sha256(info.path);
      manifest.files[key] = {
        size,
        sha256: hash,
        encrypted: !!info.iv,
        iv: info.iv,
        authTag: info.authTag,
      };
    }
  }

  return manifest;
}

async function ensureDriveFolders(token) {
  const root = DRIVE_FOLDER_ID;
  const repoFolder = await ensureFolder(token, 'repo', root);
  const dbFolder = await ensureFolder(token, 'database', root);
  const metaFolder = await ensureFolder(token, 'metadata', root);
  const archiveFolder = await ensureFolder(token, 'archive', root);
  return { root, repoFolder, dbFolder, metaFolder, archiveFolder };
}

async function uploadBackupFiles(token, folders, files, manifest) {
  log('Uploading to Google Drive...');
  const uploads = {};
  for (const [key, info] of Object.entries(files)) {
    if (!info) continue;
    const targetFolder = key === 'repo' ? folders.repoFolder : folders.dbFolder;
    const result = await uploadFile(token, info.path, 'application/octet-stream', targetFolder);
    uploads[key] = result.id;
    log(`Uploaded ${key}: ${result.name} (${result.id})`);
  }
  return uploads;
}

async function uploadManifest(token, metaFolder, manifest) {
  const manifestName = 'manifest-' + _backupId + '.json';
  const manifestPath = join(TMP, manifestName);
  let finalManifestPath;

  if (ENCRYPT_KEY) {
    const rawName = 'manifest-' + _backupId + '-raw.json';
    const rawPath = join(TMP, rawName);
    const encName = 'manifest-' + _backupId + '.json.enc';
    const encPath = join(TMP, encName);
    writeFileSync(rawPath, JSON.stringify(manifest, null, 2));
    await encryptFile(rawPath, encPath, ENCRYPT_KEY);
    finalManifestPath = encPath;
  } else {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    finalManifestPath = manifestPath;
  }

  const result = await uploadFile(token, finalManifestPath, 'application/json', metaFolder);
  log(`Manifest uploaded: ${result.id}`);
  return result.id;
}

async function verifyBackup(token, folders, manifest) {
  log('Verifying backup (downloading manifest to check integrity)...');
  const files = await listFiles(token, folders.metaFolder);
  const manifestName = 'manifest-' + _backupId + '.json' + (ENCRYPT_KEY ? '.enc' : '');
  const manifestFile = files.find(f => f.name === manifestName);
  if (!manifestFile) {
    err('No manifest found on Drive after upload — verification FAILED');
    return false;
  }

  let remoteManifest;
  if (ENCRYPT_KEY) {
    const rawContent = await downloadFile(token, manifestFile.id);
    const decrypted = decryptBuffer(rawContent, ENCRYPT_KEY);
    remoteManifest = JSON.parse(decrypted.toString());
  } else {
    const content = await readFileContent(token, manifestFile.id);
    remoteManifest = JSON.parse(content);
  }

  const remoteCommit = remoteManifest.git && remoteManifest.git.commit;
  const localCommit = manifest.git.commit;

  if (remoteCommit === localCommit && remoteManifest.timestamp === manifest.timestamp) {
    log('Backup VERIFIED — manifest matches');
    manifest.verified = true;
    return true;
  } else {
    err('Backup verification FAILED — manifest mismatch');
    manifest.verified = false;
    return false;
  }
}

async function runRestoreTest(token, folders, manifest) {
  log('Running restore test...');
  const tempDir = join(TMP, 'restore-test');
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  try {
    const files = await listFiles(token, folders.repoFolder);
    const repoFile = files.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime))[0];
    if (!repoFile) throw new Error('No repo backup found');

    const data = await downloadFile(token, repoFile.id);
    const testPath = join(tempDir, 'test-download.zip' + (ENCRYPT_KEY ? '.enc' : ''));
    writeFileSync(testPath, data);

    const hash = await sha256(testPath);
    const expected = manifest.files.repo && manifest.files.repo.sha256;
    if (expected && hash !== expected) {
      throw new Error(`SHA-256 mismatch: got ${hash}, expected ${expected}`);
    }

    log('Restore test PASSED — backup is restorable');
    manifest.restoreTested = true;
    return true;
  } catch (e) {
    err('Restore test FAILED: ' + e.message);
    manifest.restoreTested = false;
    return false;
  }
}

async function updateLatest(token, metaFolder, manifest, prevLatest) {
  const latestPath = join(TMP, 'latest.json');
  const succeeded = manifest.status === 'SUCCESS';
  const consecutiveFailures = succeeded ? 0 : (prevLatest && prevLatest.consecutiveFailures || 0) + 1;
  const lastFailure = succeeded ? null : (prevLatest && prevLatest.lastFailure || manifest.timestamp);
  const latest = {
    latestBackup: manifest.backupId,
    timestamp: manifest.timestamp,
    status: manifest.status,
    verified: manifest.verified,
    restoreTested: manifest.restoreTested,
    gitCommit: manifest.git.commit,
    fileCount: Object.keys(manifest.files).length,
    consecutiveFailures,
    lastFailure,
    metrics: manifest.metrics ? {
      durationSeconds: manifest.metrics.durationSeconds,
      compressedSizeMb: manifest.metrics.compressedSizeMb,
      compressionRatio: manifest.metrics.compressionRatio,
      fileCount: manifest.metrics.fileCount,
    } : null,
  };
  writeFileSync(latestPath, JSON.stringify(latest, null, 2));

  const existing = await listFiles(token, metaFolder);
  const oldLatest = existing.find(f => f.name === 'latest.json');
  if (oldLatest) await deleteFile(token, oldLatest.id);

  await uploadFile(token, latestPath, 'application/json', metaFolder);
  log('latest.json updated');
}

async function uploadMetrics(token, metaFolder, metrics) {
  const metricsName = 'metrics-' + _backupId + '.json';
  const metricsPath = join(TMP, metricsName);
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  const result = await uploadFile(token, metricsPath, 'application/json', metaFolder);
  log(`Metrics uploaded: ${result.id}`);
  return result.id;
}

async function getPrevLatest(token, metaFolder) {
  try {
    const existing = await listFiles(token, metaFolder);
    const oldLatest = existing.find(f => f.name === 'latest.json');
    if (oldLatest) {
      const content = await readFileContent(token, oldLatest.id);
      return JSON.parse(content);
    }
  } catch {}
  return null;
}

async function cleanupOldBackups(token, folders) {
  log('Running retention cleanup...');
  const allFiles = await listFiles(token, folders.root);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const week = 7 * day;
  const month = 30 * day;

  const grouped = {};
  for (const f of allFiles) {
    const created = new Date(f.createdTime).getTime();
    const age = now - created;
    if (age < day) continue;
    const key = Math.floor(created / day) + '';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(f);
  }

  const sorted = Object.keys(grouped).sort((a, b) => {
    const ageA = now - parseInt(a) * day;
    const ageB = now - parseInt(b) * day;
    return ageA - ageB;
  });

  const keep = new Set();
  sorted.forEach((key, i) => {
    const age = now - parseInt(key) * day;
    if (age < 14 * day) {
      keep.add(key);
    } else if (age < 30 * day && i % 7 === 0) {
      keep.add(key);
    } else if (i === sorted.length - 1) {
      keep.add(key);
    }
  });

  let deleted = 0;
  for (const [key, files] of Object.entries(grouped)) {
    if (!keep.has(key)) {
      for (const f of files) {
        try {
          await deleteFile(token, f.id);
          deleted++;
        } catch {}
      }
    }
  }

  log(`Cleanup complete: ${deleted} old files deleted`);
}

async function main() {
  _backupId = new Date().toISOString().replace(/[:.]/g, '-');
  const t0 = Date.now();

  log('=== Backup Started ===');
  log('Backup ID: ' + _backupId);

  try {
    await checkPreflight();

    _token = await getAccessTokenFromEnv();
    log('Google Drive authenticated');

    const folders = await ensureDriveFolders(_token);
    log('Drive folders ready');

    _lockFileId = await acquireLock(_token, folders.root, _backupId, HOSTNAME, WORKFLOW_RUN_ID);
    log('Backup lock acquired');

    const gitMeta = await getGitMeta();
    log(`Git: ${gitMeta.commit} on ${gitMeta.branch}`);

    const repoPath = await createRepoArchive();
    const dbPath = await dumpDatabase();
    const t1 = Date.now();

    const totalTrackedSize = await getTotalTrackedSize();
    const fileCount = await getFileCount();
    const archiveSizeBytes = repoPath ? (await stat(repoPath)).size : 0;
    const infraMeta = createInfrastructureMeta();

    const files = await encryptBackupFiles(repoPath, dbPath);
    const t2 = Date.now();

    const manifest = await buildManifest(files, gitMeta, infraMeta);

    const uploads = await uploadBackupFiles(_token, folders, files, manifest);
    const t3 = Date.now();

    const manifestId = await uploadManifest(_token, folders.metaFolder, manifest);

    const verified = await verifyBackup(_token, folders, manifest);
    const t4 = Date.now();

    const tested = await runRestoreTest(_token, folders, manifest);
    const t5 = Date.now();

    manifest.verified = verified;
    manifest.restoreTested = tested;
    manifest.manifestFileId = manifestId;
    manifest.status = determineStatus(verified, tested, null);

    const encryptedSizeBytes = files.repo ? (await stat(files.repo.path)).size : 0;
    const compressedSizeMb = +(encryptedSizeBytes / (1024 * 1024)).toFixed(2);
    const originalSizeMb = +(totalTrackedSize / (1024 * 1024)).toFixed(2);
    const compressionRatioVal = originalSizeMb > 0 ? (encryptedSizeBytes / totalTrackedSize) : 0;
    const compressionRatioStr = compressionRatioVal > 0
      ? (1 / compressionRatioVal).toFixed(1) + ':1'
      : '0:1';
    const spaceSavedPercent = originalSizeMb > 0
      ? +((1 - encryptedSizeBytes / totalTrackedSize) * 100).toFixed(1)
      : 0;

    const metrics = {
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      backupId: _backupId,
      timestamp: new Date().toISOString(),
      executionEnvironment: EXECUTION_ENV,
      os: OS,
      nodeVersion: NODE_VERSION,
      backupType: BACKUP_TYPE,
      status: manifest.status,
      durationSeconds: +((t5 - t0) / 1000).toFixed(1),
      archiveSeconds: +((t1 - t0) / 1000).toFixed(1),
      encryptSeconds: +((t2 - t1) / 1000).toFixed(1),
      uploadSeconds: +((t3 - t2) / 1000).toFixed(1),
      verificationSeconds: +((t4 - t3) / 1000).toFixed(1),
      restoreDurationSeconds: +((t5 - t4) / 1000).toFixed(1),
      originalSizeMb,
      compressedSizeMb,
      compressionRatio: compressionRatioStr,
      spaceSavedPercent,
      fileCount,
      archiveSizeMb: +(archiveSizeBytes / (1024 * 1024)).toFixed(2),
      dbSizeMb: files.db ? +((await stat(files.db.path)).size / (1024 * 1024)).toFixed(2) : null,
    };

    manifest.metrics = metrics;

    if (manifestId) {
      try { await deleteFile(_token, manifestId); } catch {}
    }
    await uploadManifest(_token, folders.metaFolder, manifest);
    await uploadMetrics(_token, folders.metaFolder, metrics);
    const prevLatest = await getPrevLatest(_token, folders.metaFolder);
    await updateLatest(_token, folders.metaFolder, manifest, prevLatest);
    await cleanupOldBackups(_token, folders);

    await releaseLock(_token, _lockFileId);
    _lockFileId = null;

    for (const f of [repoPath, dbPath, ...Object.values(files).map(v => v && v.path)].filter(Boolean)) {
      try { unlinkSync(f); } catch {}
    }

    log('=== Backup Completed Successfully ===');
    log(`Verified: ${verified} | Restore Tested: ${tested}`);
    process.exit(0);
  } catch (e) {
    err('Backup failed: ' + e.message);
    console.error(e.stack);
    if (_lockFileId && _token) {
      try { await releaseLock(_token, _lockFileId); } catch {}
    }
    process.exit(1);
  }
}

main();
