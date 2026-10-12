import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { executeRun } from '../src/pipeline.js';
import { contextUsage } from '../src/context-usage.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'contextfidelity-fts5-'));
  const store = new Store(directory), project = store.projects()[0], session = store.sessions(project.id)[0];
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const add = (title, content, changes = {}) => store.saveContext(project.id, {
    title, content, kind: 'reference', scope: 'topic', topics: ['검색'], include_mode: 'auto', ...changes
  });
  return { directory, store, project, session, add };
}

test('FTS5 returns multiple contexts above the transparent keyword/topic threshold in relevance order', t => {
  const { store, project, session, add } = setup(t);
  const exact = add('SQLite FTS5 keyword retrieval', 'SQLite FTS5 retrieves saved context by matching question keywords.');
  const partial = add('Context keyword search', 'The FTS5 index searches saved notes and context.');
  const weak = add('Saved notes', 'A saved context note.', { topics: ['other'] });
  const other = store.createProject('Separate project');
  const privateItem = store.saveContext(other.id, { title: 'SQLite FTS5 private', content: 'SQLite FTS5 retrieves saved context by matching question keywords.', kind: 'reference', scope: 'project', topics: [], include_mode: 'auto' });

  const result = store.searchContexts(session.id, project.id, 'SQLite FTS5 keyword search retrieves saved context', ['검색'], { threshold: 0.45, limit: 5 });
  assert.equal(result.engine, 'sqlite-fts5');
  assert.equal(result.threshold, 0.45);
  assert.deepEqual(result.candidates.map(item => item.id), [exact.id, partial.id]);
  assert.ok(result.candidates[0].score > result.candidates[1].score);
  assert.ok(result.candidates.every(item => item.score >= result.threshold));
  assert.ok(result.scores.some(item => item.context_id === weak.id && item.score < result.threshold));
  assert.ok(!result.candidates.some(item => item.id === privateItem.id));
  assert.ok(result.candidates.every(item => item.project_id === project.id));
});

test('the 50 percent default includes an exact-threshold match and rejects weaker matches', t => {
  const { store, project, session, add } = setup(t);
  const boundary = add('Alpha reference', 'A short note.', { topics: ['Alpha'] });
  const result = store.searchContexts(session.id, project.id, 'Alpha Zeta', ['Alpha Beta']);
  assert.equal(result.threshold, 0.5);
  assert.equal(result.scores.find(item => item.context_id === boundary.id).score, 0.5);
  assert.ok(result.candidates.some(item => item.id === boundary.id));
});

test('per-chat overrides, off mode, archive, restore, and context version changes stay in sync with the FTS index', t => {
  const { store, project, session, add } = setup(t);
  const first = add('Korean context search', 'SQLite FTS5 keyword retrieval keeps searchable context notes.');
  const excluded = add('Context retrieval', 'SQLite FTS5 keyword search');
  const off = add('Disabled search', 'SQLite FTS5 keyword search', { include_mode: 'off' });
  const query = 'SQLite FTS5 keyword search context';
  const search = () => store.searchContexts(session.id, project.id, query, [], { threshold: 0.2, limit: 8 });

  assert.ok(search().candidates.some(item => item.id === first.id));
  store.setOverride(session.id, excluded.id, 'exclude');
  assert.ok(!search().candidates.some(item => item.id === excluded.id));
  assert.ok(!search().candidates.some(item => item.id === off.id));

  store.archiveContext(first.id, true);
  assert.ok(!search().candidates.some(item => item.id === first.id));
  store.archiveContext(first.id, false);
  assert.ok(search().candidates.some(item => item.id === first.id));

  const next = store.saveContext(project.id, { ...first, content: 'SQLite FTS5 keyword retrieval indexes the edited context version.' }, first.id);
  const results = search().candidates;
  assert.ok(results.some(item => item.id === next.id));
  assert.ok(!results.some(item => item.id === first.id));
});

test('opening an existing database creates and backfills the FTS5 index idempotently', t => {
  const { directory, store, project, session, add } = setup(t);
  const item = add('Developer goal', 'The user wants to become a software developer.');
  store.db.exec('DROP TRIGGER context_search_insert; DROP TRIGGER context_search_status; DROP TABLE context_search;');
  store.close();
  const migrated = new Store(directory);
  let migratedClosed = false;
  t.after(() => { if (!migratedClosed) migrated.close(); });

  const result = migrated.searchContexts(session.id, project.id, 'software developer goal', [], { threshold: 0.1 });
  assert.ok(result.candidates.some(candidate => candidate.id === item.id));
  migrated.close();
  migratedClosed = true;
  const reopened = new Store(directory);
  t.after(() => reopened.close());
  assert.ok(reopened.searchContexts(session.id, project.id, 'software developer goal', [], { threshold: 0.1 }).candidates.some(candidate => candidate.id === item.id));
});

test('a normal answer sends several above-threshold contexts and saves their FTS5 scores in its receipt', async t => {
  const { store, project, session, add } = setup(t);
  const first = add('Retrieval design', 'SQLite FTS5 keyword retrieval can select several saved context notes.');
  const second = add('Retrieval threshold', 'A keyword score threshold filters saved SQLite FTS5 context.');
  const unrelated = add('Color palette', 'The product design uses a violet and white color palette.', { topics: ['Design'] });
  const question = store.addMessage(session.id, 'user', 'How does SQLite FTS5 keyword retrieval select saved context notes?', []);
  const provider = { call: async request => {
    const prompt = request.payload.messages[0].content;
    if (prompt.includes('SQLite FTS5')) return { text: JSON.stringify({ topics: ['검색'], registrations: [] }), usage: null, latency: 0 };
    if (prompt.startsWith('사용자 대화 원문')) return { text: '{"candidates":[]}', usage: null, latency: 0 };
    return { text: 'The search retrieves matching context notes.', usage: null, latency: 0 };
  } };
  const run = await executeRun(store, provider, session.id, question, { provider: 'ollama', model: 'test', autoContext: true });
  const receipt = contextUsage(run);
  assert.equal(receipt.selection_mode, 'fts5');
  assert.equal(receipt.search.engine, 'sqlite-fts5');
  assert.equal(receipt.search.threshold, 0.5);
  assert.ok(receipt.contexts.some(item => item.id === first.id));
  assert.ok(receipt.contexts.some(item => item.id === second.id));
  assert.ok(receipt.contexts.every(item => item.retrieval?.matched_terms?.length));
  assert.ok(receipt.contexts.every(item => Number(item.selection_reason.match(/SQLite FTS5 키워드·주제 점수 (\d+)%/)?.[1]) >= 50));
  const englishReceipt = contextUsage(run, 'en');
  assert.ok(englishReceipt.contexts.every(item => item.selection_reason.startsWith('SQLite FTS5 keyword/topic score ')));
  assert.ok(receipt.excluded_contexts.some(item => item.id === unrelated.id));
  const generation = run.snapshots.find(snapshot => snapshot.phase === 'generation');
  const selection = JSON.parse(generation.blocks.find(block => block.key === 'CONTEXT_SELECTION').content);
  assert.ok(selection.search.candidates.some(item => item.context_id === first.id));
  assert.ok(selection.search.candidates.some(item => item.context_id === second.id));
  assert.ok(!JSON.stringify(selection).includes(first.content));
  assert.ok(!JSON.stringify(selection).includes(second.content));
});
