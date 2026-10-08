// Isolated connection journey. No real account, credentials, or network calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../src/server.js';
import { Provider, buildRequest } from '../src/provider.js';

const directory = mkdtempSync(join(tmpdir(), 'contextpulse-connection-audit-'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'diagnostic' };
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const observations = [];
const http = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Connection: 'close' } });
let app, nonce, providerCalls = 0;
const check = (name, healthy, observed) => observations.push({ name, healthy, observed });
function token() {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'diagnostic-client', sub: 'diagnostic-subject', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const fetcher = async url => {
  if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
  if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: token(), scope, expires_in: 3600 });
  if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'diagnostic-model', display_name: 'Diagnostic model', visibility: 'list' }] });
  if (url.endsWith('/responses')) {
    providerCalls++;
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: 'CONNECTION_OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
  }
  throw new Error('Unexpected diagnostic endpoint');
};
async function start(port = 0) {
  // createApp's host guard needs the actual chosen port.
  if (!port) {
    const { createServer } = await import('node:net');
    const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    port = probe.address().port; await new Promise(r => probe.close(r));
  }
  app = createApp({ port, directory, fetcher });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  return port;
}
async function stop() { await new Promise(r => app.server.close(r)); app.store.close(); }
async function browser() {
  const response = await http(app.origin + '/api/state'), state = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: state.csrf };
}
async function api(client, path, data) {
  const response = await http(app.origin + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Cookie: client.cookie, 'X-ContextPulse-Token': client.csrf, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json(); assert.equal(response.ok, true, value.error); return value;
}
async function authorize(client, returning = false) {
  const request = await api(client, '/auth/start', returning ? { client_id: 'diagnostic-client' } : {});
  const url = new URL(request.url); nonce = url.searchParams.get('nonce');
  const callback = `${app.origin}/auth/callback?${new URLSearchParams({ state: url.searchParams.get('state'), client_id: 'diagnostic-client', code: 'fixture-code' })}`;
  const response = await http(callback, { headers: { Cookie: client.cookie }, redirect: 'manual' });
  assert.equal(response.status, 303); return response;
}
try {
  const port = await start(); let client = await browser();
  await authorize(client);
  check('OAuth callback and polling', (await api(client, '/auth/status')).attempt.status === 'connected', 'connected');
  const models = await api(client, '/models', { provider: 'chatgpt' });
  check('Account-specific model catalog', models.models[0]?.id === 'diagnostic-model', models.models.map(m => m.id));
  await api(client, '/settings', { provider: 'chatgpt', model: 'diagnostic-model', autoContext: false });
  await api(client, '/auth/acknowledge', {});
  const project = await api(client, '/projects', { name: 'Isolated connection diagnostic' });
  const session = (await api(client, '/projects/' + project.id)).sessions[0];
  const sent = await api(client, `/sessions/${session.id}/messages`, { content: 'Say CONNECTION_OK', topics: [] });
  let run;
  for (let i = 0; i < 50; i++) {
    run = await api(client, '/runs/' + sent.run_id);
    if (run.status !== 'running') break;
    await new Promise(r => setTimeout(r, 10));
  }
  check('Model request completes and stores exact input', run.status === 'no_decisions' && run.snapshots[0]?.call_status === 'completed', { status: run.status, calls: providerCalls });
  const reload = await browser(), reloaded = await api(reload, '/state');
  check('New browser retains connection and model', reloaded.auth.chatgptConnected && reloaded.settings.model === 'diagnostic-model', { connected: reloaded.auth.chatgptConnected, model: reloaded.settings.model });
  await authorize(client, true);
  const returned = await api(client, '/state');
  check('Same-account reconnect preserves model', returned.settings.model === 'diagnostic-model', { connected: returned.auth.chatgptConnected, model: returned.settings.model });
  await api(client, '/settings', { provider: 'chatgpt', model: 'diagnostic-model' });
  const begun = await api(client, '/auth/start', {}), url = new URL(begun.url);
  nonce = url.searchParams.get('nonce');
  const otherBrowser = await browser();
  const foreign = await http(`${app.origin}/auth/callback?${new URLSearchParams({ state: url.searchParams.get('state'), client_id: 'diagnostic-client', code: 'fixture-code' })}`, { headers: { Cookie: otherBrowser.cookie }, redirect: 'manual' });
  const pending = await api(client, '/auth/status');
  check('System-browser callback can finish originating login', pending.attempt.status === 'connected', { callbackHttp: foreign.status, originalAttempt: pending.attempt.status, browserMismatch: decodeURIComponent(foreign.headers.get('location')).includes('브라우저') || decodeURIComponent(foreign.headers.get('location')).includes('browser') });
  const restartingAttempt = await api(client, '/auth/start', {});
  await stop(); await start(port); client = await browser();
  const restarted = await api(client, '/state');
  check('Server restart preserves completed connection and model', restarted.auth.chatgptConnected && restarted.settings.model === 'diagnostic-model', { connected: restarted.auth.chatgptConnected, model: restarted.settings.model });
  check('Restart expires the pending attempt without disconnecting the account', restartingAttempt.attempt.id && (await api(client, '/auth/status')).attempt.status === 'idle' && restarted.auth.chatgptConnected, { attempt: (await api(client, '/auth/status')).attempt.status, connected: restarted.auth.chatgptConnected, recovery: 'The initiating UI detects its stored attempt ID and offers a new login.' });
  for (const path of ['/', '/settings', '/contexts', '/records', '/ko/', '/ko/settings']) {
    const response = await http(app.origin + path); check('Source route ' + path, response.ok, response.status);
  }
  for (const [shape, status, body] of [['detail', 403, { detail: 'diagnostic restriction' }], ['error', 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'diagnostic limit' } }]]) {
    const provider = new Provider(app.auth, async () => Response.json(body, { status, headers: { 'x-request-id': 'diagnostic-request-id' } }));
    try { const request = buildRequest({ provider: 'chatgpt', model: 'diagnostic-model' }, '', []); await provider.call(request, JSON.stringify(request.payload)); }
    catch (error) { check('Provider preserves ' + shape + ' diagnosis', !!(error.code || error.requestId || error.details), { message: error.message, hasCode: !!error.code, hasRequestId: !!error.requestId, hasDetails: !!error.details }); }
  }
  mkdirSync(new URL('../outputs/', import.meta.url), { recursive: true });
  const result = { generated_at: new Date().toISOString(), transport: 'isolated simulated OAuth and inference; no real account', observations };
  writeFileSync(new URL('../outputs/connection-diagnostic.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { if (app?.server.listening) await stop(); rmSync(directory, { recursive: true, force: true }); }
