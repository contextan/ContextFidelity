import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { answerFormatIssues, executeRun } from '../src/pipeline.js';
import { contextUsage } from '../src/context-usage.js';
import { Provider, buildRequest } from '../src/provider.js';
import { createApp } from '../src/server.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-receipt-'));
  const store = new Store(directory), project = store.projects()[0], session = store.sessions(project.id)[0];
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, session, directory };
}
test('model preference is saved per conversation and isolated from other sessions', t => {
  const { store, project, session } = fixture(t);
  const other = store.createSession(project.id);
  const updated = store.setSessionModel(session.id, 'chatgpt', 'gpt-6.1-sol');
  assert.equal(updated.model_provider, 'chatgpt');
  assert.equal(updated.model, 'gpt-6.1-sol');
  assert.equal(store.session(other.id).model, '');
  assert.equal(store.session(other.id).model_provider, '');
});

test('reasoning effort is saved per conversation and model requests use the selected effort', t => {
  const { store, project, session } = fixture(t);
  const other = store.createSession(project.id);
  assert.equal(session.reasoning_effort, 'high');
  const updated = store.setSessionReasoningEffort(session.id, 'xhigh');
  assert.equal(updated.reasoning_effort, 'xhigh');
  assert.equal(store.session(other.id).reasoning_effort, 'high');
  assert.throws(() => store.setSessionReasoningEffort(session.id, 'unlimited'));
  const request = buildRequest({ provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', verbosity: 'high' }, 'Answer fully.', []);
  assert.deepEqual(request.payload.reasoning, { effort: 'xhigh' });
  assert.deepEqual(request.payload.text, { verbosity: 'high' });
  const automatic = buildRequest({ provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'auto', verbosity: 'high' }, 'Answer fully.', []);
  assert.equal('reasoning' in automatic.payload, false);
  assert.deepEqual(automatic.payload.text, { verbosity: 'high' });
});

test('chat model endpoint persists a selection without changing another conversation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-session-model-'));
  const port = 24820 + Math.floor(Math.random() * 300);
  const requestedModels = [], requestedPayloads = [];
  const app = createApp({ directory, port, testOnlyProviders: ['openai'], fetcher: async (_url, options) => {
    const payload = JSON.parse(options.body);
    requestedModels.push(payload.model); requestedPayloads.push(payload);
    const text = requestedModels.length === 1 ? 'Answer from this chat model.' : JSON.stringify({ verdict: 'consistent', conflicts: [], note: 'No conflict.' });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await fetch(`${app.origin}/api/state`), cookie = initial.headers.get('set-cookie').split(';')[0], state = await initial.json();
  const headers = { 'Content-Type': 'application/json', 'X-ContextFidelity-Token': state.csrf, Cookie: cookie };
  const call = async (path, data) => (await fetch(`${app.origin}/api${path}`, { headers, method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) })).json();
  const project = app.store.projects()[0], first = app.store.sessions(project.id)[0], second = app.store.createSession(project.id);
  await call('/settings', { provider: 'openai', model: '', apiKey: 'fixture-session-model-key', autoContext: false });
  const selected = await call(`/sessions/${first.id}/model`, { model: 'gpt-6.1-sol' });
  assert.equal(selected.session.model_provider, 'openai');
  assert.equal(selected.session.model, 'gpt-6.1-sol');
  const reasoning = await call(`/sessions/${first.id}/reasoning`, { effort: 'xhigh' });
  assert.equal(reasoning.session.reasoning_effort, 'xhigh');
  const other = await call(`/sessions/${second.id}`);
  assert.equal(other.session.model, '');
  assert.equal(other.session.model_provider, '');
  assert.equal(other.session.reasoning_effort, 'high');
  assert.equal((await call('/state')).settings.model, '');
  const sent = await call(`/sessions/${first.id}/messages`, { content: 'Use this conversation model.', topics: [] });
  assert.equal(sent.run_id !== undefined, true);
  let run;
  for (let tries = 0; tries < 30; tries++) {
    run = await call(`/runs/${sent.run_id}`);
    if (run.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(run.status, 'no_decisions');
  assert.ok(run.snapshots.every(snapshot => snapshot.model === 'gpt-6.1-sol'));
  assert.deepEqual(requestedModels, ['gpt-6.1-sol']);
  assert.deepEqual(requestedPayloads[0].reasoning, { effort: 'xhigh' });
  assert.deepEqual(requestedPayloads[0].text, { verbosity: 'high' });
});

test('generation input states included and excluded context counts without leaking excluded content', async t => {
  const { store, project, session } = fixture(t);
  store.saveContext(project.id, { title: 'Robot background', content: 'Build a robot that pulls weeds.', kind: 'background', scope: 'project', topics: [], include_mode: 'auto' });
  store.saveContext(project.id, { title: 'Private unrelated note', content: 'Excluded material secret.', kind: 'reference', scope: 'topic', topics: ['food'], include_mode: 'auto' });
  store.register(session.id, 'For this project, build a robot that pulls weeds.', [], { scope: 'project', locale: 'en' });
  store.addMessage(session.id, 'user', 'We discussed a small farm robot earlier.', ['robot']);
  const question = store.addMessage(session.id, 'user', 'Show the context used for this answer.', ['robot']);
  const run = await executeRun(store, null, session.id, question, { provider: 'demo', model: 'context-demo', locale: 'en', autoContext: false });
  const generation = run.snapshots.find(snapshot => snapshot.phase === 'generation');
  const receipt = JSON.parse(generation.blocks.find(block => block.key === 'CONTEXT_RECEIPT').content);
  const instructions = generation.blocks.find(block => block.key === 'INSTRUCTIONS').content;
  assert.deepEqual(receipt.included, { saved_contexts: 1, conversation_contexts: 1, previous_messages: 1 });
  assert.deepEqual(receipt.excluded, { saved_contexts: 1, conversation_contexts: 0, previous_messages: 0 });
  assert.equal(receipt.excluded_content_sent, false);
  assert.match(instructions, /enumerate every content-bearing DECISION, CONTEXT, and HISTORY block/i);
  assert.match(instructions, /State clearly when zero saved contexts were used/i);
  assert.equal(contextUsage(run, 'en').current_question.content, question.content);
  assert.ok(generation.payload.includes('Build a robot that pulls weeds.'));
  assert.ok(!generation.payload.includes('Excluded material secret.'));
});

test('an aspiration mistakenly stored as a project decision is filtered by topic and shown as excluded history', async t => {
  const { store, session } = fixture(t);
  const goal = store.register(session.id, '실제 로봇이 잡초를 뽑아주는 기능을 하는 걸 만들고 싶어', ['로봇'], { scope: 'project' });
  const question = store.addMessage(session.id, 'user', '설정 화면에서 추론 수준을 바꾸고 싶어', ['설정']);
  const run = await executeRun(store, null, session.id, question, { provider: 'demo', model: 'context-demo', locale: 'ko', autoContext: false });
  const generation = run.snapshots.find(snapshot => snapshot.phase === 'generation');
  const usage = contextUsage(run, 'ko');
  const receipt = JSON.parse(generation.blocks.find(block => block.key === 'CONTEXT_RECEIPT').content);
  assert.equal(generation.blocks.some(block => block.decision_id === goal.decision.id), false);
  assert.equal(generation.blocks.some(block => block.key === `HISTORY:${goal.message.id}`), false);
  assert.deepEqual(receipt.excluded, { saved_contexts: 0, conversation_contexts: 0, previous_messages: 1 });
  assert.equal(usage.excluded_history.length, 1);
  assert.equal(usage.excluded_history[0].content, goal.message.content);
});

test('answer context shows the versions actually sent and survives edits, archive and decision replacement', async t => {
  const { store, project, session } = fixture(t);
  const saved = store.saveContext(project.id, { title: 'Design', content: 'Use blue <literal>', kind: 'reference', scope: 'topic', topics: ['design'], include_mode: 'auto' });
  const decision = store.register(session.id, 'Keep the sidebar', [], { locale: 'en' }).decision;
  const question = store.addMessage(session.id, 'user', 'Summarize the design.', ['design']);
  const run = await executeRun(store, null, session.id, question, { provider: 'demo', model: 'context-demo', locale: 'en' });
  const original = contextUsage(run);
  assert.equal(original.contexts[0].content, 'Use blue <literal>');
  assert.equal(original.decisions[0].content, 'Keep the sidebar');
  store.saveContext(project.id, { ...saved, content: 'Use green' }, saved.id);
  store.register(session.id, 'Remove the sidebar', [], { supersedes: decision.id });
  assert.deepEqual(contextUsage(store.run(run.id)), original);
  assert.ok(run.snapshots[0].payload.includes('Use blue <literal>'));
});

test('answer receipt separates included and excluded context by topic and retains source evidence', async t => {
  const { store, project, session } = fixture(t);
  const productSource = store.addMessage(session.id, 'user', 'Our users are independent builders.', ['Product']);
  const product = store.saveContext(project.id, { title: 'Product audience', content: productSource.content, kind: 'background', scope: 'topic', topics: ['Product'], include_mode: 'auto', source_id: productSource.id });
  const designSource = store.addMessage(session.id, 'user', 'Use a blue and white palette.', ['Design']);
  const design = store.saveContext(project.id, { title: 'Design palette', content: designSource.content, kind: 'reference', scope: 'topic', topics: ['Design'], include_mode: 'auto', source_id: designSource.id });
  const projectContext = store.saveContext(project.id, { title: 'Project goal', content: 'Help teams maintain relevant context.', kind: 'background', scope: 'project', topics: [], include_mode: 'auto' });
  const question = store.addMessage(session.id, 'user', 'Who is this product for?', ['Product']);

  const run = await executeRun(store, null, session.id, question, { provider: 'demo', model: 'context-demo', locale: 'en' });
  const receipt = contextUsage(run, 'en');
  const generation = run.snapshots.find(snapshot => snapshot.phase === 'generation');
  const productGroup = receipt.topic_clusters.find(group => group.topic === 'Product');
  const designGroup = receipt.topic_clusters.find(group => group.topic === 'Design');
  const projectGroup = receipt.topic_clusters.find(group => group.scope === 'project');

  assert.equal(receipt.selection_mode, 'tags');
  assert.deepEqual(new Set(receipt.contexts.map(context => context.id)), new Set([product.id, projectContext.id]));
  assert.equal(productGroup.question_matched, true);
  assert.equal(productGroup.included_count, 1);
  assert.equal(designGroup.question_matched, false);
  assert.equal(designGroup.excluded_count, 1);
  assert.equal(designGroup.excluded_items[0].source_id, designSource.id);
  assert.equal(designGroup.reason, 'Outside the question topic');
  assert.equal(projectGroup.injected_items[0].id, projectContext.id);
  assert.equal(projectGroup.reason, 'Applies across the project');
  assert.ok(!generation.payload.includes(design.content));
  assert.ok(receipt.excluded_contexts.some(context => context.id === design.id && context.source_id === designSource.id));
});

test('English receipts localize older selector reasons and do not label project scope as a topic match', () => {
  const run = { snapshots: [{
    id: 'snapshot-1', phase: 'generation', call_status: 'completed', model: 'test', created_at: 'now',
    blocks: [
      { key: 'PROJECT_SCOPE', content: JSON.stringify({ topics: ['Product'] }) },
      { key: 'CONTEXT_SELECTION', content: JSON.stringify({ mode: 'semantic' }) },
      { key: 'CONTEXT:legacy', context_id: 'legacy', scope: 'topic', topics: ['Product'], version: 1,
        content: JSON.stringify({ title: 'Product context', content: 'Audience context', selection_reason: '질문 Topics와 일치' }) },
      { key: 'CONTEXT:project', context_id: 'project', scope: 'project', topics: [], version: 1,
        content: JSON.stringify({ title: 'Project context', content: 'Project background', selection_reason: 'Always included' }) },
    ],
    excluded: [
      { type: 'context', id: 'excluded', title: 'Design context', content: 'Design background', scope: 'topic', topics: ['Design'], reason: '질문 주제와 일치' },
      { type: 'decision', id: 'old-decision', content: 'Earlier criterion', scope: 'project', status: 'superseded', reason: '대체된 결정 · 이력 보관' },
    ],
  }] };

  const receipt = contextUsage(run, 'en');
  const productGroup = receipt.topic_clusters.find(group => group.topic === 'Product');
  const projectGroup = receipt.topic_clusters.find(group => group.scope === 'project');
  const designGroup = receipt.topic_clusters.find(group => group.topic === 'Design');
  const projectDecisions = receipt.topic_clusters.find(group => group.scope === 'project').excluded_items;
  assert.equal(productGroup.injected_items[0].selection_reason, 'Selected by question meaning');
  assert.equal(projectGroup.question_matched, false);
  assert.equal(projectGroup.reason, 'Applies across the project');
  assert.equal(designGroup.excluded_items[0].selection_reason, 'Excluded based on question meaning');
  assert.equal(projectDecisions[0].selection_reason, 'Superseded decision · History preserved');
});

test('background registration releases the completed answer while extraction continues', async t => {
  const { store, session } = fixture(t);
  let release, extractionStarted;
  const waiting = new Promise(r => { extractionStarted = r; });
  const gate = new Promise(r => { release = r; });
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.startsWith('사용자 대화 원문')) { extractionStarted(); await gate; return { text: '{"candidates":[]}' }; }
    if (instruction.includes('SQLite FTS5')) return { text: '{"topics":[],"registrations":[]}' };
    return { text: 'ANSWER_READY' };
  } };
  const question = store.addMessage(session.id, 'user', 'test', []);
  const backgroundTasks = new Set();
  const task = executeRun(store, provider, session.id, question, { provider: 'ollama', model: 'test', ollamaUrl: 'http://127.0.0.1:11434', autoContext: true, backgroundContextRegistration: true, onContextRegistrationStart: id => backgroundTasks.add(id), onContextRegistrationEnd: id => backgroundTasks.delete(id) });
  await waiting;
  const running = store.run(store.runs(session.id)[0].id);
  assert.equal(running.status, 'no_decisions');
  assert.equal(store.message(running.assistant_message_id).content, 'ANSWER_READY');
  assert.equal(running.validation.context_registration.status, 'running');
  assert.deepEqual([...backgroundTasks], [running.id]);
  assert.ok(contextUsage(running));
  const completed = await task;
  assert.equal(completed.assistant_message_id, running.assistant_message_id);
  assert.equal(completed.status, 'no_decisions');
  release();
  for (let tries = 0; tries < 30 && store.run(running.id).validation.context_registration.status === 'running'; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.run(running.id).validation.context_registration.status, 'completed');
  assert.equal(backgroundTasks.size, 0);
});

