import { execSync } from 'child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createHash, createDecipheriv } from 'crypto';
import { join } from 'path';

import {
  getAccessTokenFromEnv, listFiles, downloadFile, readFileContent, ensureFolder
} from './upload-drive.mjs';

const ROOT = process.cwd();
const TMP = '/tmp/aethel-restore';
const ENCRYPT_KEY = process.env.BACKUP_ENCRYPT_KEY || null;
const DRIVE_FOLDER_ID = process.env.BACKUP_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function err(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
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

function decryptFile(inputPath, outputPath, keyHex, ivHex, authTagHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  return new Promise((resolve, reject) => {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const out = createWriteStream(outputPath);
    const inp = createReadStream(inputPath);
    inp.pipe(decipher).pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    decipher.on('error', reject);
    inp.on('error', reject);
  });
}

function extractZip(zipPath, outputDir) {
  log('Extracting ' + zipPath + ' to ' + outputDir);
  execSync('unzip -o "' + zipPath + '" -d "' + outputDir + '"', {
    stdio: 'pipe',
    timeout: 120000,
  });
  log('Extraction complete');
}

async function getManifest(token, folders) {
  const metaFolder = await ensureFolder(token, 'metadata', DRIVE_FOLDER_ID);
  const metaFiles = await listFiles(token, metaFolder);

  let manifestFile = null;

  if (process.argv.includes('--backup')) {
    const idx = process.argv.indexOf('--backup');
    const backupId = process.argv[idx + 1];
    manifestFile = metaFiles.find(f => f.name.includes(backupId) && f.name.startsWith('manifest-'));
    if (!manifestFile) throw new Error('No manifest found for backup ID: ' + backupId);
  } else if (process.argv.includes('--latest')) {
    const latestFile = metaFiles.find(f => f.name === 'latest.json');
    if (latestFile) {
      const content = await readFileContent(token, latestFile.id);
      try {
        const latest = JSON.parse(content);
        manifestFile = metaFiles.find(f => f.name.includes(latest.latestBackup) && f.name.startsWith('manifest-'));
      } catch {}
    }
    if (!manifestFile) {
      manifestFile = metaFiles
        .filter(f => f.name.startsWith('manifest-'))
        .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime))[0];
    }
  } else {
    manifestFile = metaFiles
      .filter(f => f.name.startsWith('manifest-'))
      .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime))[0];
  }

  if (!manifestFile) throw new Error('No manifest found on Drive');

  log('Using manifest: ' + manifestFile.name + ' (created: ' + manifestFile.createdTime + ')');

    const content = await readFileContent(token, manifestFile.id);
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch {
      if (ENCRYPT_KEY) {
        const rawContent = await downloadFile(token, manifestFile.id);
        const decrypted = decryptBuffer(rawContent, ENCRYPT_KEY);
        manifest = JSON.parse(decrypted.toString());
      } else {
        throw new Error('Failed to parse manifest');
      }
    }

  return manifest;
}

