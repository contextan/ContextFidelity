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
      if (locale === 'en') assert.ok(!/[가-힣]/.test(instruction));
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
  assert.equal(frozen.contexts.length, 0);
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
