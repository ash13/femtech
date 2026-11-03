'use strict';

// Single-user prototype service. Put it behind an HTTPS reverse proxy before use.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.OURA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.OURA_CLIENT_SECRET || '';
const sessions = new Map();
const indexFile = path.join(__dirname, 'index.html');

function configReady() { return BASE_URL.startsWith('https://') && !!CLIENT_ID && !!CLIENT_SECRET; }

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
  }));
}
function sessionFor(req, res, create = false) {
  const id = parseCookies(req.headers.cookie).morning_eyes;
  if (id && sessions.has(id)) return sessions.get(id);
  if (!create) return null;
  const nextId = crypto.randomBytes(32).toString('hex');
  const session = {};
  sessions.set(nextId, session);
  res.setHeader('Set-Cookie', `morning_eyes=${nextId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
  return session;
}
function redirectUri() { return `${BASE_URL}/oauth/callback`; }
function randomId() { return crypto.randomBytes(32).toString('hex'); }
function base64url(buffer) { return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function exchange(body) {
  const response = await fetch('https://api.ouraring.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MorningEyes/1.0' },
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.title || `Oura token request failed (${response.status})`);
  return data;
}
async function accessToken(session) {
  if (!session?.tokens) return null;
  if (Date.now() < session.tokens.expiresAt - 60_000) return session.tokens.access_token;
  if (!session.tokens.refresh_token) { delete session.tokens; return null; }
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token });
  session.tokens = { ...refreshed, expiresAt: Date.now() + Number(refreshed.expires_in || 0) * 1000 };
  return session.tokens.access_token;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL || 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/auth/start') {
      if (!configReady()) return send(res, 503, 'Oura service setup is not finished yet.', 'text/plain; charset=utf-8');
      const session = sessionFor(req, res, true);
      const verifier = randomId();
      const state = randomId();
      session.oauth = { verifier, state };
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      const auth = new URL('https://cloud.ouraring.com/oauth/authorize');
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('client_id', CLIENT_ID);
      auth.searchParams.set('redirect_uri', redirectUri());
      auth.searchParams.set('scope', 'daily');
      auth.searchParams.set('state', state);
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      res.writeHead(302, { Location: auth.toString(), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      if (!configReady()) return send(res, 503, 'Oura service setup is not finished yet.', 'text/plain; charset=utf-8');
      const session = sessionFor(req, res);
      const oauth = session?.oauth;
      delete session?.oauth;
      if (url.searchParams.get('error')) return send(res, 400, 'Oura authorization was declined. You can close this page and try again.', 'text/plain; charset=utf-8');
      const code = url.searchParams.get('code');
      if (!session || !oauth || !code || url.searchParams.get('state') !== oauth.state) return send(res, 400, 'Oura sign-in could not be verified. Please start again.', 'text/plain; charset=utf-8');
      const tokens = await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: oauth.verifier });
      session.tokens = { ...tokens, expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000 };
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { connected: !!sessionFor(req, res)?.tokens });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const id = parseCookies(req.headers.cookie).morning_eyes;
      if (id) sessions.delete(id);
      return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': 'morning_eyes=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (req.method === 'GET' && url.pathname === '/api/sleep') {
      const session = sessionFor(req, res);
      const token = await accessToken(session);
      if (!token) return send(res, 401, { error: 'Connect Oura first.' });
      const start = url.searchParams.get('start_date') || '';
      const end = url.searchParams.get('end_date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return send(res, 400, { error: 'Invalid date range.' });
      const apiUrl = new URL('https://api.ouraring.com/v2/usercollection/daily_sleep');
      apiUrl.searchParams.set('start_date', start); apiUrl.searchParams.set('end_date', end);
      const response = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'MorningEyes/1.0' } });
      const data = await response.json().catch(() => ({}));
      return send(res, response.status, data);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(indexFile, 'utf8'), 'text/html; charset=utf-8');
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error('Request failed:', error.message);
    return send(res, 502, { error: 'Oura could not complete that request. Please try again.' });
  }
});
server.listen(PORT, HOST, () => console.log(`Morning Eyes listening on ${HOST}:${PORT}`));
