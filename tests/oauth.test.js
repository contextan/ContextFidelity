import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { Provider, buildRequest } from '../src/provider.js';
import { createApp } from '../src/server.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'oauth-test-key' };
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
function jwt(client, nonce, sub = 'subject-a') {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: client, sub, email: 'test@example.invalid', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-oauth-'));
  const calls = [], control = { tokens: {}, error: null, revoke: 200 };
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/openid-configuration')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (url.endsWith('/oauth/revoke')) return new Response('', { status: control.revoke });
    if (control.error) return Response.json({ error: control.error.code }, { status: control.error.status });
    return Response.json(control.tokens);
  };
  const auth = new Auth(directory, 'http://127.0.0.1:8899', fetcher);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const connect = async (client = 'issued-account-a', browser = 'browser-a', granted = scope, sub = 'subject-a') => {
    const url = new URL(auth.begin(browser));
    control.tokens = { access_token: `access-${client}`, refresh_token: `refresh-${client}`, id_token: jwt(client, url.searchParams.get('nonce'), sub), scope: granted, expires_in: 3600 };
    const result = await auth.callback(new URLSearchParams({ state: url.searchParams.get('state'), client_id: client, code: 'test-code' }), browser);
    return { result, url };
  };
  return { directory, auth, connect, control, calls, fetcher };
}

test('successful OAuth uses issued client, PKCE and exact redirect, persists without exposing credentials', async t => {
  const { auth, connect, calls, directory, fetcher } = setup(t);
  const { result, url } = await connect();
  assert.equal(result.status, 'connected');
  const exchange = calls.find(c => c.url.endsWith('/oauth/token'));
  const form = new URLSearchParams(exchange.options.body);
  assert.equal(form.get('client_id'), 'issued-account-a');
  assert.equal(form.get('redirect_uri'), url.searchParams.get('redirect_uri'));
  assert.ok(form.get('code_verifier')); assert.ok(!form.has('client_secret'));
  assert.equal(auth.publicStatus().chatgptConnected, true);
  assert.equal(auth.publicStatus().accounts[0].welcomePending, true);
  assert.ok(!JSON.stringify(auth.publicStatus()).includes('access-issued'));
  assert.ok(!JSON.stringify(auth.status('browser-a')).includes('verifier'));
  assert.equal(auth.status('other-browser').status, 'idle');
  auth.acknowledge(); assert.equal(auth.publicStatus().accounts[0].welcomePending, false);
  const restarted = new Auth(directory, auth.origin, fetcher);
  assert.equal(restarted.value.host_id, auth.value.host_id);
  assert.equal(restarted.publicStatus().chatgptConnected, true);
  assert.equal(statSync(auth.path).mode & 0o777, 0o600);
  await assert.rejects(auth.callback(new URLSearchParams({ state: url.searchParams.get('state'), code: 'replay', client_id: 'issued-account-a' }), 'browser-a'), /만료/);
});

test('cancelled, replaced, expired and unknown-state attempts cannot exchange codes', async t => {
  const { auth, calls } = setup(t);
  const old = new URL(auth.begin('browser-a')), current = new URL(auth.begin('browser-a'));
  await assert.rejects(auth.callback(new URLSearchParams({ state: old.searchParams.get('state'), code: 'old', client_id: 'issued' }), 'browser-a'));
  await assert.rejects(auth.callback(new URLSearchParams({ state: 'unknown-state', code: 'foreign', client_id: 'issued' }), 'browser-b'));
  assert.equal(auth.status('browser-a').status, 'pending');
  auth.cancel('browser-a'); assert.equal(auth.status('browser-a').status, 'cancelled');
  await assert.rejects(auth.callback(new URLSearchParams({ state: current.searchParams.get('state'), code: 'cancelled', client_id: 'issued' }), 'browser-a'));
  const expired = new URL(auth.begin('browser-a'));
  auth.pending.get(expired.searchParams.get('state')).expires = Date.now() - 1;
  assert.equal(auth.status('browser-a').status, 'expired');
  assert.equal(calls.length, 0);
});

test('denied permission preserves the active account; reauthorization checks identity and reuses registration', async t => {
  const { auth, connect, control } = setup(t);
  await connect(); const previous = auth.account().access_token;
  const declined = new URL(auth.begin('browser-a'));
  await assert.rejects(auth.callback(new URLSearchParams({ state: declined.searchParams.get('state'), error: 'access_denied' }), 'browser-a'), /취소/);
  assert.equal(auth.status('browser-a').status, 'cancelled'); assert.equal(auth.account().access_token, previous);
  const returning = new URL(auth.begin('browser-a', 'issued-account-a'));
  assert.equal(returning.searchParams.get('client_id'), 'issued-account-a');
  assert.equal(returning.searchParams.get('id_token_hint'), auth.account().id_token);
  assert.equal(returning.searchParams.get('agent_name_hint'), null);
  control.tokens = { access_token: 'bad-subject-token', id_token: jwt('issued-account-a', returning.searchParams.get('nonce'), 'other-subject'), scope, expires_in: 3600 };
  await assert.rejects(auth.callback(new URLSearchParams({ state: returning.searchParams.get('state'), code: 'code' }), 'browser-a'), /계정/);
  assert.equal(auth.account().access_token, previous);
  assert.equal(auth.status('browser-a').status, 'failed');
});

