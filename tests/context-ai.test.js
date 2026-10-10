import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Provider } from '../src/provider.js';
import { executeRun, selectContext } from '../src/pipeline.js';
import { parseCandidates, parseTopicAnalysis, analyzeConversation, registerCandidates, isAspirationalStatement, isBackgroundRoleStatement } from '../src/context-ai.js';
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

test('aspirations are not saved as project-wide decisions and older misclassified entries remain topic-scoped history', t => {
  const { store, project, session } = setup(t);
  const source = store.addMessage(session.id, 'user', '실제 로봇이 잡초를 뽑아주는 기능을 하는 걸 만들고 싶어', ['로봇']);
  assert.equal(isAspirationalStatement(source.content), true);
  const parsed = parseCandidates(json({ candidates: [candidate(source, { kind: 'decision', scope: 'project', topics: ['로봇'] })] }), [source], []);
  assert.deepEqual(parsed.map(item => ({ kind: item.kind, scope: item.scope, topics: item.topics })), [{ kind: 'background', scope: 'topic', topics: ['로봇'] }]);

  const legacy = store.register(session.id, source.content, ['로봇'], { scope: 'project' }).decision;
  const unrelatedQuestion = store.addMessage(session.id, 'user', '지금 컨텍스트 구성을 보여줘', ['컨텍스트 관리']);
  const unrelated = selectContext(store, session.id, unrelatedQuestion);
  assert.equal(unrelated.active.some(item => item.id === legacy.id), false);
  assert.equal(unrelated.blocks.some(block => block.decision_id === legacy.id), false);
  assert.ok(unrelated.excluded.some(item => item.type === 'message' && item.id === legacy.source_id));

  const relatedQuestion = store.addMessage(session.id, 'user', '잡초를 뽑는 로봇을 어떻게 만들까?', ['로봇']);
  const related = selectContext(store, session.id, relatedQuestion);
  assert.equal(related.active.some(item => item.id === legacy.id), false);
  assert.ok(related.blocks.some(block => block.key === `HISTORY:${legacy.source_id}`));
});

test('a user role fact returned as a project decision is stored as topic background and cannot leak into unrelated QA', t => {
  const { store, project, session } = setup(t);
  const source = store.addMessage(session.id, 'user', '나는 이 프로젝트에서 사용자 인터뷰 담당이야.', ['사용자 인터뷰']);
  assert.equal(isBackgroundRoleStatement(source.content), true);
  const parsed = parseCandidates(json({ candidates: [candidate(source, { kind: 'decision', scope: 'project', topics: ['사용자 인터뷰'] })] }), [source], []);
  assert.deepEqual(parsed.map(item => ({ kind: item.kind, scope: item.scope, topics: item.topics })), [{ kind: 'background', scope: 'topic', topics: ['사용자 인터뷰'] }]);
  const englishSource = store.addMessage(session.id, 'user', 'I’m the user interview lead for this project.', ['user interviews']);
  const englishParsed = parseCandidates(json({ candidates: [candidate(englishSource, { kind: 'decision', scope: 'project', topics: ['user interviews'] })] }), [englishSource], []);
  assert.deepEqual(englishParsed.map(item => ({ kind: item.kind, scope: item.scope })), [{ kind: 'background', scope: 'topic' }]);
  const runId = store.createRun(session.id, source.id, settings);
  registerCandidates(store, runId, parsed);
  const qa = store.addMessage(session.id, 'user', '재현 테스트 목표와 컨텍스트 처리 결과를 확인해줘.', ['QA 재현']);
  const selected = selectContext(store, session.id, qa);
  assert.equal(selected.active.length, 0);
  assert.ok(!selected.blocks.some(block => /사용자 인터뷰 담당/.test(block.content)));
  assert.ok(selected.excluded.some(item => item.type === 'context' && item.topics.includes('사용자 인터뷰')));

  // Guard legacy rows that were saved as project-wide decisions before the
  // deterministic background classification was added.
  const legacy = store.register(session.id, '나는 이 프로젝트에서 사용자 인터뷰 담당이야.', ['사용자 인터뷰'], { scope: 'project' }).decision;
  const next = store.addMessage(session.id, 'user', 'QA 범위의 자동 등록을 확인해줘.', ['QA 재현']);
  const guarded = selectContext(store, session.id, next);
  assert.ok(!guarded.active.some(item => item.id === legacy.id));
  assert.ok(guarded.excluded.some(item => item.id === legacy.id && item.reason.includes('배경 맥락')));
});

