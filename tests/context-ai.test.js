import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Provider } from '../src/provider.js';
import { executeRun, selectContext } from '../src/pipeline.js';
import { parseCandidates, parseSelection, selectionCandidates, analyzeConversation } from '../src/context-ai.js';
import { createApp } from '../src/server.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-ai-'));
  const store = new Store(directory), project = store.projects()[0], session = store.sessions(project.id)[0];
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const add = changes => store.saveContext(project.id, { title: '문제 가설', content: '기본 참고 자료 내용', kind: 'hypothesis', scope: 'topic', topics: ['제품'], include_mode: 'auto', ...changes });
  return { store, project, session, add };
}
const candidate = (source, changes = {}) => ({ title: '사용자 문제 가설', content: source.content, kind: 'hypothesis', scope: 'topic', topics: ['제품'], source_id: source.id, supersedes: null, ...changes });
const settings = { provider: 'ollama', model: 'test-model', ollamaUrl: 'http://127.0.0.1:11434', autoContext: true };
const json = value => JSON.stringify(value);

test('semantic selection uses content despite different tags, respects manual overrides, freezes all sent bodies', async t => {
  const { store, project, session, add } = setup(t);
  const product = add({ content: '사용자 문제는 반복 설명이다.' });
  const design = add({ title: '색상', topics: ['디자인'], content: '색상은 보라색을 검토한다.' });
  const hiddenSource = store.addMessage(session.id, 'user', '직접 제외한 참고 원문입니다.', ['디자인']);
  const hidden = add({ source_id: hiddenSource.id, content: hiddenSource.content });
  store.setOverride(session.id, hidden.id, 'exclude');
  const pinned = add({ include_mode: 'always', content: '항상 포함할 참고 자료입니다.' });
  const forced = add({ include_mode: 'off', content: '직접 포함한 자료입니다.' });
  store.setOverride(session.id, forced.id, 'include');
  const mandatory = store.register(session.id, '프로젝트 전체 기준은 항상 유지한다.', []).decision;
  const question = store.addMessage(session.id, 'user', '사용자가 반복 설명하는 문제를 어떻게 검증할까?', ['디자인']);
  const sent = [];
  const provider = new Provider({}, async (_url, options) => {
    sent.push(options.body);
    const request = JSON.parse(options.body), instructions = request.messages[0].content;
    const text = instructions.startsWith('질문에 필요한') ? json({ topics: ['제품'], contexts: [{ id: product.id, include: true, reason: '반복 설명 문제를 검증하는 질문이다.' }, { id: design.id, include: false, reason: '색상 디자인은 질문과 무관하다.' }] })
      : instructions.startsWith('사용자 대화 원문') ? json({ candidates: [candidate(question)] })
      : instructions.startsWith('당신은') ? json({ verdict: 'consistent', conflicts: [], note: '유효 결정에 부합한다.' })
      : '사용자 인터뷰에서 반복 설명의 빈도를 측정하세요.';
    return Response.json({ done: true, message: { content: text }, prompt_eval_count: 41, eval_count: 15 });
  });
  const run = await executeRun(store, provider, session.id, question, settings);
  assert.equal(run.status, 'consistent');
  assert.deepEqual(run.snapshots.map(s => s.phase), ['selection', 'generation', 'validation', 'extraction']);
  run.snapshots.forEach((snapshot, i) => assert.equal(snapshot.payload, sent[i]));
  const generation = run.snapshots.find(s => s.phase === 'generation');
  assert.ok(generation.blocks.some(b => b.context_id === product.id));
  assert.ok(generation.blocks.some(b => b.context_id === pinned.id));
  assert.ok(generation.blocks.some(b => b.context_id === forced.id));
  assert.ok(generation.blocks.some(b => b.decision_id === mandatory.id));
  assert.ok(!generation.payload.includes(design.content));
  assert.ok(!generation.payload.includes(hiddenSource.content));
  assert.equal(store.candidates(project.id)[0].status, 'accepted');
  assert.equal(store.contexts(project.id).find(c => c.source_id === question.id).registration, 'automatic');
  assert.equal(store.decisions(project.id).length, 1);
  assert.ok(!generation.blocks.some(b => b.context_id?.startsWith('candidate')));
  const original = generation.payload;
  store.saveContext(project.id, { ...product, content: '나중에 수정한 내용입니다.' }, product.id);
  assert.equal(store.run(run.id).snapshots.find(s => s.phase === 'generation').payload, original);
});

