import { readFileSync, createReadStream, statSync } from 'fs';
import { createHash, createCipheriv, createSign, randomBytes } from 'crypto';

const SCOPE = 'https://www.googleapis.com/auth/drive';

let _authToken = null;
let _tokenExpiry = 0;

let _authMode = null;

async function getAccessTokenFromEnv() {
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const accessToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;

  // Direct access token (for testing, expires in 1h)
  if (accessToken) {
    _authMode = 'access_token';
    return accessToken;
  }

  // OAuth refresh token (fall through to service account on invalid_grant)
  if (refreshToken && clientId && clientSecret) {
    try {
      _authMode = 'refresh_token';
      return await getAccessTokenFromRefreshToken(refreshToken, clientId, clientSecret);
    } catch (e) {
      if (e.message && e.message.includes('invalid_grant')) {
        console.warn('[auth] Refresh token expired/revoked, falling back to service account');
        _authMode = null;
        _authToken = null;
      } else {
        throw e;
      }
    }
  }

  // Service Account (from file or env)
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const keyJson = process.env.GOOGLE_DRIVE_KEY;

  if (keyJson) {
    _authMode = 'service_account';
    const keyData = JSON.parse(Buffer.from(keyJson, 'base64').toString());
    return getAccessTokenFromServiceAccount(keyData);
  }

  if (keyFile) {
    _authMode = 'service_account';
    const raw = readFileSync(keyFile, 'utf-8');
    const keyData = JSON.parse(raw);
    return getAccessTokenFromServiceAccount(keyData);
  }

  throw new Error('No Google Drive credentials found. Set GOOGLE_DRIVE_REFRESH_TOKEN, GOOGLE_DRIVE_ACCESS_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, or GOOGLE_DRIVE_KEY');
}

async function getAccessTokenFromRefreshToken(refreshToken, clientId, clientSecret) {
  if (_authToken && Date.now() < _tokenExpiry - 60000) {
    return _authToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Drive OAuth refresh failed: ' + err);
  }

  const data = await res.json();
  _authToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _authToken;
}

async function getAccessTokenFromServiceAccount(key) {
  if (_authToken && Date.now() < _tokenExpiry - 60000) {
    return _authToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: 'RS256', typ: 'JWT' };
  const jwtClaim = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    exp: now + 3600,
    iat: now,
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signatureInput = b64(jwtHeader) + '.' + b64(jwtClaim);

  const sign = createSign('RSA-SHA256');
  sign.update(signatureInput);
  sign.end();
  const signature = sign.sign(key.private_key, 'base64url');

  const jwt = signatureInput + '.' + signature;

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Drive Service Account auth failed: ' + err);
  }

  const data = await res.json();
  _authToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _authToken;
}

async function driveFetch(token, path, opts = {}) {
  const base = 'https://www.googleapis.com/drive/v3' + path;
  const headers = {
    Authorization: 'Bearer ' + token,
    ...(opts.headers || {}),
  };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(base, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Drive API error: ' + res.status + ' ' + err);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function ensureFolder(token, folderName, parentId) {
  let q = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const list = await driveFetch(token, `/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (list.files && list.files.length > 0) {
    return list.files[0].id;
  }

  const meta = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) meta.parents = [parentId];

  const created = await driveFetch(token, '/files?fields=id', {
    method: 'POST',
    body: JSON.stringify(meta),
  });
  return created.id;
}

export async function uploadFile(token, filePath, mimeType, parentId) {
  const stat = statSync(filePath);
  const fileName = filePath.split('/').pop();

  const meta = { name: fileName, parents: [parentId] };
  const boundary = 'boundary_' + randomBytes(16).toString('hex');
  let body = '';
  body += '--' + boundary + '\r\n';
  body += 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
  body += JSON.stringify(meta) + '\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Type: ' + mimeType + '\r\n\r\n';

  const preamble = Buffer.from(body, 'utf-8');
  const postamble = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf-8');
  const fileStream = createReadStream(filePath);
  const fileChunks = [];
  for await (const chunk of fileStream) {
    fileChunks.push(chunk);
  }
  const fileBuffer = Buffer.concat(fileChunks);

  const fullBody = Buffer.concat([preamble, fileBuffer, postamble]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': fullBody.length.toString(),
      },
      body: fullBody,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Drive upload failed: ' + res.status + ' ' + err);
  }

  return res.json();
}

export async function downloadFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { Authorization: 'Bearer ' + token },
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Drive download failed: ' + res.status + ' ' + err);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function listFiles(token, parentId, pageSize = 100) {
  const q = `'${parentId}' in parents and trashed=false`;
  const allFiles = [];
  let pageToken = null;
  do {
    let url = `/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,md5Checksum)&pageSize=${pageSize}`;
    if (pageToken) url += '&pageToken=' + pageToken;
    const result = await driveFetch(token, url);
    if (result.files) allFiles.push(...result.files);
    pageToken = result.nextPageToken || null;
  } while (pageToken);
  return allFiles;
}

export async function deleteFile(token, fileId) {
  await driveFetch(token, `/files/${fileId}`, { method: 'DELETE' });
}

export async function readFileContent(token, fileId) {
  const buf = await downloadFile(token, fileId);
  return buf.toString('utf-8');
}

export async function acquireLock(token, folderId, backupId, hostname, workflowRunId) {
  const lockName = 'backup.lock';

  const q = `name='${lockName}' and '${folderId}' in parents and trashed=false`;
  const list = await driveFetch(token, `/files?q=${encodeURIComponent(q)}&fields=files(id,createdTime)`);

  if (list.files && list.files.length > 0) {
    const existing = list.files[0];
    const created = new Date(existing.createdTime).getTime();
    const thirtyMin = 30 * 60 * 1000;
    if (Date.now() - created < thirtyMin) {
      throw new Error('Another backup is already running (lock file exists, <30min old). Wait or delete the lock.');
    }
    await deleteFile(token, existing.id);
  }

  const lockContent = JSON.stringify({
    backupId,
    startedAt: new Date().toISOString(),
    hostname: hostname || 'unknown',
    workflowRunId: workflowRunId || 'manual',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });

  const meta = {
    name: lockName,
    parents: [folderId],
    mimeType: 'application/json',
  };
  const boundary = 'boundary_' + randomBytes(16).toString('hex');
  let body = '';
  body += '--' + boundary + '\r\n';
  body += 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
  body += JSON.stringify(meta) + '\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Type: application/json\r\n\r\n';
  body += lockContent + '\r\n';
  body += '--' + boundary + '--\r\n';

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary,
      },
      body: body,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Failed to acquire lock: ' + err);
  }
  const data = await res.json();
  return data.id;
}

export async function releaseLock(token, lockFileId) {
  if (lockFileId) {
    await deleteFile(token, lockFileId);
  }
}

export { getAccessTokenFromEnv, getAccessTokenFromRefreshToken, getAccessTokenFromServiceAccount };