test('an unrelated legacy role decision cannot make a current QA goal produce an uncertain decision-validation result', async t => {
  const { store, session } = setup(t);
  const legacy = store.register(session.id, '나는 이 프로젝트에서 사용자 인터뷰 담당이야.', ['사용자 인터뷰'], { scope: 'project' }).decision;
  const question = store.addMessage(session.id, 'user', '이번 QA 재현 목표는 배경과 미정 아이디어를 확인하는 것이다.', ['QA 재현']);
  let validationCalls = 0;
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.startsWith('질문에 필요한 프로젝트 컨텍스트')) return { text: JSON.stringify({ topics: ['QA 재현'], contexts: [], registrations: [] }) };
    if (instruction.startsWith('사용자 대화 원문과 모델 답변')) return { text: JSON.stringify({ candidates: [] }) };
    if (instruction.startsWith('당신은 대화 결정의 일관성 검증자')) { validationCalls++; return { text: JSON.stringify({ verdict: 'uncertain', conflicts: [], note: '테스트 검증 응답' }) }; }
    return { text: 'QA 재현 목표를 배경과 미정 아이디어로 확인하겠습니다.' };
  } };
  const run = await executeRun(store, provider, session.id, question, settings);
  assert.equal(validationCalls, 0);
  assert.equal(run.status, 'no_decisions');
  assert.ok(!run.snapshots.some(snapshot => snapshot.phase === 'validation'));
  const generation = run.snapshots.find(snapshot => snapshot.phase === 'generation');
  assert.ok(!generation.blocks.some(block => block.decision_id === legacy.id));
  assert.ok(generation.blocks.some(block => block.key === 'CURRENT_QUESTION' && block.content === question.content));
});

