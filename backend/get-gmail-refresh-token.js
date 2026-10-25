// ============================================================
// ONE-TIME SETUP SCRIPT -- get a Gmail API refresh token
// ============================================================
// Run this ONCE, locally, to authorize PharmaTrack to send email as
// pharma.track.ph@gmail.com via the Gmail API. Not part of the running
// app itself -- safe to delete after you've copied the refresh token
// into .env, or just leave it here, it does nothing unless you run it.
//
// Usage:
//   1. cd backend
//   2. npm install googleapis
//   3. node get-gmail-refresh-token.js
//   4. It prints a URL -- open it in your browser, sign in as
//      pharma.track.ph@gmail.com, click Allow.
//   5. It catches the result automatically and prints a refresh token.
//   6. Copy that into .env as GMAIL_OAUTH_REFRESH_TOKEN.
//
// Requires GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET to
// already be in .env (see the "Desktop app" OAuth client you just
// created in Google Cloud Console).
// ============================================================
require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url  = require('url');

const CLIENT_ID     = process.env.GMAIL_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET;
const PORT           = 3000;
const REDIRECT_URI    = `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('\nMissing GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET in .env -- add those first.\n');
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // required -- without this, Google only gives a short-lived access token, no refresh token
    prompt:      'consent', // forces a fresh refresh token even if you've authorized this app before
    scope:       ['https://www.googleapis.com/auth/gmail.send']
});

console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in as pharma.track.ph@gmail.com and click Allow.\n');
console.log('Waiting...\n');

const server = http.createServer(async (req, res) => {
    const parsed = new url.URL(req.url, REDIRECT_URI);
    const code   = parsed.searchParams.get('code');

    if (!code) {
        res.end('No authorization code received -- check the terminal for details.');
        return;
    }

    res.end('Success! You can close this tab and go back to your terminal.');
    server.close();

    try {
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            console.log('\nNo refresh token was returned -- this usually means this app was already');
            console.log('authorized before. Go to https://myaccount.google.com/permissions, remove');
            console.log('"Pharma Track" access, then run this script again.\n');
            return;
        }

        console.log('\n================================================================');
        console.log('Your refresh token (save this in .env as GMAIL_OAUTH_REFRESH_TOKEN):');
        console.log('');
        console.log(tokens.refresh_token);
        console.log('================================================================\n');
    } catch (err) {
        console.error('\nFailed to exchange code for tokens:', err.message);
    }
});

server.listen(PORT, () => {});