test('answer language follows the current message instead of the interface route', async t => {
  const { store, session } = fixture(t);
  for (const [message, locale, instruction] of [
    ['오늘 계획을 함께 정리해줘', 'en', /사용자의 현재 질문과 같은 언어로 답한다/],
    ['Help me plan my day', 'ko', /Answer the current question in the same language as the user/],
  ]) {
    const question = store.addMessage(session.id, 'user', message, []);
    const run = await executeRun(store, { call: async () => ({ text: 'A useful answer.' }) }, session.id, question, { provider: 'openai', model: 'test', locale, autoContext: false });
    const prompt = run.snapshots.find(snapshot => snapshot.phase === 'generation').blocks.find(block => block.key === 'INSTRUCTIONS').content;
    assert.match(prompt, instruction);
  }
});

test('answer format checker catches a language mismatch and an extra requested list item', () => {
  assert.deepEqual(answerFormatIssues('기능 세 가지를 알려줘', 'Three features are useful.').issues, ['language', 'count:3:0']);
  assert.deepEqual(answerFormatIssues('기능을 세 가지 알려줘', '1. 첫째\n2. 둘째\n3. 셋째\n추가로 네 번째도 고려하세요.').issues, ['extra_suggestion']);
  assert.deepEqual(answerFormatIssues('List 3 features', '1. One\n2. Two\n3. Three').issues, []);
});

