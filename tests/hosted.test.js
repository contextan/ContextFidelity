import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { serverConfig, supportsLoopbackChatGptOAuth } from '../src/config.js';

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-hosted-'));
  const port = 26000 + Math.floor(Math.random() * 2000);
  let app;
  const start = async () => { app = createApp({ directory, port, mode: 'hosted', ...options }); await new Promise(r => app.server.listen(port, '127.0.0.1', r)); return app; };
  await start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const visitor = async cookie => {
    const response = await fetch(app.origin + '/api/state', { headers: { Connection: 'close', ...(cookie ? { Cookie: cookie } : {}) } });
    const state = await response.json();
    return { cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie, state };
  };
  const call = (v, path, data, extra = {}) => fetch(app.origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { Connection: 'close', Cookie: v.cookie, 'X-ContextFidelity-Token': v.state.csrf, 'Content-Type': 'application/json', ...extra }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  return { directory, get app() { return app; }, start, visitor, call };
}

test('hosted visitors cannot read another visitor project, message, run, export or credentials', async t => {
  const f = await setup(t), a = await f.visitor(), b = await f.visitor();
  assert.notEqual(a.state.projects[0].id, b.state.projects[0].id);
  assert.equal(a.state.settings.provider, 'chatgpt');
  assert.deepEqual(a.state.capabilities.providers, ['chatgpt']);
  assert.equal(a.state.capabilities.oauth, true);
  const login = await f.call(a, '/api/auth/start', {});
  assert.equal(login.status, 200);
  assert.equal(new URL((await login.json()).url).searchParams.get('redirect_uri'), `${f.app.origin}/auth/callback`);
  const demo = await (await f.call(a, '/api/demo', {})).json();
  const detail = await (await f.call(a, '/api/sessions/' + demo.session.id)).json();
  for (const path of [`/api/projects/${demo.project.id}`, `/api/sessions/${demo.session.id}`, `/api/runs/${demo.run_id}`, `/api/messages/${detail.messages[0].id}`]) assert.equal((await f.call(b, path)).status, 404);
  assert.equal((await f.call(b, '/api/projects/' + demo.project.id, undefined, { 'X-ContextFidelity-Token': a.state.csrf })).status, 403);
  const exported = JSON.stringify(await (await f.call(b, '/api/export')).json());
  assert.ok(!exported.includes(demo.project.id));
  assert.equal((await f.call(a, '/api/settings', { provider: 'openai', model: 'fixture', apiKey: 'private-test-key', autoContext: true })).status, 400);
  assert.equal((await f.visitor(b.cookie)).state.auth.apiKeySet, false);
  const id = a.cookie.split('=')[1].split('.')[0];
  const credentials = readFileSync(join(f.directory, 'visitors', id, 'credentials.json'), 'utf8');
  assert.ok(!credentials.includes('private-test-key'));
  assert.equal(JSON.parse(credentials).format, 'aes-256-gcm-v1');
});

