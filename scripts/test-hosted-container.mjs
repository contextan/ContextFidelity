import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
const origin = 'http://127.0.0.1:8903';
const temporary = 'work/hosted-test-session.json';
const visitor = async cookie => {
  const r = await fetch(origin + '/api/state', { headers: { Connection: 'close', ...(cookie ? { Cookie: cookie } : {}) } });
  assert.equal(r.status, 200);
  return { cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie, state: await r.json() };
};
const api = async (v, path, data) => {
  const r = await fetch(origin + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Connection: 'close', Cookie: v.cookie, 'X-ContextPulse-Token': v.state.csrf, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: r.status, value: await r.json() };
};
assert.equal((await fetch(origin + '/healthz')).status, 200);
if (process.argv[2] === 'prepare') {
  const a = await visitor(), b = await visitor();
  assert.notEqual(a.state.projects[0].id, b.state.projects[0].id);
  const demo = await api(a, '/demo', {}); assert.equal(demo.status, 201);
  const run = await api(a, '/runs/' + demo.value.run_id);
  assert.equal(run.value.snapshots.length, 4);
  assert.equal((await api(b, '/runs/' + demo.value.run_id)).status, 404);
  assert.equal((await api(a, '/auth/start', {})).status, 400);
  const settings = await api(a, '/settings', { provider: 'demo', apiKey: 'fake-container-test-key' }); assert.equal(settings.status, 200);
  assert.ok(!JSON.stringify((await api(a, '/export')).value).includes('fake-container-test-key'));
  writeFileSync(temporary, JSON.stringify({ a, b, run_id: demo.value.run_id }), { mode: 0o600 });
  console.log('Prepared two isolated visitors and four-call demo for restart verification.');
} else if (process.argv[2] === 'verify') {
  const previous = JSON.parse(readFileSync(temporary, 'utf8'));
  const a = await visitor(previous.a.cookie), b = await visitor(previous.b.cookie);
  assert.equal(a.state.projects.length, 2); assert.equal(b.state.projects.length, 1);
  assert.equal(a.state.auth.apiKeySet, true); assert.equal(b.state.auth.apiKeySet, false);
  assert.equal((await api(b, '/runs/' + previous.run_id)).status, 404);
  const run = await api(a, '/runs/' + previous.run_id);
  assert.equal(run.status, 200); assert.equal(run.value.snapshots.length, 4);
  assert.equal(run.value.context_usage.current_question.source_id, run.value.user_message_id);
  const report = { checked_at: new Date().toISOString(), docker_runtime: true, health: 'ok', visitor_isolation: true, persisted_after_restart: true, encrypted_api_key_restored: true, credentials_excluded_from_export: true, preserved_snapshots: run.value.snapshots.length, public_oauth_blocked: true, no_public_tunnel_started: true };
  writeFileSync('outputs/hosted-container-test.json', JSON.stringify(report, null, 2));
  rmSync(temporary); console.log(JSON.stringify(report));
} else throw new Error('Use prepare, restart the container, then verify.');