test('a format repair retries a wrong-language answer with the exact requested item count', async t => {
  const { store, session } = fixture(t);
  const question = store.addMessage(session.id, 'user', '기능 세 가지를 번호로 알려줘.', []);
  const phases = [];
  const provider = { call: async request => {
    const instructions = request.payload.messages[0].content;
    if (instructions.includes('아래 초안의 내용과 근거는 바꾸지 말고')) {
      phases.push('format_correction');
      return { text: '1. 예약 시간 선택\n2. 진료 항목 입력\n3. 예약 확인 알림', latency: 0 };
    }
    phases.push('generation');
    return { text: '1. Booking management\n2. Clinic search\n3. Payment\n4. Ratings\nAdditionally, add a social feed.', latency: 0 };
  } };
  const run = await executeRun(store, provider, session.id, question, { provider: 'ollama', model: 'test', autoContext: false });
  assert.deepEqual(phases, ['generation', 'format_correction']);
  assert.deepEqual(run.snapshots.map(snapshot => snapshot.phase), ['generation', 'format_correction']);
  assert.equal(store.message(run.assistant_message_id).content, '1. 예약 시간 선택\n2. 진료 항목 입력\n3. 예약 확인 알림');
  assert.equal(run.validation.format_repair.accepted, true);
  assert.equal(run.validation.format_repair.expected_count, 3);
});

