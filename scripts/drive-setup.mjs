import { createServer } from 'http';
import { randomBytes } from 'crypto';

const SCOPES = 'https://www.googleapis.com/auth/drive';
const REDIRECT_URI = 'http://localhost:3456/callback';

console.log('');
console.log('=== Google Drive OAuth Setup ===');
console.log('');
console.log('This script helps you set up OAuth 2.0 credentials for backup uploads.');
console.log('');

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('Step 1: Create OAuth 2.0 credentials in Google Cloud Console');
  console.log('   1. Go to: https://console.cloud.google.com/apis/credentials');
  console.log('   2. Click "Create Credentials" → "OAuth client ID"');
  console.log('   3. Application type: "Desktop application"');
  console.log('   4. Name: "Aethel Backup"');
  console.log('   5. Click "Create"');
  console.log('   6. Copy the Client ID and Client Secret');
  console.log('');
  console.log('Then run this script with:');
  console.log('  GOOGLE_DRIVE_CLIENT_ID=your_client_id GOOGLE_DRIVE_CLIENT_SECRET=your_client_secret node scripts/drive-setup.mjs');
  console.log('');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
  'client_id=' + encodeURIComponent(CLIENT_ID) +
  '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
  '&response_type=code' +
  '&scope=' + encodeURIComponent(SCOPES) +
  '&access_type=offline' +
  '&prompt=consent' +
  '&state=' + encodeURIComponent(state);

console.log('Step 2: Authorize the application');
console.log('   Opening browser...');
console.log('   If browser does not open, visit this URL:');
console.log('');
console.log('  ' + authUrl);
console.log('');

try {
  const { execSync } = await import('child_process');
  const platform = process.platform;
  if (platform === 'darwin') {
    execSync('open "' + authUrl + '"');
  } else if (platform === 'linux') {
    execSync('xdg-open "' + authUrl + '" 2>/dev/null || echo ""');
  }
} catch {}

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:3456');
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization failed: ' + error + '</h2><p>Please try again.</p>');
        reject(new Error('Authorization failed: ' + error));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>State mismatch! Possible CSRF attack.</h2>');
        reject(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>✅ Authorization successful!</h2><p>You can close this tab.</p>');
      server.close();
      resolve(code);
    }
  });

  server.listen(3456, () => {
    console.log('   Waiting for authorization callback on http://localhost:3456 ...');
  });

  setTimeout(() => {
    server.close();
    reject(new Error('Timeout waiting for authorization. Please try again.'));
  }, 120000);
});

console.log('');
console.log('Step 3: Exchanging authorization code for tokens...');

const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }),
});

if (!tokenResp.ok) {
  const err = await tokenResp.text();
  console.error('Token exchange failed:', err);
  process.exit(1);
}

const tokens = await tokenResp.json();

if (!tokens.refresh_token) {
  console.log('');
  console.log('⚠️  No refresh token received. This can happen if you already granted access before.');
  console.log('   Revoke access at: https://myaccount.google.com/permissions');
  console.log('   Then run this script again.');
  console.log('');
  console.log('For now, you can use the access token directly (expires in 1 hour):');
  console.log('');
  console.log('  GOOGLE_DRIVE_ACCESS_TOKEN=' + tokens.access_token);
  console.log('');
  process.exit(1);
}

console.log('');
console.log('=== Setup Complete! ===');
console.log('');
console.log('Add these 3 secrets to GitHub:');
console.log('');
console.log('1. GOOGLE_DRIVE_CLIENT_ID');
console.log('   ' + CLIENT_ID);
console.log('');
console.log('2. GOOGLE_DRIVE_CLIENT_SECRET');
console.log('   ' + CLIENT_SECRET);
console.log('');
console.log('3. GOOGLE_DRIVE_REFRESH_TOKEN');
console.log('   ' + tokens.refresh_token);
console.log('');
console.log('Also add BACKUP_DRIVE_FOLDER_ID:');
console.log('   19CDMXTuSPiU6w3ArOg4DA-QbDukLPb9C');
console.log('');