test('identity-only login is retained but cannot make plan requests; consent retry is explicit', async t => {
  const { auth, connect } = setup(t);
  const { result } = await connect('identity-client', 'browser-a', 'openid profile email');
  assert.equal(result.status, 'permission_required');
  assert.equal(auth.publicStatus().signedIn, true); assert.equal(auth.publicStatus().chatgptConnected, false);
  await assert.rejects(auth.accessToken(), /권한/);
  const request = new URL(auth.begin('browser-a', 'identity-client', true));
  assert.equal(request.searchParams.get('prompt'), 'consent');
  assert.ok(request.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
});

test('refreshes rotate once per account and an in-flight request keeps its selected account', async t => {
  const { auth, connect, control, calls } = setup(t);
  await connect('account-a', 'a'); await connect('account-b', 'b', scope, 'subject-b');
  const first = auth.value.accounts.find(a => a.client_id === 'account-a'); first.expires = 0; delete first.access_token;
  assert.equal(auth.publicStatus().accounts.find(a => a.client_id === 'account-a').connected, true);
  control.tokens = { access_token: 'rotated-access-a', refresh_token: 'rotated-refresh-a', scope, expires_in: 3600 };
  const count = calls.filter(c => c.url.endsWith('/oauth/token')).length;
  assert.deepEqual(await Promise.all([auth.accessToken('account-a'), auth.accessToken('account-a')]), ['rotated-access-a', 'rotated-access-a']);
  assert.equal(calls.filter(c => c.url.endsWith('/oauth/token')).length - count, 1);
  const form = new URLSearchParams(calls.filter(c => c.url.endsWith('/oauth/token')).at(-1).options.body);
  assert.equal(form.get('client_id'), 'account-a'); assert.equal(form.get('scope'), null);
  assert.equal(first.refresh_token, 'rotated-refresh-a'); assert.equal(auth.account().client_id, 'account-b');
  const headers = [];
  const provider = new Provider(auth, async (_url, options) => { headers.push(options.headers.Authorization); return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: '답변' }] }] } })}\n\n`); });
  const request = buildRequest({ provider: 'chatgpt', model: 'test', accountClientId: 'account-a' }, 'instructions', []);
  await provider.call(request, JSON.stringify(request.payload));
  assert.equal(headers[0], 'Bearer rotated-access-a');
});

test('terminal refresh failures clear tokens while temporary failures preserve them', async t => {
  const { auth, connect, control } = setup(t);
  await connect(); const account = auth.account(); account.expires = 0;
  control.error = { status: 503, code: 'temporarily_unavailable' };
  await assert.rejects(auth.accessToken()); assert.ok(account.refresh_token);
  control.error = { status: 400, code: 'invalid_grant' };
  await assert.rejects(auth.accessToken()); assert.equal(account.refresh_token, undefined);
  assert.equal(auth.publicStatus().chatgptConnected, false);
  assert.equal(auth.value.accounts.length, 1);
});

test('disconnect attempts session revocation, retains registration and reports unconfirmed revocation', async t => {
  const { auth, connect, calls, control } = setup(t);
  await connect(); const host = auth.value.host_id;
  const result = await auth.disconnect(); assert.equal(result.remoteRevoked, true);
  const revoke = calls.find(c => c.url.endsWith('/oauth/revoke'));
  const form = new URLSearchParams(revoke.options.body);
  assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.get('client_id'), 'issued-account-a');
  assert.equal(auth.account(), undefined); assert.equal(auth.value.accounts[0].refresh_token, undefined);
  assert.equal(auth.value.host_id, host); assert.equal(auth.value.accounts.length, 1);
  await connect(); control.revoke = 503;
  const unavailable = await auth.disconnect();
  assert.equal(unavailable.remoteRevoked, false); assert.match(unavailable.message, /확인하지 못/);
  assert.equal(auth.value.accounts[0].access_token, undefined);
});

test('only disconnected account registrations can be removed from the saved list', async t => {
  const { auth, connect } = setup(t);
  await connect('account-a', 'a'); await connect('account-b', 'b', scope, 'subject-b');
  const stale = auth.value.accounts.find(a => a.client_id === 'account-a');
  delete stale.access_token; delete stale.refresh_token; delete stale.id_token;
  auth.value.active = stale.client_id; auth.save();
  assert.equal(auth.publicStatus().accounts.find(a => a.client_id === stale.client_id).canForget, true);
  auth.forgetDisconnected(stale.client_id);
  assert.equal(auth.value.accounts.some(a => a.client_id === stale.client_id), false);
  assert.equal(auth.value.active, null);
  assert.throws(() => auth.forgetDisconnected('account-b'), /토큰/);
  assert.equal(auth.value.accounts.length, 1);
});

test('HTTP callback, status, account models, first-use acknowledgement, cancellation and canonical host work together', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-oauth-http-'));
  const port = 24500 + Math.floor(Math.random() * 300);
  let nonce;
  const app = createApp({ port, directory, fetcher: async url => {
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'test-access-only', refresh_token: 'test-refresh-only', id_token: jwt('issued-http-client', nonce), scope, expires_in: 3600 });
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'eligible-model', display_name: '계정 모델', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hidden' }] });
    throw new Error('unexpected URL');
  } });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await fetch(`${app.origin}/api/state`), cookie = initial.headers.get('set-cookie').split(';')[0], state = await initial.json();
  const headers = { 'Content-Type': 'application/json', 'X-ContextPulse-Token': state.csrf, Cookie: cookie };
  const api = async (path, data) => (await fetch(`${app.origin}/api${path}`, { headers, method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) })).json();
  const start = await api('/auth/start', {}), authorize = new URL(start.url); nonce = authorize.searchParams.get('nonce');
  assert.equal(start.attempt.status, 'pending');
  const result = await fetch(`${app.origin}/auth/callback?${new URLSearchParams({ state: authorize.searchParams.get('state'), client_id: 'issued-http-client', code: 'http-code' })}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(result.status, 303); assert.ok(result.headers.get('location').startsWith('/?auth='));
  assert.equal((await api('/auth/status')).attempt.status, 'connected');
  const connected = await api('/state'); assert.equal(connected.settings.provider, 'chatgpt'); assert.equal(connected.settings.model, '');
  assert.deepEqual((await api('/models', { provider: 'chatgpt' })).models, [{ id: 'eligible-model', name: '계정 모델' }]);
  assert.equal((await api('/auth/acknowledge', {})).auth.accounts[0].welcomePending, false);
  assert.ok(!JSON.stringify(await api('/state')).includes('test-access-only'));
  assert.ok(!JSON.stringify(await api('/export')).includes('test-refresh-only'));
  await api('/settings', { provider: 'chatgpt', model: 'eligible-model' });
  const returning = new URL((await api('/auth/start', { client_id: 'issued-http-client' })).url); nonce = returning.searchParams.get('nonce');
  const returningCallback = await fetch(`${app.origin}/auth/callback?${new URLSearchParams({ state: returning.searchParams.get('state'), client_id: 'issued-http-client', code: 'returning-code' })}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.ok(returningCallback.headers.get('location').startsWith('/?auth='));
  assert.equal((await api('/state')).settings.model, 'eligible-model');
  await api('/auth/start', {}); assert.equal((await api('/auth/cancel', {})).attempt.status, 'cancelled');
  await api('/auth/disconnect', {});
  const stale = await api('/state'); assert.equal(stale.auth.accounts[0].canForget, true);
  const cleaned = await api('/auth/forget', { client_id: 'issued-http-client' });
  assert.equal(cleaned.auth.accounts.length, 0); assert.equal(cleaned.settings.model, '');
  const localhost = await fetch(`http://localhost:${port}/?v=oauth`, { redirect: 'manual' });
  assert.equal(localhost.status, 308); assert.equal(localhost.headers.get('location'), `${app.origin}/?v=oauth`);
});


test('a system-browser callback completes only the initiating attempt and cannot be replayed', async t => {
  const { auth, control } = setup(t);
  const url = new URL(auth.begin('origin-browser'));
  control.tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: jwt('issued-client', url.searchParams.get('nonce')), scope, expires_in: 3600 };
  const query = new URLSearchParams({ state: url.searchParams.get('state'), code: 'valid-code', client_id: 'issued-client' });
  await auth.callback(query, 'system-browser');
  assert.equal(auth.status('origin-browser').status, 'connected');
  assert.equal(auth.status('system-browser').status, 'idle');
  await assert.rejects(auth.callback(query, 'system-browser'));
  assert.equal(auth.publicStatus().chatgptConnected, true);
});

test('only the initiating browser can resume a pending login URL', t => {
  const { auth } = setup(t);
  const url = auth.begin('origin-browser');
  assert.equal(auth.resume('origin-browser'), url);
  assert.throws(() => auth.resume('another-browser'));
  auth.cancel('origin-browser'); assert.throws(() => auth.resume('origin-browser'));
});
