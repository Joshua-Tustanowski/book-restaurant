import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { google } from 'googleapis';

const ROOT = path.resolve(import.meta.dirname, '..');
const CREDENTIALS_PATH = path.join(ROOT, 'credentials.json');
const TOKEN_PATH = path.join(ROOT, 'token.json');

// gmail.modify covers read + label changes + sending replies in-thread
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Missing ${CREDENTIALS_PATH}`);
    console.error('Create an OAuth client (Desktop app type) in Google Cloud Console,');
    console.error('download the JSON, save it as credentials.json in the repo root.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function getOAuthClient() {
  const creds = loadCredentials();
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

async function promptForCode(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

export async function getAuthedClient() {
  const oAuth2Client = getOAuthClient();

  // googleapis auto-refreshes the access_token in-memory using the refresh_token,
  // but won't persist the new one unless we catch this event ourselves.
  oAuth2Client.on('tokens', (tokens) => {
    const existing = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
  });

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  console.log('Authorize this app by visiting:\n', authUrl);
  const code = await promptForCode('\nPaste the code from that page here: ');
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Token saved to ${TOKEN_PATH}`);
  return oAuth2Client;
}

// Run directly: `npm run auth` to do the one-time OAuth dance
if (import.meta.url === `file://${process.argv[1]}`) {
  getAuthedClient().then(() => {
    console.log('Auth OK.');
    process.exit(0);
  }).catch((err) => {
    console.error('Auth failed:', err);
    process.exit(1);
  });
}
