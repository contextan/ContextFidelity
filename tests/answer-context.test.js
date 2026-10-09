import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { executeRun } from '../src/pipeline.js';
import { contextUsage } from '../src/context-usage.js';
import { Provider, buildRequest } from '../src/provider.js';
import { createApp } from '../src/server.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-receipt-'));
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

test('chat model endpoint persists a selection without changing another conversation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-session-model-'));
  const port = 24820 + Math.floor(Math.random() * 300);
  const requestedModels = [];
  const app = createApp({ directory, port, testOnlyProviders: ['openai'], fetcher: async (_url, options) => {
    requestedModels.push(JSON.parse(options.body).model);
    const text = requestedModels.length === 1 ? 'Answer from this chat model.' : JSON.stringify({ verdict: 'consistent', conflicts: [], note: 'No conflict.' });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await fetch(`${app.origin}/api/state`), cookie = initial.headers.get('set-cookie').split(';')[0], state = await initial.json();
  const headers = { 'Content-Type': 'application/json', 'X-ContextPulse-Token': state.csrf, Cookie: cookie };
  const call = async (path, data) => (await fetch(`${app.origin}/api${path}`, { headers, method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) })).json();
  const project = app.store.projects()[0], first = app.store.sessions(project.id)[0], second = app.store.createSession(project.id);
  await call('/settings', { provider: 'openai', model: '', apiKey: 'fixture-session-model-key', autoContext: false });
  const selected = await call(`/sessions/${first.id}/model`, { model: 'model-for-first-chat' });
  assert.equal(selected.session.model_provider, 'openai');
  assert.equal(selected.session.model, 'model-for-first-chat');
  const other = await call(`/sessions/${second.id}`);
  assert.equal(other.session.model, '');
  assert.equal(other.session.model_provider, '');
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
  assert.ok(run.snapshots.every(snapshot => snapshot.model === 'model-for-first-chat'));
  assert.deepEqual(requestedModels, ['model-for-first-chat']);
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

test('validated answer and receipt are available while candidate extraction is still running', async t => {
  const { store, session } = fixture(t);
  let release, extractionStarted;
  const waiting = new Promise(r => { extractionStarted = r; });
  const gate = new Promise(r => { release = r; });
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.startsWith('사용자 대화 원문')) { extractionStarted(); await gate; return { text: '{"candidates":[]}' }; }
    if (instruction.startsWith('질문에 필요한')) return { text: '{"topics":[],"contexts":[]}' };
    return { text: 'ANSWER_READY' };
  } };
  const question = store.addMessage(session.id, 'user', 'test', []);
  const task = executeRun(store, provider, session.id, question, { provider: 'ollama', model: 'test', ollamaUrl: 'http://127.0.0.1:11434', autoContext: true });
  await waiting;
  const running = store.run(store.runs(session.id)[0].id);
  assert.equal(running.status, 'running');
  assert.equal(store.message(running.assistant_message_id).content, 'ANSWER_READY');
  assert.ok(contextUsage(running));
  release(); const completed = await task;
  assert.equal(completed.assistant_message_id, running.assistant_message_id);
  assert.equal(completed.status, 'no_decisions');
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
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-locale-'));
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
  const headers = { 'Content-Type': 'application/json', 'X-ContextPulse-Token': state.csrf, 'X-ContextPulse-Locale': 'en' };
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
      assert.equal(blocks.find(b => b.key === 'CANDIDATE_IDS').content, '[]');
      assert.ok(instruction.includes('CANDIDATE_IDS'));
      if (locale === 'en') {
        assert.ok(!/[가-힣]/.test(instruction));
        assert.match(instruction, /with a short inclusion or exclusion reason in English/);
      }
      if (locale === 'ko') assert.match(instruction, /짧은 선택·제외 이유를 한국어로 적는다/);
      return '{"topics":[],"contexts":[]}';
    }, locale);
  }
});

test('restart retains an already validated answer if only extraction was interrupted', t => {
  const directory = mkdtempSync(join(tmpdir(), 'contextpulse-restart-answer-'));
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
    if (instruction.startsWith('질문에 필요한')) return { text: JSON.stringify({ topics: [currentTopic], contexts: [product, design].map(c => ({ id: c.id, include: c.topics.includes(currentTopic), reason: 'Question meaning' })) }) };
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

test('user facts and assistant proposals register without buttons and feed only subsequent answers', async t => {
  const { store, project, session, directory } = fixture(t);
  const question = store.addMessage(session.id, 'user', 'Our audience is independent developers.', []);
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.startsWith('질문에 필요한')) {
      const candidates = store.contexts(project.id);
      return { text: JSON.stringify({ topics: ['Product'], contexts: candidates.map(c => ({ id: c.id, include: true, reason: 'Audience context' })) }) };
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
  assert.equal(store.contexts(project.id).length, 2);
  assert.ok(store.contexts(project.id).every(c => c.registration === 'automatic' && c.run_id === first.id));
  assert.equal(store.decisions(project.id).length, 0);
  const secondQuestion = store.addMessage(session.id, 'user', 'How should we interview them?', []);
  const second = await executeRun(store, provider, session.id, secondQuestion, settings);
  assert.equal(contextUsage(second).contexts.length, 2);
  assert.deepEqual(contextUsage(store.run(first.id)), frozen);
  assert.equal(store.contexts(project.id).length, 2); // exact-source deduplication
  assert.ok(!readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').includes("button('컨텍스트로 저장'"));
});

test('a first-turn answer stays context-free while both sides of the conversation are saved for later', async t => {
  const { store, project, session } = fixture(t);
  const firstQuestion = store.addMessage(session.id, 'user', '내 이름은 이은룡이고 개발자가 되고 싶어.', []);
  const secondQuestion = '개발자가 되려면 무엇부터 배우면 좋을까?';
  const phases = [];
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.startsWith('질문에 필요한')) {
      phases.push('selection');
      const latest = store.messages(session.id).filter(message => message.role === 'user').at(-1);
      const candidates = store.contexts(project.id);
      return { text: JSON.stringify({
        topics: ['개발 진로'],
        contexts: candidates.map(item => ({ id: item.id, include: true, reason: '개발 진로에 관련된 정보' })),
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
  assert.equal(store.contexts(project.id).length, 2); // User background and assistant proposal are stored after the answer.

  const next = store.addMessage(session.id, 'user', secondQuestion, []);
  phases.length = 0;
  const second = await executeRun(store, provider, session.id, next, settings);
  const generation = second.snapshots.find(snapshot => snapshot.phase === 'generation');
  assert.deepEqual(phases, ['selection', 'generation', 'extraction']);
  assert.ok(generation.blocks.some(block => block.context_id && block.source_id === firstQuestion.id));
  assert.ok(!generation.blocks.some(block => block.context_id && block.source_id === next.id));
  assert.equal(store.contexts(project.id).length, 4); // The second turn's user and assistant context are saved for following turns.
});

test('a revised criterion is registered during selection and validated in the current answer', async t => {
  const { store, session } = fixture(t);
  const previous = store.register(session.id, 'In this project, evaluate speed first.', [], { locale: 'en' }).decision;
  const question = store.addMessage(session.id, 'user', 'In this project, evaluate accuracy first instead of speed.', []);
  const provider = { call: async request => {
    const instruction = request.payload.messages[0].content;
    if (instruction.startsWith('질문에 필요한')) return { text: JSON.stringify({ topics: ['Evaluation'], contexts: [], registrations: [{ title: 'Revised criterion', content: question.content, kind: 'decision', scope: 'project', topics: ['Evaluation'], source_id: question.id, supersedes: previous.id }] }) };
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