test('automatic reclassification preserves a user goal as background context and supersedes the false decision', t => {
  const { store, project, session } = setup(t);
  const original = store.register(session.id, '실제 로봇이 잡초를 뽑아주는 기능을 하는 걸 만들고 싶어', ['로봇'], { scope: 'project' });
  const runId = store.createRun(session.id, original.message.id, settings);
  const saved = registerCandidates(store, runId, [{
    title: '잡초 제거 로봇 목표', content: original.message.content, kind: 'background', scope: 'topic', topics: ['로봇'], source_id: original.message.id, supersedes: null,
  }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'background');
  assert.equal(saved[0].scope, 'topic');
  assert.equal(store.decision(original.decision.id).status, 'superseded');
});

test('SQLite FTS5 retrieves keyword matches, respects manual overrides, freezes sent bodies and records scores', async t => {
  const { store, project, session, add } = setup(t);
  const product = add({ content: '사용자 문제는 반복 설명이다. 제품을 쓸 때 같은 내용을 반복해 설명한다.' });
  const design = add({ title: '색상', topics: ['디자인'], content: '색상은 보라색을 검토한다.' });
  const hiddenSource = store.addMessage(session.id, 'user', '직접 제외한 참고 원문입니다.', ['디자인']);
  const hidden = add({ source_id: hiddenSource.id, content: hiddenSource.content });
  store.setOverride(session.id, hidden.id, 'exclude');
  const pinned = add({ include_mode: 'always', content: '항상 포함할 참고 자료입니다.' });
  const forced = add({ include_mode: 'off', content: '직접 포함한 자료입니다.' });
  store.setOverride(session.id, forced.id, 'include');
  const mandatory = store.register(session.id, '프로젝트 전체 기준은 항상 유지한다.', []).decision;
  const question = store.addMessage(session.id, 'user', '제품 사용자가 같은 내용을 반복 설명하는 문제를 어떻게 검증할까?', ['디자인']);
  const sent = [];
  const provider = new Provider({}, async (_url, options) => {
    sent.push(options.body);
    const request = JSON.parse(options.body), instructions = request.messages[0].content;
    const text = instructions.includes('SQLite FTS5') ? json({ topics: ['제품'], registrations: [] })
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
  const selection = JSON.parse(generation.blocks.find(b => b.key === 'CONTEXT_SELECTION').content);
  assert.equal(selection.mode, 'fts5');
  assert.ok(selection.search.candidates.some(item => item.context_id === product.id));
  assert.ok(selection.search.candidates.every(item => !('content' in item)));
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

test('topic analysis accepts only well-formed topics and source-checked registrations', t => {
  const { store, session } = setup(t);
  const source = store.addMessage(session.id, 'user', '내 이름은 은룡이고 개발자가 되고 싶다.', []);
  const analysis = parseTopicAnalysis(json({ topics: ['개발 진로'], registrations: [{ title: '목표', content: source.content, kind: 'background', scope: 'topic', topics: ['개발 진로'], source_id: source.id }] }));
  assert.deepEqual(analysis.topics, ['개발 진로']);
  assert.equal(analysis.registrations.length, 1);
  assert.throws(() => parseTopicAnalysis(json({ topics: [''], registrations: [] })));
  assert.throws(() => parseTopicAnalysis(json({ topics: ['제품'], registrations: 'invalid' })));
  assert.throws(() => parseCandidates(json({ candidates: [{ title: '가짜', content: '원문에 없음', kind: 'background', scope: 'topic', topics: ['제품'], source_id: source.id }] }), [source], []));
});

test('malformed selection excludes broad automatic context but preserves mandatory decisions and pinned context', async t => {
  const { store, session, add } = setup(t);
  const broadMaterial = add({ scope: 'project' });
  const pinnedMaterial = add({ scope: 'project', include_mode: 'always', content: '항상 포함할 프로젝트 맥락입니다.' });
  const decision = store.register(session.id, '확정된 필수 결정입니다.', []).decision;
  const question = store.addMessage(session.id, 'user', '현재 기준으로 답해줘', []);
  const provider = { call: async request => ({ text: request.payload.messages[0].content.includes('SQLite FTS5') ? 'invalid'
    : request.payload.messages[0].content.startsWith('당신은') ? json({ verdict: 'consistent', conflicts: [], note: '일치' })
    : request.payload.messages[0].content.startsWith('사용자 대화 원문') ? json({ candidates: [] }) : '필수 결정을 따르는 답변', usage: null, latency: 0 }) };
  const run = await executeRun(store, provider, session.id, question, settings);
  assert.equal(run.status, 'consistent');
  assert.match(run.validation.context_warning, /태그·수동 선택/);
  const blocks = run.snapshots.find(s => s.phase === 'generation').blocks;
  assert.ok(!blocks.some(b => b.context_id === broadMaterial.id));
  assert.ok(blocks.some(b => b.context_id === pinnedMaterial.id));
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

test('assistant hypotheses wait for approval before becoming searchable context', t => {
  const { store, project, session } = setup(t);
  const user = store.addMessage(session.id, 'user', '제품 문제는 반복 설명이다.', ['제품']);
  const assistant = store.addMessage(session.id, 'assistant', '반복 설명을 줄이려면 질문별 맥락을 자동 선택하는 기능을 제안합니다.', ['제품']);
  const runId = store.createRun(session.id, user.id, settings);
  const result = registerCandidates(store, runId, [candidate(assistant)]);
  const proposal = store.candidates(project.id)[0];
  assert.deepEqual(result, []);
  assert.equal(proposal.status, 'pending');
  assert.equal(store.contexts(project.id).length, 0);
  const reviewed = store.reviewCandidate(proposal.id, 'accept');
  assert.equal(reviewed.target.kind, 'hypothesis');
  assert.equal(reviewed.candidate.status, 'accepted');
  assert.equal(store.contexts(project.id).length, 1);
});

test('failed extraction preserves the verified answer and reports a separate registration failure without partial candidates', async t => {
  const { store, project, session } = setup(t);
  const question = store.addMessage(session.id, 'user', '사용자 문제를 검증할 방법을 알려줘.', []);
  const provider = { call: async request => ({ text: request.payload.messages[0].content.includes('SQLite FTS5') ? json({ topics: ['제품'], registrations: [] })
    : request.payload.messages[0].content.startsWith('사용자 대화 원문') ? json({ candidates: [candidate(question), candidate(question, { content: '원문에 없는 내용을 만들었다.' })] })
    : '인터뷰로 사용자 문제를 확인하세요.', usage: null, latency: 0 }) };
  const run = await executeRun(store, provider, session.id, question, settings);
  assert.equal(run.status, 'no_decisions');
  assert.equal(store.message(run.assistant_message_id).content, '인터뷰로 사용자 문제를 확인하세요.');
  assert.equal(run.validation.context_registration.status, 'failed');
  assert.match(run.validation.context_registration.error, /추출 실패/);
  assert.equal(store.candidates(project.id).length, 0);
});

test('HTTP automatic registration, selected input display and export persist real model-call snapshots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-ai-http-'));
  const port = 23000 + Math.floor(Math.random() * 1000);
  let source;
  const app = createApp({ port, directory, testOnlyProviders: ['ollama', 'demo'], fetcher: async () => Response.json({ done: true, message: { content: json({ candidates: [candidate(source)] }) } }) });
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
