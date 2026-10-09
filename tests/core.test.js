import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Store } from '../src/store.js';
import { Provider } from '../src/provider.js';
import { Auth } from '../src/auth.js';
import { executeRun, selectContext, parseValidation, compareSnapshots } from '../src/pipeline.js';
import { createApp } from '../src/server.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'contextpulse-test-'));
  const store = new Store(dir), project = store.projects()[0], session = store.sessions(project.id)[0];
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, project, session, dir };
}
test('decisions replace atomically, preserve exact originals, and reject another project', t => {
  const { store, session, project } = fixture(t);
  const old = store.register(session.id, '기존 기준', []).decision;
  const next = store.register(session.id, '새 기준 그대로 보존 <b>', [], { supersedes: old.id }).decision;
  assert.equal(store.decision(old.id).status, 'superseded');
  assert.equal(next.version, 2);
  assert.equal(store.message(next.source_id).content, '새 기준 그대로 보존 <b>');
  const other = store.createProject('다른 프로젝트');
  const otherSession = store.sessions(other.id)[0];
  assert.throws(() => store.register(otherSession.id, '오염된 기준', [], { supersedes: next.id }));
  assert.equal(store.decisions(other.id).length, 0);
  assert.equal(store.decisions(project.id).length, 2);
});
test('mandatory decisions survive topic selection; superseded evidence never enters generation', t => {
  const { store, session } = fixture(t);
  const mandatory = store.register(session.id, '프로젝트 필수 기준', ['평가']).decision;
  const old = store.register(session.id, '디자인 구 기준', ['디자인'], { scope: 'topic' }).decision;
  store.register(session.id, '디자인 새 기준', ['디자인'], { scope: 'topic', supersedes: old.id });
  const message = store.addMessage(session.id, 'user', '평가해줘', ['평가']);
  const context = selectContext(store, session.id, message);
  assert.deepEqual(context.active.map(d => d.id), [mandatory.id]);
  assert.ok(!JSON.stringify(context.blocks).includes('디자인 구 기준'));
  assert.equal(context.evidence[0].source_id, mandatory.source_id);
});
test('explicit demo preserves 4 calls and frozen context after a later decision revision', async t => {
  const { store, session } = fixture(t);
  const old = store.register(session.id, 'Solana 필수성 입증이 없으면 감점한다.', ['평가']).decision;
  const active = store.register(session.id, 'Solana 필수성 입증을 주요 평가조건으로 삼지 않는다.', ['평가'], { supersedes: old.id }).decision;
  const question = store.addMessage(session.id, 'user', '아이디어 평가', ['평가']);
  const run = await executeRun(store, null, session.id, question, { provider: 'demo', model: 'context-demo' }, true);
  assert.equal(run.status, 'corrected');
  assert.deepEqual(run.snapshots.map(s => s.phase), ['generation', 'validation', 'correction', 'revalidation']);
  assert.ok(run.snapshots[2].payload.includes('OLD_DRAFT'));
  assert.ok(run.snapshots[1].payload.includes(store.message(active.source_id).content));
  assert.equal(store.message(run.assistant_message_id).content, run.snapshots[2].output);
  assert.ok(!run.snapshots[0].excluded.some(item => item.id === old.id));
  assert.ok(run.snapshots[0].excluded.some(item => item.id === active.id));
  const original = run.snapshots[2].payload;
  store.register(session.id, '다시 변경된 결정', ['평가'], { supersedes: active.id });
  assert.equal(store.run(run.id).snapshots[2].payload, original);
  assert.throws(() => store.db.prepare('UPDATE snapshots SET payload=? WHERE id=?').run('mutated', run.snapshots[0].id), /immutable/);
  const diff = compareSnapshots(run.snapshots[0], run.snapshots[2]);
  assert.ok(diff.removed.some(b => b.decision_id === old.id));
  assert.ok(diff.added.some(b => b.decision_id === active.id));
});
test('invalid validator citations never trigger correction', t => {
  const { store, session } = fixture(t);
  const d = store.register(session.id, '원문에 있는 결정', []).decision;
  const invalid = JSON.stringify({ verdict: 'conflict', conflicts: [{ decision_id: d.id, draft_quote: '충돌 문장', evidence_quote: '조작된 사용자 발화', correction: '삭제' }], note: '' });
  assert.equal(parseValidation(invalid, '충돌 문장', [d], store).verdict, 'uncertain');
  assert.equal(parseValidation('not json', '초안', [d], store).verdict, 'uncertain');
});
test('real-provider pipeline sends exactly the stored body and records usage', async t => {
  const { store, session, dir } = fixture(t);
  store.register(session.id, '색상은 파랑으로 유지한다.', []);
  const sent = [];
  const fetcher = async (_url, options) => {
    sent.push(options.body);
    const text = sent.length === 1 ? '색상은 파랑으로 유지하겠습니다.' : JSON.stringify({ verdict: 'consistent', conflicts: [], note: '결정에 부합합니다.' });
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 25, output_tokens: 15 } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const auth = new Auth(dir, 'http://127.0.0.1:8899'); auth.setApiKey('test-secret-never-export');
  const provider = new Provider(auth, fetcher);
  const question = store.addMessage(session.id, 'user', '색상 알려줘', []);
  const run = await executeRun(store, provider, session.id, question, { provider: 'openai', model: 'test-model' });
  assert.equal(run.status, 'consistent');
  assert.equal(run.snapshots.length, 2);
  for (let i = 0; i < sent.length; i++) assert.equal(run.snapshots[i].payload, sent[i]);
  assert.equal(run.snapshots[0].usage.input_tokens, 25);
  assert.ok(!JSON.stringify(store.export()).includes('test-secret-never-export'));
});
test('provider failures keep attempted input and never create a verified assistant answer', async t => {
  const { store, session } = fixture(t);
  const provider = { call: async () => { throw new Error('연결 실패'); } };
  const question = store.addMessage(session.id, 'user', '질문', []);
  const run = await executeRun(store, provider, session.id, question, { provider: 'openai', model: 'test-model' });
  assert.equal(run.status, 'failed'); assert.equal(run.assistant_message_id, null);
  assert.equal(run.snapshots[0].call_status, 'failed');
  assert.ok(run.snapshots[0].payload.includes('질문'));
});
test('revalidation conflict remains unresolved, without a second correction loop', async t => {
  const { store, session } = fixture(t);
  const d = store.register(session.id, '빨강 사용 금지', []).decision;
  let calls = 0;
  const bad = '빨강 사용을 권장합니다.';
  const verdict = JSON.stringify({ verdict: 'conflict', conflicts: [{ decision_id: d.id, draft_quote: bad, evidence_quote: '빨강 사용 금지', correction: '금지된 색상 권고를 제거한다.' }], note: '충돌' });
  const provider = { call: async () => ({ text: (++calls % 2) ? bad : verdict }) };
  const question = store.addMessage(session.id, 'user', '색상 평가', []);
  const run = await executeRun(store, provider, session.id, question, { provider: 'openai', model: 'test' });
  assert.equal(run.status, 'unresolved'); assert.equal(calls, 4);
});
test('stream without completed event is rejected', async () => {
  const provider = new Provider({ value: { apiKey: 'test' } }, async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
  await assert.rejects(provider.call({ provider: 'openai', endpoint: 'https://example.invalid' }, '{}'), /완료 이벤트/);
});
test('OAuth uses stable host, fresh PKCE and nonce; wrong callback cannot exchange tokens', async t => {
  const { dir } = fixture(t);
  const auth = new Auth(dir, 'http://127.0.0.1:8899', async () => { throw new Error('must not exchange'); });
  const first = new URL(auth.begin('browser-a')), second = new URL(auth.begin('browser-a'));
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('redirect_uri'), 'http://127.0.0.1:8899/auth/callback');
  assert.equal(first.searchParams.get('ext_agent_host_id'), second.searchParams.get('ext_agent_host_id'));
  assert.notEqual(first.searchParams.get('code_challenge'), second.searchParams.get('code_challenge'));
  await assert.rejects(auth.callback(new URLSearchParams({ state: first.searchParams.get('state'), code: 'fake', client_id: 'issued' }), 'browser-b'), /ブラウザー|브라우저/);
});
test('OAuth ID signature, audience and nonce are verified', async t => {
  const { dir } = fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key' };
  const auth = new Auth(dir, 'http://127.0.0.1:8899', async () => new Response(JSON.stringify({ keys: [jwk] })));
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'issued-client', exp: Math.floor(Date.now() / 1000) + 300, nonce: 'nonce', sub: 'user' })).toString('base64url');
  const token = `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  assert.equal((await auth.validateIdToken(token, 'issued-client', 'nonce')).sub, 'user');
  await assert.rejects(auth.validateIdToken(token, 'issued-client', 'different'), /검증/);
  await assert.rejects(auth.validateIdToken(`${token.slice(0, -5)}aaaaa`, 'issued-client', 'nonce'), /서명/);
});
test('HTTP isolation, persistence and authentic SQLite export', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'contextpulse-http-'));
  const port = 19000 + Math.floor(Math.random() * 1000), app = createApp({ port, directory: dir });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const initial = await (await fetch(`${app.origin}/api/state`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-ContextPulse-Token': initial.csrf };
  assert.deepEqual(initial.capabilities.providers, ['chatgpt']);
  assert.equal((await fetch(`${app.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ provider: 'openai', model: 'test', apiKey: 'not-accepted' }) })).status, 400);
  assert.equal((await fetch(`${app.origin}/api/projects`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/projects`, { method: 'POST', body: '{}' })).status, 403);
  const response = await fetch(`${app.origin}/api/demo`, { method: 'POST', headers, body: '{}' });
  const demo = await response.json(); assert.equal(response.status, 201);
  const run = await (await fetch(`${app.origin}/api/runs/${demo.run_id}`, { headers })).json();
  assert.equal(run.status, 'corrected');
  assert.equal(run.snapshots.length, 4);
  const db = Buffer.from(await (await fetch(`${app.origin}/api/export/sqlite`, { headers })).arrayBuffer());
  assert.equal(db.subarray(0, 16).toString(), 'SQLite format 3\u0000');
  assert.ok(db.length > 1000);
  const persisted = app.store.path;
  assert.ok(readFileSync(persisted).length > 1000);
});

test('process restart restores original messages and marks interrupted requests failed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'contextpulse-restart-'));
  const first = new Store(dir), session = first.sessions(first.projects()[0].id)[0];
  const message = first.addMessage(session.id, 'user', '  <b>원문 그대로</b>\n', []);
  const runId = first.createRun(session.id, message.id, { provider: 'openai', model: 'test' });
  first.snapshot(runId, 'generation', { provider: 'openai', model: 'test', endpoint: 'test', payload: { input: message.content } }, [], []);
  first.close();
  const restored = new Store(dir);
  t.after(() => { restored.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(restored.message(message.id).content, '  <b>원문 그대로</b>\n');
  assert.equal(restored.run(runId).status, 'failed');
  assert.equal(restored.run(runId).snapshots[0].call_status, 'failed');
});