test('selection rejects unknown IDs, missing rows, duplicate rows and non-boolean choices', t => {
  const { session, store, add } = setup(t), item = add({});
  const good = { topics: ['제품'], contexts: [{ id: item.id, include: true, reason: '관련 있음' }] };
  assert.equal(parseSelection(json(good), [item]).choices[0].id, item.id);
  for (const contexts of [[], [{ id: 'foreign', include: true, reason: '조작' }], [...good.contexts, ...good.contexts], [{ id: item.id, include: 'true', reason: '조작' }]]) assert.throws(() => parseSelection(json({ ...good, contexts }), [item]));
  store.archiveContext(item.id);
  assert.equal(selectionCandidates(store, session.id).length, 0);
});

test('malformed selection explicitly falls back without dropping mandatory decisions', async t => {
  const { store, session, add } = setup(t);
  const material = add({ scope: 'project' });
  const decision = store.register(session.id, '확정된 필수 결정입니다.', []).decision;
  const question = store.addMessage(session.id, 'user', '현재 기준으로 답해줘', []);
  const provider = { call: async request => ({ text: request.payload.messages[0].content.startsWith('질문에 필요한') ? 'invalid'
    : request.payload.messages[0].content.startsWith('당신은') ? json({ verdict: 'consistent', conflicts: [], note: '일치' })
    : request.payload.messages[0].content.startsWith('사용자 대화 원문') ? json({ candidates: [] }) : '필수 결정을 따르는 답변', usage: null, latency: 0 }) };
  const run = await executeRun(store, provider, session.id, question, settings);
  assert.equal(run.status, 'consistent');
  assert.match(run.validation.context_warning, /태그·수동 선택/);
  const blocks = run.snapshots.find(s => s.phase === 'generation').blocks;
  assert.ok(blocks.some(b => b.context_id === material.id));
  assert.ok(blocks.some(b => b.decision_id === decision.id));
  assert.equal(JSON.parse(blocks.find(b => b.key === 'CONTEXT_SELECTION').content).mode, 'tag_fallback');
});

test('extraction rejects fabricated quotes, assistant decisions and another project decision', t => {
  const { store, session } = setup(t);
  const source = store.addMessage(session.id, 'user', '인터뷰로 반복 설명 문제를 검증하자.', []);
  const assistant = store.addMessage(session.id, 'assistant', '모델의 제안은 확정된 사용자 결정이 아니다.', []);
  const other = store.createProject('다른 프로젝트');
  const decision = store.register(store.sessions(other.id)[0].id, '외부 결정은 대체하지 않는다.', []).decision;
  const candidates = item => json({ candidates: [item] });
  assert.equal(parseCandidates(candidates(candidate(source)), [source], []).length, 1);
  assert.throws(() => parseCandidates(candidates(candidate(source, { content: '존재하지 않는 사용자 인용' })), [source], []));
  assert.equal(parseCandidates(candidates(candidate(assistant)), [source, assistant], []).length, 1);
  assert.throws(() => parseCandidates(candidates(candidate(assistant, { kind: 'decision' })), [source, assistant], []));
  assert.throws(() => parseCandidates(candidates(candidate(assistant, { kind: 'background' })), [source, assistant], []));
  assert.throws(() => parseCandidates(candidates(candidate(source, { kind: 'decision', supersedes: decision.id })), [source], []));
  assert.throws(() => parseCandidates(candidates(candidate(source, { scope: 'topic', topics: [] })), [source], []));
});

test('accepting a candidate preserves source, automatically replaces an explicit user decision, and deduplicates', async t => {
  const { store, project, session } = setup(t);
  const old = store.register(session.id, 'Solana 필수성 입증을 주요 평가조건으로 삼는다.', []).decision;
  const source = store.addMessage(session.id, 'user', '이 프로젝트에서는 Solana 필수성 입증을 주요 평가조건으로 삼지 않는다.', []);
  const item = candidate(source, { kind: 'decision', scope: 'project', supersedes: old.id });
  const provider = { call: async () => ({ text: json({ candidates: [item] }), latency: 0, usage: null }) };
  const run = await analyzeConversation(store, provider, session.id, settings);
  assert.equal(run.status, 'extracted'); assert.equal(run.purpose, 'analysis');
  const proposal = store.candidates(project.id)[0];
  const target = store.decision(proposal.target_id);
  assert.equal(store.decision(old.id).status, 'superseded');
  assert.equal(target.version, 2); assert.equal(target.source_id, source.id);
  assert.equal(store.message(target.source_id).content, source.content);
  assert.equal(store.candidate(proposal.id).status, 'accepted');
  assert.throws(() => store.reviewCandidate(proposal.id, 'accept'), /대기/);
  // Returning the same quote again creates no duplicate candidate, even after review.
  const again = await analyzeConversation(store, provider, session.id, settings);
  assert.equal(again.status, 'failed'); // Its suggested old decision is no longer active.
  assert.equal(store.candidates(project.id).length, 1);
  assert.ok(selectContext(store, session.id, source).active.some(d => d.id === target.id));
  assert.throws(() => store.db.prepare('UPDATE context_candidates SET content=? WHERE id=?').run('조작', proposal.id), /immutable/);
});