test('signed visitor session and encrypted ChatGPT OAuth credentials survive restart; SQLite export is a valid backup', async t => {
  const f = await setup(t), a = await f.visitor(), b = await f.visitor();
  const demo = await (await f.call(a, '/api/demo', {})).json();
  const visitorId = a.cookie.split('=')[1].split('.')[0];
  const runtime = f.app.manager.cache.get(visitorId);
  runtime.auth.value.accounts = [{ client_id: 'oaiapp_test', sub: 'test-subject', email: 'test@example.invalid', label: 'test@example.invalid · test', access_token: 'private-access-token', refresh_token: 'private-refresh-token', id_token: 'private-id-token', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', expires: Date.now() + 60 * 60 * 1000 }];
  runtime.auth.value.active = 'oaiapp_test';
  runtime.auth.save();
  await f.call(a, '/api/settings', { provider: 'chatgpt', model: 'test', autoContext: true });
  const credentialFile = readFileSync(join(f.directory, 'visitors', visitorId, 'credentials.json'), 'utf8');
  for (const secret of ['private-access-token', 'private-refresh-token', 'private-id-token']) assert.ok(!credentialFile.includes(secret));
  assert.equal(JSON.parse(credentialFile).format, 'aes-256-gcm-v1');
  assert.equal(b.state.auth.chatgptConnected, false);
  const response = await f.call(a, '/api/export/sqlite');
  const file = join(f.directory, 'export.sqlite'); writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const exported = new DatabaseSync(file, { readOnly: true });
  assert.equal(exported.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(exported.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 4); exported.close();
  await f.app.close(); await f.start();
  const restored = await f.visitor(a.cookie);
  assert.equal(restored.state.projects.length, 2);
  assert.equal(restored.state.auth.chatgptConnected, true);
  assert.equal(restored.state.settings.model, 'test');
  assert.equal((await f.call(restored, '/api/runs/' + demo.run_id)).status, 200);
  assert.equal((await f.call(a, '/api/export')).status, 403); // fresh per-process CSRF
});

test('hosted origin, cookies, body limits and connection gates reject unsafe requests', async t => {
  const f = await setup(t), a = await f.visitor();
  const wrongHost = await new Promise((resolve, reject) => { const req = request(f.app.origin + '/api/export', { headers: { Host: 'other.example', 'X-Forwarded-Host': new URL(f.app.origin).host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(wrongHost, 403);
  assert.equal((await f.call(a, '/api/projects', { name: 'x' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.call(a, '/api/auth/start', {})).status, 200);
  assert.equal((await f.call(a, '/api/settings', { provider: 'chatgpt' })).status, 200);
  assert.equal((await f.call(a, '/api/settings', { provider: 'openai' })).status, 400);
  assert.equal((await f.call(a, '/api/models', { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' })).status, 400);
  assert.equal((await f.call(a, '/api/auth/status')).status, 200); // web client initialization
  assert.equal((await f.call(a, '/api/projects', { name: 'x'.repeat(1_010_000) })).status, 413);
  const tampered = await f.visitor(a.cookie.slice(0, -1) + (a.cookie.endsWith('a') ? 'b' : 'a'));
  assert.notEqual(tampered.state.projects[0].id, a.state.projects[0].id);
  const cookieHeader = (await fetch(f.app.origin + '/api/state')).headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Lax/);
});

test('static pages and health do not allocate visitor DBs; workspace limits are enforced', async t => {
  const f = await setup(t, { workspaceOptions: { maxWorkspaces: 2 } });
  for (const path of ['/healthz', '/', '/ko', '/settings', '/app.js', '/styles.css']) assert.equal((await fetch(f.app.origin + path)).status, 200);
  assert.equal(readdirSync(join(f.directory, 'visitors')).length, 0);
  await f.visitor(); await f.visitor();
  assert.equal((await fetch(f.app.origin + '/api/state')).status, 429);
  assert.equal((await fetch(f.app.origin + '/healthz')).status, 200);
});

test('configuration requires canonical HTTPS public origin, with loopback allowed for testing', () => {
  assert.throws(() => serverConfig({ CONTEXTFIDELITY_MODE: 'hosted', PUBLIC_ORIGIN: 'http://example.com' }, '/tmp'));
  assert.throws(() => serverConfig({ CONTEXTFIDELITY_MODE: 'hosted', PUBLIC_ORIGIN: 'https://example.com/' }, '/tmp'));
  const c = serverConfig({ CONTEXTFIDELITY_MODE: 'hosted', PUBLIC_ORIGIN: 'https://demo.example.com', PORT: '8899' }, '/tmp');
  assert.equal(c.host, '0.0.0.0'); assert.equal(c.publicOrigin, 'https://demo.example.com');
  assert.equal(supportsLoopbackChatGptOAuth('http://127.0.0.1:8903'), true);
  assert.equal(supportsLoopbackChatGptOAuth('http://localhost:8903'), true);
  assert.equal(supportsLoopbackChatGptOAuth('https://demo.example.com'), false);
});

test('public HTTPS hosted mode never falls back to fake chat when website OAuth is unavailable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-public-hosted-'));
  const port = 28000 + Math.floor(Math.random() * 1000), host = 'demo.example.test';
  const app = createApp({ directory, port, mode: 'hosted', publicOrigin: `https://${host}` });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const localUrl = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body = '', extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = request(`${localUrl}${path}`, { method, headers: { Host: host, ...extraHeaders } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  const initial = await send('/api/state');
  assert.equal(initial.status, 200);
  const state = initial.json, cookie = initial.headers['set-cookie'][0].split(';')[0];
  assert.equal(state.settings.provider, 'chatgpt');
  assert.equal(state.capabilities.oauth, false);
  assert.deepEqual(state.capabilities.providers, []);
  const common = { Origin: `https://${host}`, Cookie: cookie, 'X-ContextFidelity-Token': state.csrf, 'Content-Type': 'application/json' };
  const login = await send('/api/auth/start', 'POST', '{}', common);
  assert.equal(login.status, 400);
  const modelList = await send('/api/models', 'POST', JSON.stringify({ provider: 'demo' }), common);
  assert.equal(modelList.status, 400);
});
