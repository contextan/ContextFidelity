import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8899';
const state = await (await fetch(origin + '/api/state')).json();
assert.notEqual(state.settings.provider, 'demo', 'Connect a real model before this integration test.');
const headers = { 'Content-Type': 'application/json', 'X-ContextFidelity-Token': state.csrf, 'X-ContextFidelity-Locale': 'en' };
const api = async (path, data) => {
  const response = await fetch(origin + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json(); assert.ok(response.ok, value.error); return value;
};
const project = await api('/projects', { name: 'Automatic context E2E · 2026-10-08' });
const session = (await api(`/projects/${project.id}`)).sessions[0];
const questions = [
  'For this project, target independent developers rather than enterprise teams. Propose one concrete interview question in one sentence.',
  'Switch to design: use a light theme with blue accents for the interface. Suggest one layout detail in one sentence.',
  'Back to the product audience: who are we targeting and what should we ask in an interview? Answer in one sentence.'
];
const results = []; let firstReceipt;
for (const [index, content] of questions.entries()) {
  const started = await api(`/sessions/${session.id}/messages`, { content, topics: [] });
  let run; const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    run = await api(`/runs/${started.run_id}`);
    if (run.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.ok(run.assistant_message_id && run.status !== 'running' && run.status !== 'failed', run.error || 'Answer not completed');
  assert.equal(run.context_usage.current_question.source_id, started.message.id);
  assert.ok(!run.validation.context_warning, run.validation.context_warning);
  const context = await api(`/projects/${project.id}`);
  results.push({ index: index + 1, run_id: run.id, status: run.status, topics: run.context_usage.topics, used_contexts: run.context_usage.contexts.length, used_decisions: run.context_usage.decisions.length, automatically_registered: run.validation.automatically_registered.length, total_contexts: context.contexts.length, assistant_hypotheses: context.contexts.filter(c => c.kind === 'hypothesis').length, context_ids: run.context_usage.contexts.map(c => c.id), submitted_topics: [] });
  if (index === 0) {
    firstReceipt = run.context_usage;
    assert.ok(run.validation.automatically_registered.length, 'Expected automatically registered context');
    assert.ok(run.context_usage.decisions.some(d => d.source_id === started.message.id), 'Current explicit criterion must be registered before generation');
  } else assert.deepEqual((await api(`/runs/${results[0].run_id}`)).context_usage, firstReceipt);
  console.log(JSON.stringify(results.at(-1)));
}
const detail = await api(`/sessions/${session.id}`);
const contexts = (await api(`/projects/${project.id}`)).contexts;
const assistantSources = new Set(detail.messages.filter(m => m.role === 'assistant').map(m => m.id));
assert.ok(contexts.some(c => c.registration === 'automatic' && assistantSources.has(c.source_id) && c.kind === 'hypothesis'), 'Expected automatic assistant hypothesis');
const firstSources = new Set([detail.messages[0].id, detail.runs.find(r => r.id === results[0].run_id).assistant_message_id]);
assert.ok((await api(`/runs/${results[2].run_id}`)).context_usage.contexts.some(c => firstSources.has(c.source_id)), 'Returning topic must recover original context');
const designAssistant = detail.runs.find(r => r.id === results[1].run_id).assistant_message_id;
assert.ok(!(await api(`/runs/${results[2].run_id}`)).context_usage.contexts.some(c => c.source_id === designAssistant), 'Design proposal must not enter product answer');
writeFileSync('outputs/automatic-context-e2e.json', JSON.stringify({ project_id: project.id, session_id: session.id, provider: state.settings.provider, model: state.settings.model, results, frozen_receipt_verified: true, assistant_provenance_verified: true, topic_exclusion_verified: true }, null, 2));
console.log('Automatic context integration test passed.');