test('HTTP accepts a follow-up while automatic context registration is still running', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-background-http-'));
  const port = 25200 + Math.floor(Math.random() * 500);
  let releaseFirstExtraction, firstExtractionStarted, extractionCount = 0;
  const gate = new Promise(resolve => { releaseFirstExtraction = resolve; });
  const waiting = new Promise(resolve => { firstExtractionStarted = resolve; });
  const app = createApp({ directory, port, testOnlyProviders: ['ollama'], fetcher: async (_url, options) => {
    const request = JSON.parse(options.body), instructions = request.messages[0].content;
    let output = 'A useful answer.';
    if (instructions.includes('SQLite FTS5')) output = JSON.stringify({ topics: ['제품'], registrations: [] });
    if (request.messages[1].content.includes('[EXTRACTION_SCOPE]')) {
      extractionCount++;
      if (extractionCount === 1) { firstExtractionStarted(); await gate; }
      output = JSON.stringify({ candidates: [] });
    }
    return Response.json({ done: true, message: { content: output } });
  } });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { releaseFirstExtraction(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await fetch(`${app.origin}/api/state`), cookie = initial.headers.get('set-cookie').split(';')[0], state = await initial.json();
  const headers = { 'Content-Type': 'application/json', 'X-ContextFidelity-Token': state.csrf, Cookie: cookie };
  const request = async (path, data) => {
    const response = await fetch(`${app.origin}/api${path}`, { headers, method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  await request('/settings', { provider: 'ollama', model: 'test', ollamaUrl: 'http://127.0.0.1:11434', autoContext: true });
  const session = app.store.sessions(state.projects[0].id)[0];
  const first = await request(`/sessions/${session.id}/messages`, { content: '첫 번째 답변을 해줘', topics: [] });
  assert.equal(first.status, 202);
  await waiting;
  let detail;
  for (let tries = 0; tries < 50; tries++) {
    detail = (await request(`/sessions/${session.id}`)).value;
    if (detail.runs[0]?.assistant_message_id) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(detail.runs[0].assistant_message_id);
  assert.notEqual(detail.runs[0].status, 'running');
  assert.equal(detail.runs[0].validation.context_registration.status, 'running');
  const preview = (await request(`/sessions/${session.id}/context-preview`, { topics: [] })).value;
  assert.equal(preview.last_selection.run_id, first.value.run_id);
  assert.equal(preview.last_selection.created_at, detail.runs[0].created_at);
  assert.deepEqual(preview.last_selection.receipt.included, { saved_contexts: 0, conversation_contexts: 0, previous_messages: 0 });
  const followUp = await request(`/sessions/${session.id}/messages`, { content: '바로 이어서 두 번째 질문', topics: [] });
  assert.equal(followUp.status, 202);
  releaseFirstExtraction();
});

test('provider policy and limit diagnostics survive storage without exposing bearer credentials', async t => {
  const { store, session } = fixture(t);
  const provider = new Provider({ value: { apiKey: 'fixture-key' } }, async () => Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Bearer secret-value' } }, { status: 429, headers: { 'x-request-id': 'request-test' } }));
  const message = store.addMessage(session.id, 'user', 'test', []);
  const run = await executeRun(store, provider, session.id, message, { provider: 'openai', model: 'test', locale: 'en', autoContext: false });
  assert.equal(run.status, 'failed');
  assert.equal(run.snapshots[0].diagnostic.http_status, 429);
  assert.equal(run.snapshots[0].diagnostic.request_id, 'request-test');
  assert.ok(!JSON.stringify(run).includes('secret-value'));
  assert.match(run.error, /Usage limit/);
});

test('English and Korean routes share data but keep prompts, system messages and UI copy separate', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-locale-'));
  const app = createApp({ directory, port: 24897 });
  await new Promise(r => app.server.listen(24897, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.server.close(r)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const locale of ['en', 'ko']) {
    const prefix = locale === 'ko' ? '/ko' : '';
    for (const path of ['/', '/settings', '/contexts', '/records']) {
      const response = await fetch(app.origin + prefix + path);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`lang="${locale}"`));
    }
  }
  const state = await (await fetch(app.origin + '/api/state')).json();
  const headers = { 'Content-Type': 'application/json', 'X-ContextFidelity-Token': state.csrf, 'X-ContextFidelity-Locale': 'en' };
  const demo = await (await fetch(app.origin + '/api/demo', { method: 'POST', headers, body: '{}' })).json();
  const detail = await (await fetch(app.origin + '/api/sessions/' + demo.session.id, { headers })).json();
  assert.ok(detail.runs[0].context_usage.decisions.length);
  assert.ok(detail.messages.filter(m => m.role === 'system').every(m => !/[가-힣]/.test(m.content)));
  assert.ok(!/[가-힣]/.test(detail.messages.findLast(m => m.role === 'assistant').content));
  const run = app.store.run(demo.run_id);
  assert.ok(run.snapshots.every(s => !/[가-힣]/.test(JSON.parse(s.payload).instructions)));
  assert.ok(!/[가-힣]/.test(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')));
});

test('selection explicitly separates allowed context IDs from recent message IDs in both locales', async t => {
  const { store, session } = fixture(t);
  const { chooseContext } = await import('../src/context-ai.js');
  store.addMessage(session.id, 'assistant', 'earlier message', []);
  const question = store.addMessage(session.id, 'user', 'test', []);
  for (const locale of ['en', 'ko']) {
    await chooseContext(store, session.id, question, async (phase, instruction, blocks) => {
      assert.ok(blocks.some(b => b.key === 'CURRENT_QUESTION' && b.content === question.content));
      assert.ok(blocks.some(b => b.key === 'RECENT_DIALOGUE'));
      assert.ok(!blocks.some(b => b.key === 'CANDIDATE_IDS'));
      assert.ok(instruction.includes('SQLite FTS5'));
      if (locale === 'en') {
        assert.ok(!/[가-힣]/.test(instruction));
        assert.match(instruction, /The application uses SQLite FTS5 scores/);
      }
      if (locale === 'ko') assert.match(instruction, /짧은 후속 질문의 주제를 파악할 때 참고한다/);
      return '{"topics":[],"registrations":[]}';
    }, locale);
  }
});

test('restart retains an already validated answer if only extraction was interrupted', t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-restart-answer-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = store.sessions(store.projects()[0].id)[0];
  const question = store.addMessage(session.id, 'user', 'test', []);
  const runId = store.createRun(session.id, question.id, { provider: 'ollama', model: 'test' });
  const answer = store.addMessage(session.id, 'assistant', 'Checked answer', []);
  store.finishRun(runId, 'running', { verdict: 'consistent', answer_status: 'consistent', conflicts: [], note: 'Checked' }, null, answer.id);
  store.close(); store = new Store(directory);
  const restored = store.run(runId);
  assert.equal(restored.status, 'consistent');
  assert.equal(restored.assistant_message_id, answer.id);
  assert.match(restored.validation.context_warning, /중단/);
});

test('automatic topics route previous messages without any manually supplied topic hints', async t => {
  const { store, project, session } = fixture(t);
  const product = store.saveContext(project.id, { title: 'Product', content: 'Audience: independent developers', kind: 'reference', scope: 'topic', topics: ['Product'], include_mode: 'auto' });
  const design = store.saveContext(project.id, { title: 'Design', content: 'Palette: blue and white', kind: 'reference', scope: 'topic', topics: ['Design'], include_mode: 'auto' });
  let currentTopic = 'Product';
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.includes('SQLite FTS5')) return { text: JSON.stringify({ topics: [currentTopic], registrations: [] }) };
    if (instruction.startsWith('사용자 대화 원문')) return { text: '{"candidates":[]}' };
    return { text: currentTopic + ' answer' };
  } };
  const settings = { provider: 'ollama', model: 'test', ollamaUrl: 'http://127.0.0.1:11434', autoContext: true };
  const first = store.addMessage(session.id, 'user', 'Who is it for?', []);
  await executeRun(store, provider, session.id, first, settings);
  currentTopic = 'Design';
  const second = store.addMessage(session.id, 'user', 'What colors did we choose?', []);
  await executeRun(store, provider, session.id, second, settings);
  currentTopic = 'Product';
  const third = store.addMessage(session.id, 'user', 'Back to the audience.', []);
  const run = await executeRun(store, provider, session.id, third, settings);
  const used = contextUsage(run);
  assert.deepEqual(used.topics, ['Product']);
  assert.deepEqual(used.contexts.map(c => c.id), [product.id]);
  assert.ok(used.history.some(h => h.source_id === first.id));
  assert.ok(!used.history.some(h => h.source_id === second.id));
  assert.deepEqual(store.message(third.id).topics, []);
  assert.ok(!readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').includes('id="topics-input"'));
});

test('a delayed selection excludes later messages; frozen receipts never borrow the latest question', async t => {
  const { store, session } = fixture(t);
  const first = store.addMessage(session.id, 'user', 'First question about the audience', []);
  const later = store.addMessage(session.id, 'user', 'LATER_UNRELATED_MESSAGE', []);
  const { selectContext } = await import('../src/pipeline.js');
  const context = selectContext(store, session.id, first);
  assert.ok(!context.blocks.some(b => b.source_id === later.id));
  const run = await executeRun(store, null, session.id, first, { provider: 'demo', model: 'context-demo', locale: 'en' });
  const frozen = contextUsage(run);
  assert.equal(frozen.current_question.source_id, first.id);
  assert.equal(frozen.current_question.content, first.content);
  assert.equal(frozen.history.length, 0);
  store.addMessage(session.id, 'user', 'Newest question', []);
  assert.deepEqual(contextUsage(store.run(run.id)), frozen);
});

test('user facts register automatically while assistant proposals wait for review', async t => {
  const { store, project, session, directory } = fixture(t);
  const question = store.addMessage(session.id, 'user', 'Our audience is independent developers.', []);
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.includes('SQLite FTS5')) {
      return { text: JSON.stringify({ topics: ['Product'], registrations: [] }) };
    }
    if (instruction.startsWith('사용자 대화 원문')) {
      const answer = store.messages(session.id).find(m => m.role === 'assistant');
      return { text: JSON.stringify({ candidates: [
        { title: 'Audience', content: question.content, kind: 'background', scope: 'topic', topics: ['Product'], source_id: question.id },
        { title: 'Proposal', content: answer.content, kind: 'hypothesis', scope: 'topic', topics: ['Product'], source_id: answer.id }
      ] }) };
    }
    return { text: 'Consider interviewing three independent developers.' };
  } };
  const settings = { provider: 'ollama', model: 'test', autoContext: true };
  const first = await executeRun(store, provider, session.id, question, settings);
  const frozen = contextUsage(first);
  assert.deepEqual(first.snapshots.map(snapshot => snapshot.phase), ['generation', 'extraction']);
  assert.equal(frozen.contexts.length, 0);
  assert.equal(first.snapshots.find(snapshot => snapshot.phase === 'generation').blocks.some(block => block.context_id), false);
  assert.equal(store.contexts(project.id).length, 1);
  assert.ok(store.contexts(project.id).every(c => c.registration === 'automatic' && c.run_id === first.id));
  assert.equal(store.candidates(project.id).filter(c => c.status === 'pending').length, 1);
  assert.equal(store.decisions(project.id).length, 0);
  const secondQuestion = store.addMessage(session.id, 'user', 'How should we interview independent developers?', []);
  const second = await executeRun(store, provider, session.id, secondQuestion, settings);
  assert.equal(contextUsage(second).contexts.length, 1);
  assert.deepEqual(contextUsage(store.run(first.id)), frozen);
  assert.equal(store.contexts(project.id).length, 1); // exact-source deduplication; assistant hypotheses remain pending.
  assert.equal(store.candidates(project.id).filter(c => c.status === 'pending').length, 1);
  assert.ok(!readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').includes("button('컨텍스트로 저장'"));
});

test('a first-turn answer stays context-free while both sides of the conversation are saved for later', async t => {
  const { store, project, session } = fixture(t);
  const firstQuestion = store.addMessage(session.id, 'user', '내 이름은 이은룡이고 개발자가 되고 싶어.', []);
  const secondQuestion = '개발자가 되려면 무엇부터 배우면 좋을까?';
  const phases = [];
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.includes('SQLite FTS5')) {
      phases.push('selection');
      const latest = store.messages(session.id).filter(message => message.role === 'user').at(-1);
      return { text: JSON.stringify({
        topics: ['개발 진로'],
        // Reproduce a selector that proposes saving the current utterance.
        registrations: [{ title: '현재 질문', content: latest.content, kind: 'background', scope: 'topic', topics: ['개발 진로'], source_id: latest.id, supersedes: null }]
      }) };
    }
    if (instruction.startsWith('사용자 대화 원문')) {
      phases.push('extraction');
      const latestUser = store.messages(session.id).filter(message => message.role === 'user').at(-1);
      const latestAssistant = store.messages(session.id).filter(message => message.role === 'assistant').at(-1);
      return { text: JSON.stringify({ candidates: [
        { title: '개발자 목표', content: firstQuestion.content, kind: 'background', scope: 'topic', topics: ['개발 진로'], source_id: firstQuestion.id },
        { title: '학습 제안', content: latestAssistant.content, kind: 'hypothesis', scope: 'topic', topics: ['개발 진로'], source_id: latestAssistant.id },
        ...(latestUser.id === firstQuestion.id ? [] : [{ title: '개발 학습 질문', content: latestUser.content, kind: 'background', scope: 'topic', topics: ['개발 진로'], source_id: latestUser.id }])
      ] }) };
    }
    phases.push('generation');
    return { text: store.messages(session.id).filter(message => message.role === 'user').at(-1).id === firstQuestion.id
      ? '좋은 목표예요. 작은 웹 프로젝트를 하나 정해 만들어 보면서 JavaScript 기초와 Git을 함께 익혀보세요.'
      : '먼저 HTML, CSS, JavaScript 기초를 익히고 작은 웹 페이지를 만들어 보세요. 그다음 Git과 백엔드 기초를 더하면 좋습니다.' };
  } };
  const settings = { provider: 'ollama', model: 'test', autoContext: true };

  const first = await executeRun(store, provider, session.id, firstQuestion, settings);
  assert.deepEqual(phases, ['generation', 'extraction']);
  assert.equal(contextUsage(first).contexts.length, 0);
  assert.equal(first.snapshots.find(snapshot => snapshot.phase === 'generation').blocks.some(block => block.context_id), false);
  assert.match(store.message(first.assistant_message_id).content, /작은 웹 프로젝트/);
  assert.equal(store.contexts(project.id).length, 1); // User background is stored; the assistant proposal awaits review.
  assert.equal(store.candidates(project.id).filter(item => item.status === 'pending').length, 1);

  const next = store.addMessage(session.id, 'user', secondQuestion, []);
  phases.length = 0;
  const second = await executeRun(store, provider, session.id, next, settings);
  const generation = second.snapshots.find(snapshot => snapshot.phase === 'generation');
  assert.deepEqual(phases, ['selection', 'generation', 'extraction']);
  assert.ok(generation.blocks.some(block => block.context_id && block.source_id === firstQuestion.id));
  assert.ok(!generation.blocks.some(block => block.context_id && block.source_id === next.id));
  assert.equal(store.contexts(project.id).length, 2); // User-origin context is saved; model proposals remain pending.
  assert.equal(store.candidates(project.id).filter(item => item.status === 'pending').length, 2);
});