test('accepting a hypothesis never confirms a decision, dismissed evidence stays deduplicated, stale replacement stays pending', async t => {
  const { store, project, session } = setup(t);
  const source = store.addMessage(session.id, 'user', '아직 검증하지 않은 가설은 반복 설명의 비용이 크다는 것이다.', []);
  const provider = { call: async () => ({ text: json({ candidates: [candidate(source)] }), latency: 0, usage: null }) };
  await analyzeConversation(store, provider, session.id, settings);
  const proposal = store.candidates(project.id)[0];
  const accepted = { target: store.context(proposal.target_id) };
  assert.equal(accepted.target.kind, 'hypothesis'); assert.equal(accepted.target.source_id, source.id);
  assert.equal(store.decisions(project.id).length, 0);
  await analyzeConversation(store, provider, session.id, settings);
  assert.equal(store.candidates(project.id).length, 1);
  const old = store.register(session.id, '기존 프로젝트 기준이다.', []).decision;
  const replacement = store.addMessage(session.id, 'user', '프로젝트 기준을 수정한다.', []);
  const runId = store.createRun(session.id, replacement.id, settings, 'analysis');
  const stale = store.saveCandidates(runId, [candidate(replacement, { kind: 'decision', scope: 'project', supersedes: old.id })])[0];
  store.register(session.id, '후속 기준으로 이미 바꿨다.', [], { supersedes: old.id });
  assert.throws(() => store.reviewCandidate(stale.id, 'accept'), /변경/);
  assert.equal(store.candidate(stale.id).status, 'pending');
  store.reviewCandidate(stale.id, 'dismiss');
  assert.equal(store.candidate(stale.id).status, 'dismissed');
});

test('failed extraction preserves the verified answer and reports its warning without partial candidates', async t => {
  const { store, project, session } = setup(t);
  const question = store.addMessage(session.id, 'user', '사용자 문제를 검증할 방법을 알려줘.', []);
  const provider = { call: async request => ({ text: request.payload.messages[0].content.startsWith('질문에 필요한') ? json({ topics: ['제품'], contexts: [] })
    : request.payload.messages[0].content.startsWith('사용자 대화 원문') ? json({ candidates: [candidate(question), candidate(question, { content: '원문에 없는 내용을 만들었다.' })] })
    : '인터뷰로 사용자 문제를 확인하세요.', usage: null, latency: 0 }) };
  const run = await executeRun(store, provider, session.id, question, settings);
  assert.equal(run.status, 'no_decisions');
  assert.equal(store.message(run.assistant_message_id).content, '인터뷰로 사용자 문제를 확인하세요.');
  assert.match(run.validation.context_warning, /추출 실패/);
  assert.equal(store.candidates(project.id).length, 0);
});

test('HTTP automatic registration, selected input display and export persist real model-call snapshots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-ai-http-'));
  const port = 23000 + Math.floor(Math.random() * 1000);
  let source;
  const app = createApp({ port, directory, fetcher: async () => Response.json({ done: true, message: { content: json({ candidates: [candidate(source)] }) } }) });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const state = await (await fetch(`${app.origin}/api/state`)).json(), projectId = state.projects[0].id;
  const session = app.store.sessions(projectId)[0];
  source = app.store.addMessage(session.id, 'user', '제품 가설은 인터뷰로 검증한다.', ['제품']);
  const call = async (path, data) => {
    const response = await fetch(`${app.origin}/api${path}`, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-ContextPulse-Token': state.csrf }, ...(data ? { body: json(data) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  await call('/settings', settings);
  const response = await call(`/sessions/${session.id}/analyze-context`, {});
  assert.equal(response.status, 202);
  let run;
  for (let i = 0; i < 30; i++) { run = (await call(`/runs/${response.value.run_id}`)).value; if (run.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(run.status, 'extracted');
  const project = (await call(`/projects/${projectId}`)).value;
  assert.equal(project.candidates.length, 1);
  assert.equal(project.contexts[0].source_id, source.id);
  assert.equal(project.contexts[0].registration, 'automatic');
  assert.equal((await call(`/sessions/${session.id}/context-preview`, { topics: ['제품'] })).value.selected.length, 1);
  const exported = (await call('/export')).value;
  assert.equal(exported.tables.context_candidates[0].status, 'accepted');
  assert.equal(exported.tables.snapshots[0].phase, 'extraction');
  await call('/settings', { provider: 'demo' });
  assert.equal((await call(`/sessions/${session.id}/analyze-context`, {})).status, 400);
});