function decryptBuffer(buf, keyHex, ivHex, authTagHex) {
  const key = Buffer.from(keyHex, 'hex');
  let iv, ciphertext;
  if (ivHex) {
    iv = Buffer.from(ivHex, 'hex');
    ciphertext = buf;
  } else {
    iv = buf.subarray(0, 16);
    ciphertext = buf.subarray(16);
  }
  let authTag;
  if (authTagHex) {
    authTag = Buffer.from(authTagHex, 'hex');
  } else {
    authTag = ciphertext.subarray(-16);
    ciphertext = ciphertext.subarray(0, -16);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function listAvailableBackups(token) {
  const metaFolder = await ensureFolder(token, 'metadata', DRIVE_FOLDER_ID);
  const metaFiles = await listFiles(token, metaFolder);
  const manifests = metaFiles
    .filter(f => f.name.startsWith('manifest-'))
    .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

  console.log('\nAvailable backups:\n');
  for (const m of manifests) {
    const size = m.size ? (parseInt(m.size) / 1024).toFixed(1) + ' KB' : '?';
    console.log(`  ${m.createdTime}  ${m.name}  (${size})`);
  }
  console.log();
}

async function main() {
  if (process.argv.includes('--list') || process.argv.includes('-l')) {
    const token = await getAccessTokenFromEnv();
    await listAvailableBackups(token);
    process.exit(0);
  }

  log('=== Restore Started ===');
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

  try {
    const token = await getAccessTokenFromEnv();
    log('Google Drive authenticated');

    const rootFolder = DRIVE_FOLDER_ID;
    const repoFolder = await ensureFolder(token, 'repo', rootFolder);
    const dbFolder = await ensureFolder(token, 'database', rootFolder);

    const manifest = await getManifest(token, { rootFolder, repoFolder, dbFolder });

    log('Backup from: ' + manifest.timestamp);
    log('Git commit: ' + (manifest.git && manifest.git.commit));
    log('Files to restore: ' + Object.keys(manifest.files).join(', '));
    log('Encrypted: ' + manifest.encrypted);

    for (const [key, info] of Object.entries(manifest.files)) {
      if (!info) continue;
      log('Downloading ' + key + ' (' + (info.size / 1024 / 1024).toFixed(2) + ' MB)...');

      const targetFolder = key === 'repo' ? repoFolder : dbFolder;
      const driveFiles = await listFiles(token, targetFolder);
      const driveFile = driveFiles.find(f => f.name.includes(manifest.backupId));
      if (!driveFile) {
        err('No Drive file found for ' + key + ' with ID ' + manifest.backupId);
        continue;
      }

      const data = await downloadFile(token, driveFile.id);
      const downloadPath = join(TMP, key + '.download');
      writeFileSync(downloadPath, data);

      const hash = await sha256(downloadPath);
      if (hash !== info.sha256) {
        err('SHA-256 mismatch for ' + key + '! Expected: ' + info.sha256 + ' Got: ' + hash);
        log('Continuing despite mismatch...');
      } else {
        log(key + ' checksum VERIFIED');
      }

      if (info.encrypted && info.iv && info.authTag) {
        const decPath = join(TMP, key + '.decrypted');
        if (!ENCRYPT_KEY) {
          err('File is encrypted but BACKUP_ENCRYPT_KEY not set. Skipping ' + key);
          continue;
        }
        log('Decrypting ' + key + '...');
        await decryptFile(downloadPath, decPath, ENCRYPT_KEY, info.iv, info.authTag);
        log(key + ' decrypted');

        if (key === 'repo') {
          const extractDir = join(TMP, 'restored-repo');
          extractZip(decPath, extractDir);
          log('Repo restored to: ' + extractDir);
          log('Copy with: cp -r "' + extractDir + '"/* ' + ROOT);
        } else if (key === 'db' || key === 'database') {
          log('Database dump restored to: ' + decPath);
          log('Import with: psql "' + process.env.DATABASE_URL + '" -f "' + decPath + '"');
        }
      } else {
        if (key === 'repo') {
          const extractDir = join(TMP, 'restored-repo');
          extractZip(downloadPath, extractDir);
          log('Repo restored to: ' + extractDir);
        } else if (key === 'db' || key === 'database') {
          log('Database dump at: ' + downloadPath);
        }
      }
    }

    const hasDb = manifest.files.db || manifest.files.database;

    log('=== Restore Completed ===');
    console.log('\nTo apply the restored files:');
    console.log('  cp -r "' + join(TMP, 'restored-repo') + '"/* ' + ROOT);
    if (hasDb) console.log('  psql "$DATABASE_URL" -f "' + join(TMP, 'db.decrypted') + '"');
    console.log('  npm install');
    console.log('  npm run build');
    process.exit(0);
  } catch (e) {
    err('Restore failed: ' + e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