test('one-off activity-order advice stays in chat history and old automatic hypotheses are archived', async t => {
  const { store, project, session } = fixture(t);
  const study = store.addMessage(session.id, 'user', '친구와 스터디카페에서 공부하기로 했어.', ['친구와 스터디카페에서 공부']);
  const meal = store.addMessage(session.id, 'user', '내일 엄마와 식사하기로 했어.', ['내일 엄마와 식사']);
  const durable = [
    store.saveContext(project.id, { title: '친구와 스터디카페에서 공부', content: study.content, kind: 'background', scope: 'topic', topics: ['친구와 스터디카페에서 공부'], include_mode: 'auto', source_id: study.id, registration: 'automatic' }),
    store.saveContext(project.id, { title: '내일 엄마와 식사하기', content: meal.content, kind: 'background', scope: 'topic', topics: ['내일 엄마와 식사'], include_mode: 'auto', source_id: meal.id, registration: 'automatic' })
  ];
  const orderQuestion = store.addMessage(session.id, 'user', '친구랑 스카 먼저 가는 게 좋을까, 밥 먼저 먹는 게 좋을까?', ['친구와 스터디카페에서 공부', '내일 엄마와 식사']);
  const oldAdvice = store.addMessage(session.id, 'assistant', '공부와 식사 순서 제안: 스터디카페에 먼저 갔다가 식사하세요.', ['친구와 스터디카페에서 공부', '내일 엄마와 식사']);
  const transient = store.saveContext(project.id, { title: '공부와 식사 순서 제안', content: oldAdvice.content, kind: 'hypothesis', scope: 'topic', topics: ['친구와 스터디카페에서 공부', '내일 엄마와 식사'], include_mode: 'auto', source_id: oldAdvice.id, registration: 'automatic' });
  const question = store.addMessage(session.id, 'user', '그럼 어떤 순서로 하는 게 좋을까?', ['친구와 스터디카페에서 공부', '내일 엄마와 식사']);
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.includes('SQLite FTS5')) return { text: JSON.stringify({ topics: ['친구와 스터디카페에서 공부', '내일 엄마와 식사'], registrations: [] }) };
    if (instruction.startsWith('사용자 대화 원문')) {
      const answer = store.messages(session.id).filter(message => message.role === 'assistant').at(-1);
      return { text: JSON.stringify({ candidates: [
        { title: '예전 순서 제안', content: oldAdvice.content, kind: 'hypothesis', scope: 'topic', topics: ['친구와 스터디카페에서 공부'], source_id: oldAdvice.id },
        { title: '이번 순서 제안', content: answer.content, kind: 'hypothesis', scope: 'topic', topics: ['친구와 스터디카페에서 공부'], source_id: answer.id }
      ] }) };
    }
    return { text: '스터디카페에서 공부한 뒤 식사하면 이동을 한 번에 정리할 수 있어요.' };
  } };
  const run = await executeRun(store, provider, session.id, question, { provider: 'ollama', model: 'test', autoContext: true });
  const generation = run.snapshots.find(snapshot => snapshot.phase === 'generation');
  assert.equal(store.context(transient.id).status, 'archived');
  assert.equal(store.contexts(project.id).filter(item => item.status === 'active').length, 2);
  assert.ok(durable.every(item => store.context(item.id).status === 'active'));
  assert.ok(!generation.blocks.some(block => block.context_id === transient.id));
  assert.equal(store.contexts(project.id).filter(item => item.status === 'active' && item.kind === 'hypothesis').length, 0);
});

test('a revised criterion is registered during selection and validated in the current answer', async t => {
  const { store, session } = fixture(t);
  const previous = store.register(session.id, 'In this project, evaluate speed first.', [], { locale: 'en' }).decision;
  const question = store.addMessage(session.id, 'user', 'In this project, evaluate accuracy first instead of speed.', []);
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.includes('SQLite FTS5')) return { text: JSON.stringify({ topics: ['Evaluation'], registrations: [{ title: 'Revised criterion', content: question.content, kind: 'decision', scope: 'project', topics: ['Evaluation'], source_id: question.id, supersedes: previous.id }] }) };
    if (instruction.startsWith('당신은')) return { text: JSON.stringify({ verdict: 'consistent', conflicts: [], note: 'Accuracy criterion followed' }) };
    if (instruction.startsWith('사용자 대화 원문')) return { text: '{"candidates":[]}' };
    return { text: 'I will evaluate accuracy first.' };
  } };
  const run = await executeRun(store, provider, session.id, question, { provider: 'ollama', model: 'test', autoContext: true });
  assert.equal(run.status, 'consistent');
  assert.equal(store.decision(previous.id).status, 'superseded');
  assert.equal(contextUsage(run).decisions[0].source_id, question.id);
  assert.equal(contextUsage(run).decisions[0].version, 2);
  assert.ok(!run.snapshots.find(s => s.phase === 'generation').payload.includes(previous.content));
});


test('untagged legacy messages are not injected into a newly identified unrelated topic', async t => {
  const { store, session } = fixture(t);
  const older = store.addMessage(session.id, 'user', 'Old job-search conversation without classified topics', []);
  store.addMessage(session.id, 'assistant', 'Old job-search advice', []);
  const current = store.addMessage(session.id, 'user', 'Suggest a hackathon idea', ['Hackathon']);
  const { selectContext } = await import('../src/pipeline.js');
  const context = selectContext(store, session.id, current);
  assert.ok(!context.blocks.some(b => b.key.startsWith('HISTORY:')));
  assert.ok(context.excluded.some(b => b.id === older.id));
});
