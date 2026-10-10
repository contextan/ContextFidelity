import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { systemText } from './localization.js';

export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const encode = (value) => JSON.stringify(value);
const decode = (row, fields = []) => {
  if (!row) return null;
  const result = { ...row };
  for (const field of fields) result[field] = JSON.parse(result[field]);
  return result;
};

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'our', 'please', 'the', 'this', 'to', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you',
  '그', '그거', '그건', '그렇게', '그리고', '뭐', '뭘', '무엇', '어떤', '어떻게', '이', '이거', '이건', '저', '저거', '저건', '좀', '해', '해줘', '할까', '하면', '해도', '해주세요', '알려줘', '알려주세요', '왜', '은', '는', '이', '가', '을', '를', '의', '에', '에서', '로', '으로', '와', '과', '도', '만', '및'
]);
const KOREAN_PARTICLES = ['으로부터', '로부터', '에게서', '에서부터', '한테서', '에게', '한테', '에서는', '으로는', '까지', '부터', '에서', '으로', '이랑', '랑', '은', '는', '이', '가', '을', '를', '와', '과', '도', '만', '의', '에', '로', '야', '요', '죠'];

function searchToken(value) {
  let token = value.toLocaleLowerCase().normalize('NFKC');
  if (/^[\p{Script=Hangul}]+$/u.test(token)) {
    for (const particle of KOREAN_PARTICLES) {
      if (token.length > particle.length + 1 && token.endsWith(particle)) { token = token.slice(0, -particle.length); break; }
    }
    token = token.replace(/고싶(?:어|다)?$/u, '').replace(/려면$/u, '');
  } else if (/^[a-z]+$/u.test(token)) {
    if (token.length > 5 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
    else if (token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3).replace(/(.)\1$/u, '$1');
    else if (token.length > 4 && token.endsWith('ed')) token = token.slice(0, -2);
    else if (token.length > 4 && token.endsWith('es')) token = token.slice(0, -2);
    else if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) token = token.slice(0, -1);
  }
  return token;
}

export function contextSearchTerms(value, limit = 16) {
  const tokens = String(value || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(tokens.map(searchToken).filter(token => token.length >= 2 && !SEARCH_STOP_WORDS.has(token)))].slice(0, limit);
}

function searchDocumentTerms(value) {
  return new Set(contextSearchTerms(value, 5000));
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'contextpulse.sqlite');
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,created_at TEXT NOT NULL,model_provider TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT 'high');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),role TEXT NOT NULL,content TEXT NOT NULL,topics TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_id TEXT NOT NULL REFERENCES messages(id),content TEXT NOT NULL,scope TEXT NOT NULL,topics TEXT NOT NULL,version INTEGER NOT NULL,supersedes TEXT REFERENCES decisions(id),status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),user_message_id TEXT NOT NULL REFERENCES messages(id),assistant_message_id TEXT REFERENCES messages(id),provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,error TEXT,validation TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),phase TEXT NOT NULL,ordinal INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,endpoint TEXT NOT NULL,payload TEXT NOT NULL,blocks TEXT NOT NULL,excluded TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS call_results(snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id),status TEXT NOT NULL,output TEXT,usage TEXT,latency_ms INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,topics TEXT NOT NULL,include_mode TEXT NOT NULL,source_id TEXT REFERENCES messages(id),version INTEGER NOT NULL,supersedes TEXT REFERENCES contexts(id),status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_suppressions(source_id TEXT PRIMARY KEY REFERENCES messages(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_overrides(session_id TEXT NOT NULL REFERENCES sessions(id),root_id TEXT NOT NULL,mode TEXT NOT NULL,PRIMARY KEY(session_id,root_id));
      CREATE TABLE IF NOT EXISTS context_candidates(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),session_id TEXT NOT NULL REFERENCES sessions(id),run_id TEXT NOT NULL REFERENCES runs(id),source_id TEXT NOT NULL REFERENCES messages(id),title TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,topics TEXT NOT NULL,supersedes TEXT REFERENCES decisions(id),status TEXT NOT NULL,target_id TEXT,created_at TEXT NOT NULL,UNIQUE(source_id,content,kind));
      CREATE TRIGGER IF NOT EXISTS immutable_snapshot_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshot is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_snapshot_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshot is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'message is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_decision_content BEFORE UPDATE OF content,scope,topics,source_id,version,supersedes,project_id ON decisions BEGIN SELECT RAISE(ABORT,'decision version is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_context_version BEFORE UPDATE OF root_id,project_id,title,content,kind,scope,topics,include_mode,source_id,version,supersedes ON contexts BEGIN SELECT RAISE(ABORT,'context version is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_candidate_content BEFORE UPDATE OF project_id,session_id,run_id,source_id,title,content,kind,scope,topics,supersedes ON context_candidates BEGIN SELECT RAISE(ABORT,'candidate source is immutable'); END;
    `);
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(c => c.name === 'purpose')) this.db.exec("ALTER TABLE runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'chat'");
    for (const [name, type] of [['model_provider', "TEXT NOT NULL DEFAULT ''"], ['model', "TEXT NOT NULL DEFAULT ''"], ['reasoning_effort', "TEXT NOT NULL DEFAULT 'high'"]]) {
      if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    if (!this.db.prepare('PRAGMA table_info(call_results)').all().some(c => c.name === 'diagnostic')) this.db.exec('ALTER TABLE call_results ADD COLUMN diagnostic TEXT');
    for (const [name, type] of [['registration', "TEXT NOT NULL DEFAULT 'manual'"], ['run_id', 'TEXT REFERENCES runs(id)']]) {
      if (!this.db.prepare('PRAGMA table_info(contexts)').all().some(c => c.name === name)) this.db.exec(`ALTER TABLE contexts ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);
      CREATE INDEX IF NOT EXISTS snapshots_run ON snapshots(run_id);
      CREATE INDEX IF NOT EXISTS contexts_project ON contexts(project_id);
      CREATE TRIGGER IF NOT EXISTS immutable_context_provenance BEFORE UPDATE OF registration,run_id ON contexts BEGIN SELECT RAISE(ABORT,'context provenance is immutable'); END;`);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS context_search USING fts5(
        context_id UNINDEXED, project_id UNINDEXED, title, content, topics,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS context_search_insert AFTER INSERT ON contexts
      WHEN NEW.status='active' BEGIN
        INSERT INTO context_search(context_id,project_id,title,content,topics)
        VALUES(NEW.id,NEW.project_id,NEW.title,NEW.content,NEW.topics);
      END;
      CREATE TRIGGER IF NOT EXISTS context_search_status AFTER UPDATE OF status ON contexts BEGIN
        DELETE FROM context_search WHERE context_id=OLD.id;
        INSERT INTO context_search(context_id,project_id,title,content,topics)
        SELECT NEW.id,NEW.project_id,NEW.title,NEW.content,NEW.topics WHERE NEW.status='active';
      END;
      INSERT INTO context_search(context_id,project_id,title,content,topics)
      SELECT c.id,c.project_id,c.title,c.content,c.topics FROM contexts c
      WHERE c.status='active' AND NOT EXISTS(
        SELECT 1 FROM context_search f WHERE f.context_id=c.id
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(encode({ provider: 'chatgpt', model: '', ollamaUrl: 'http://127.0.0.1:11434' }));
    if (!this.db.prepare('SELECT id FROM projects LIMIT 1').get()) this.createProject('First project', 'en');
    // A stopped process must not leave a run looking as if it is still being verified.
    for (const interrupted of this.db.prepare("SELECT id,validation FROM runs WHERE status='running' AND assistant_message_id IS NOT NULL").all()) {
      const validation = JSON.parse(interrupted.validation || '{}');
      const status = validation.answer_status || (validation.verdict === 'conflict' ? 'unresolved' : validation.verdict || 'uncertain');
      if (validation.context_registration?.status === 'running') validation.context_registration = { status: 'interrupted', error: '앱이 종료되어 자동 등록이 중단됐습니다. 저장된 답변과 전달 기록은 유지됩니다.' };
      validation.context_warning = [validation.context_warning, '컨텍스트 후보 정리가 중단되었습니다. 저장된 답변은 유지됩니다.'].filter(Boolean).join('\n');
      this.finishRun(interrupted.id, status, validation);
    }
    for (const interrupted of this.db.prepare("SELECT id,status,validation FROM runs WHERE assistant_message_id IS NOT NULL AND status!='running' AND validation IS NOT NULL").all()) {
      const validation = JSON.parse(interrupted.validation || '{}');
      if (validation.context_registration?.status !== 'running') continue;
      validation.context_registration = { status: 'interrupted', error: '앱이 종료되어 자동 등록이 중단됐습니다. 저장된 답변과 전달 기록은 유지됩니다.' };
      this.finishRun(interrupted.id, interrupted.status, validation);
    }
    this.db.prepare("UPDATE runs SET status='failed',error='앱이 종료되어 처리가 중단됐습니다. 새 요청으로 다시 시도하세요.' WHERE status='running'").run();
    this.db.prepare("UPDATE call_results SET status='failed',error='앱이 종료되어 호출 결과를 확인하지 못했습니다.' WHERE status='pending'").run();
  }
  transaction(fn) {
    const depth = this.transactionDepth || 0, name = `nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = depth + 1;
    try { const result = fn(); this.db.exec(depth ? `RELEASE SAVEPOINT ${name}` : 'COMMIT'); return result; }
    catch (error) { this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK'); if (depth) this.db.exec(`RELEASE SAVEPOINT ${name}`); throw error; }
    finally { this.transactionDepth = depth; }
  }
  compactAfterDeletion() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); }
  settings() { return { autoContext: true, ...JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value) }; }
  saveSettings(value) { this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(encode(value)); }
  createProject(name, locale = 'ko') {
    return this.transaction(() => {
      const project = { id: id('project'), name, created_at: now() };
      this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(project.id, name, project.created_at);
      this.createSession(project.id, locale);
      return project;
    });
  }
  projects() { return this.db.prepare('SELECT * FROM projects ORDER BY rowid').all(); }
  project(projectId) { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId); }
  createSession(projectId, locale = 'ko') {
    if (!this.project(projectId)) throw new Error('프로젝트를 찾을 수 없습니다.');
    const session = { id: id('session'), project_id: projectId, title: systemText('새 대화', locale), created_at: now() };
    this.db.prepare('INSERT INTO sessions(id,project_id,title,created_at,model_provider,model,reasoning_effort) VALUES(?,?,?,?,?,?,?)').run(session.id, projectId, session.title, session.created_at, '', '', 'high');
    return session;
  }
  session(sessionId) { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId); }
  sessions(projectId) { return this.db.prepare('SELECT * FROM sessions WHERE project_id=? ORDER BY rowid DESC').all(projectId); }
  setSessionModel(sessionId, provider, model) {
    if (!this.session(sessionId)) throw new Error('대화를 찾을 수 없습니다.');
    this.db.prepare('UPDATE sessions SET model_provider=?,model=? WHERE id=?').run(provider, model, sessionId);
    return this.session(sessionId);
  }
  setSessionReasoningEffort(sessionId, effort) {
    if (!this.session(sessionId)) throw new Error('대화를 찾을 수 없습니다.');
    if (!['auto', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('추론 수준을 확인하세요.');
    this.db.prepare('UPDATE sessions SET reasoning_effort=? WHERE id=?').run(effort, sessionId);
    return this.session(sessionId);
  }
  message(messageId) { return decode(this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId), ['topics']); }
  messages(sessionId) { return this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY rowid').all(sessionId).map(r => decode(r, ['topics'])); }
  addMessage(sessionId, role, content, topics) {
    const message = { id: id('msg'), session_id: sessionId, role, content, topics, created_at: now() };
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(message.id, sessionId, role, content, encode(topics), message.created_at);
    if (role === 'user') this.db.prepare("UPDATE sessions SET title=? WHERE id=? AND title IN ('새 대화','New conversation')").run(content.slice(0, 40), sessionId);
    return message;
  }
  decision(decisionId) { return decode(this.db.prepare('SELECT * FROM decisions WHERE id=?').get(decisionId), ['topics']); }
  context(contextId) { return decode(this.db.prepare('SELECT * FROM contexts WHERE id=?').get(contextId), ['topics']); }
  contexts(projectId) { return this.db.prepare("SELECT * FROM contexts WHERE project_id=? AND status!='superseded' ORDER BY rowid DESC").all(projectId).map(r => decode(r, ['topics'])); }
  searchContexts(sessionId, projectId, query, topics = [], { threshold = 0.5, limit = 8 } = {}) {
    const terms = contextSearchTerms(query), topicTerms = contextSearchTerms(topics.join(' '));
    const matchTerms = [...new Set([...terms, ...topicTerms])];
    const search = { engine: 'sqlite-fts5', threshold, limit, terms, topic_terms: topicTerms, candidates: [], scores: [] };
    if (!matchTerms.length) return search;
    const matchExpression = matchTerms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT c.id,c.root_id,c.project_id,c.title,c.content,c.kind,c.scope,c.topics,c.include_mode,c.source_id,c.version,
        bm25(context_search,0.0,0.0,3.0,1.0,1.5) AS rank
      FROM context_search JOIN contexts c ON c.id=context_search.context_id
      WHERE context_search MATCH ? AND context_search.project_id=? AND c.status='active' AND c.include_mode='auto'
        AND NOT EXISTS(SELECT 1 FROM context_overrides o WHERE o.session_id=? AND o.root_id=c.root_id)
      ORDER BY rank ASC LIMIT ?
    `).all(matchExpression, projectId, sessionId, Math.max(limit * 10, 40));
    const scored = rows.map((row, index) => {
      const item = decode(row, ['topics']);
      const documentTerms = searchDocumentTerms(`${item.title} ${item.content} ${item.topics.join(' ')}`);
      const matchedTerms = terms.filter(term => [...documentTerms].some(value => value === term || value.startsWith(term)));
      const topicSet = new Set(contextSearchTerms(item.topics.join(' ')));
      const matchedTopics = topicTerms.filter(term => [...topicSet].some(value => value === term || value.startsWith(term) || term.startsWith(value)));
      const keywordScore = terms.length ? matchedTerms.length / terms.length : 0;
      const topicScore = topicTerms.length ? matchedTopics.length / topicTerms.length : 0;
      const score = terms.length ? Math.min(1, keywordScore * 0.7 + topicScore * 0.3) : topicScore;
      return { ...item, score, keyword_score: keywordScore, topic_score: topicScore, matched_terms: matchedTerms, matched_topics: matchedTopics, rank: index + 1, bm25: row.rank };
    }).sort((a, b) => b.score - a.score || a.bm25 - b.bm25);
    search.scores = scored.slice(0, Math.max(limit * 10, 40)).map(({ id: context_id, score, keyword_score, topic_score, matched_terms, matched_topics, rank, bm25 }) => ({ context_id, score, keyword_score, topic_score, matched_terms, matched_topics, rank, bm25 }));
    search.candidates = scored.filter(item => item.score >= threshold).slice(0, limit);
    return search;
  }
  contextSourceIds(projectId) {
    return this.db.prepare(`SELECT DISTINCT source_id FROM contexts WHERE project_id=? AND source_id IS NOT NULL
      UNION SELECT s.source_id FROM context_suppressions s JOIN messages m ON m.id=s.source_id JOIN sessions x ON x.id=m.session_id WHERE x.project_id=?`).all(projectId, projectId).map(r => r.source_id);
  }
  suppressSource(sourceId) {
    if (sourceId && this.message(sourceId)) this.db.prepare('INSERT OR IGNORE INTO context_suppressions(source_id,created_at) VALUES(?,?)').run(sourceId, now());
  }
  isSourceSuppressed(sourceId) { return Boolean(sourceId && this.db.prepare('SELECT 1 FROM context_suppressions WHERE source_id=?').get(sourceId)); }
  contextVersions(contextId) {
    const item = this.context(contextId);
    if (!item) throw new Error('컨텍스트를 찾을 수 없습니다.');
    return this.db.prepare('SELECT * FROM contexts WHERE root_id=? ORDER BY version DESC').all(item.root_id).map(r => decode(r, ['topics']));
  }
  saveContext(projectId, data, previousId = null) {
    return this.transaction(() => {
      if (!this.project(projectId)) throw new Error('프로젝트를 찾을 수 없습니다.');
      const old = previousId ? this.context(previousId) : null;
      if (previousId && (!old || old.project_id !== projectId || old.status === 'superseded')) throw new Error('현재 버전의 컨텍스트만 수정할 수 있습니다. 새로고침 후 다시 시도하세요.');
      if (!['background', 'reference', 'hypothesis'].includes(data.kind)) throw new Error('배경·참고 자료·가설 중 종류를 선택하세요.');
      if (!['project', 'topic'].includes(data.scope) || (data.scope === 'topic' && !data.topics.length)) throw new Error('주제 범위에는 주제를 지정하세요.');
      if (!['auto', 'always', 'off'].includes(data.include_mode)) throw new Error('올바른 포함 방식을 선택하세요.');
      const sourceId = data.source_id ?? old?.source_id ?? null;
      if (sourceId) {
        const message = this.message(sourceId);
        if (!message || this.session(message.session_id)?.project_id !== projectId) throw new Error('같은 프로젝트의 원문만 연결할 수 있습니다.');
      }
      const contextId = id('material');
      const item = { id: contextId, root_id: old?.root_id || contextId, project_id: projectId, title: data.title, content: data.content, kind: data.kind, scope: data.scope, topics: data.topics, include_mode: data.include_mode, source_id: sourceId, version: old ? old.version + 1 : 1, supersedes: old?.id || null, status: 'active', created_at: now(), registration: data.registration || old?.registration || 'manual', run_id: data.run_id || old?.run_id || null };
      if (old) this.db.prepare("UPDATE contexts SET status='superseded' WHERE id=?").run(old.id);
      this.db.prepare('INSERT INTO contexts(id,root_id,project_id,title,content,kind,scope,topics,include_mode,source_id,version,supersedes,status,created_at,registration,run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id, item.root_id, projectId, item.title, item.content, item.kind, item.scope, encode(item.topics), item.include_mode, sourceId, item.version, item.supersedes, item.status, item.created_at, item.registration, item.run_id);
      return item;
    });
  }
  archiveContext(contextId, archived = true) {
    const item = this.context(contextId);
    if (!item || item.status === 'superseded') throw new Error('현재 컨텍스트를 찾을 수 없습니다.');
    this.db.prepare('UPDATE contexts SET status=? WHERE id=?').run(archived ? 'archived' : 'active', contextId);
    return this.context(contextId);
  }
  deleteContext(contextId) {
    this.db.exec('PRAGMA secure_delete=ON;');
    const result = this.transaction(() => {
      const item = this.context(contextId);
      if (!item) throw new Error('컨텍스트를 찾을 수 없습니다.');
      const versions = this.db.prepare('SELECT id,source_id FROM contexts WHERE root_id=? ORDER BY version DESC').all(item.root_id);
      const ids = versions.map(version => version.id);
      const sourceIds = [...new Set(versions.map(version => version.source_id).filter(Boolean))];
      for (const sourceId of sourceIds) this.suppressSource(sourceId);
      for (const versionId of ids) this.db.prepare('DELETE FROM context_search WHERE context_id=?').run(versionId);
      this.db.prepare('DELETE FROM context_overrides WHERE root_id=?').run(item.root_id);
      for (const sourceId of sourceIds) this.db.prepare('DELETE FROM context_candidates WHERE source_id=?').run(sourceId);
      for (const versionId of ids) this.db.prepare('DELETE FROM context_candidates WHERE target_id=?').run(versionId);
      for (const version of versions) this.db.prepare('DELETE FROM contexts WHERE id=?').run(version.id);
      return { deleted: true, root_id: item.root_id, context_ids: ids, source_ids: sourceIds };
    });
    this.compactAfterDeletion();
    return result;
  }
  overrides(sessionId) { return this.db.prepare('SELECT root_id,mode FROM context_overrides WHERE session_id=?').all(sessionId); }
  setOverride(sessionId, contextId, mode) {
    const session = this.session(sessionId), item = this.context(contextId);
    if (!session || !item || session.project_id !== item.project_id || item.status !== 'active') throw new Error('같은 프로젝트의 사용 중인 컨텍스트만 선택할 수 있습니다.');
    if (!['auto', 'include', 'exclude'].includes(mode)) throw new Error('올바른 대화별 선택 방식을 지정하세요.');
    if (mode === 'auto') this.db.prepare('DELETE FROM context_overrides WHERE session_id=? AND root_id=?').run(sessionId, item.root_id);
    else this.db.prepare('INSERT INTO context_overrides VALUES(?,?,?) ON CONFLICT(session_id,root_id) DO UPDATE SET mode=excluded.mode').run(sessionId, item.root_id, mode);
  }
  decisions(projectId) { return this.db.prepare('SELECT * FROM decisions WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(r => decode(r, ['topics'])); }
  archiveDecision(decisionId, archived = true) {
    const item = this.decision(decisionId);
    if (!item || item.status === 'superseded') throw new Error('현재 결정만 보관하거나 복원할 수 있습니다.');
    if (archived) this.db.prepare("UPDATE decisions SET status='archived' WHERE id=?").run(decisionId);
    else {
      const newer = this.db.prepare("SELECT id FROM decisions WHERE supersedes=? AND status='active' LIMIT 1").get(decisionId);
      if (newer) throw new Error('이 결정을 대체한 최신 결정이 있어 복원할 수 없습니다.');
      this.db.prepare("UPDATE decisions SET status='active' WHERE id=? AND status='archived'").run(decisionId);
    }
    return this.decision(decisionId);
  }
  decisionChain(decisionId) {
    const selected = this.decision(decisionId);
    if (!selected) return [];
    const all = this.db.prepare('SELECT id,source_id,supersedes,version FROM decisions WHERE project_id=?').all(selected.project_id);
    const related = new Set([decisionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of all) {
        if (related.has(item.id) || (item.supersedes && related.has(item.supersedes))) {
          if (!related.has(item.id)) { related.add(item.id); changed = true; }
          if (item.supersedes && !related.has(item.supersedes)) { related.add(item.supersedes); changed = true; }
        }
      }
    }
    return all.filter(item => related.has(item.id)).sort((a, b) => b.version - a.version);
  }
  deleteDecision(decisionId) {
    this.db.exec('PRAGMA secure_delete=ON;');
    const result = this.transaction(() => {
      const selected = this.decision(decisionId);
      if (!selected) throw new Error('결정을 찾을 수 없습니다.');
      const chain = this.decisionChain(decisionId);
      const ids = chain.map(item => item.id);
      const sourceIds = [...new Set(chain.map(item => item.source_id).filter(Boolean))];
      for (const sourceId of sourceIds) this.suppressSource(sourceId);
      for (const item of chain) this.db.prepare('DELETE FROM context_candidates WHERE source_id=?').run(item.source_id);
      for (const id of ids) {
        this.db.prepare('DELETE FROM context_candidates WHERE supersedes=? OR target_id=?').run(id, id);
        this.db.prepare('DELETE FROM decisions WHERE id=?').run(id);
      }
      return { deleted: true, decision_ids: ids, source_ids: sourceIds };
    });
    this.compactAfterDeletion();
    return result;
  }
  register(sessionId, content, topics, { scope = 'project', supersedes = null, locale = 'ko' } = {}) {
    return this.transaction(() => {
      const session = this.session(sessionId);
      if (!session) throw new Error('대화를 찾을 수 없습니다.');
      const old = supersedes ? this.decision(supersedes) : null;
      if (supersedes && (!old || old.project_id !== session.project_id || old.status !== 'active')) throw new Error('같은 프로젝트의 유효한 결정만 대체할 수 있습니다.');
      if (!['project', 'topic'].includes(scope) || (scope === 'topic' && !topics.length)) throw new Error('주제 범위 결정에는 주제를 지정하세요.');
      const message = this.addMessage(sessionId, 'user', content, topics);
      const decision = { id: id('dec'), project_id: session.project_id, source_id: message.id, content, scope, topics, version: old ? old.version + 1 : 1, supersedes, status: 'active', created_at: now() };
      if (old) this.db.prepare("UPDATE decisions SET status='superseded' WHERE id=?").run(old.id);
      this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?)').run(decision.id, decision.project_id, message.id, content, scope, encode(topics), decision.version, supersedes, 'active', decision.created_at);
      this.addMessage(sessionId, 'system', locale === 'en' ? `Saved decision v${decision.version}.${old ? ' The previous decision is preserved as superseded.' : ''}` : `결정 v${decision.version}을 저장했습니다.${old ? ' 이전 결정은 대체됨 상태로 보관됩니다.' : ''}`, topics);
      return { message, decision };
    });
  }
  candidates(projectId) { return this.db.prepare('SELECT * FROM context_candidates WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(r => decode(r, ['topics'])); }
  candidate(candidateId) { return decode(this.db.prepare('SELECT * FROM context_candidates WHERE id=?').get(candidateId), ['topics']); }
  saveCandidates(runId, items) {
    const run = this.run(runId), session = this.session(run.session_id);
    return this.transaction(() => items.map(item => {
      if (this.isSourceSuppressed(item.source_id)) return null;
      const source = this.message(item.source_id);
      if (!source || !['user', 'assistant'].includes(source.role) || (source.role === 'assistant' && (item.kind !== 'hypothesis' || item.scope !== 'topic' || item.supersedes)) || source.session_id !== session.id || !source.content.includes(item.content)) throw new Error('후보의 원문 근거를 확인할 수 없습니다.');
      const candidateId = id('candidate');
      this.db.prepare('INSERT OR IGNORE INTO context_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(candidateId, session.project_id, session.id, runId, item.source_id, item.title, item.content, item.kind, item.scope, encode(item.topics), item.supersedes || null, 'pending', null, now());
      return this.candidate(candidateId);
    }).filter(Boolean));
  }
  reviewCandidate(candidateId, action, locale = 'ko', automatic = false) {
    return this.transaction(() => {
    const item = this.candidate(candidateId);
    if (!item || item.status !== 'pending') throw new Error('검토 대기 중인 후보만 처리할 수 있습니다.');
    if (!['accept', 'dismiss'].includes(action)) throw new Error('저장 또는 무시를 선택하세요.');
    let target = null;
    if (action === 'accept') {
      if (item.kind === 'decision') target = this.confirmSource(item, locale, automatic);
      else target = this.saveContext(item.project_id, { ...item, include_mode: 'auto', registration: automatic ? 'automatic' : 'manual' });
    }
    this.db.prepare('UPDATE context_candidates SET status=?,target_id=? WHERE id=?').run(action === 'accept' ? 'accepted' : 'dismissed', target?.id || null, candidateId);
    return { candidate: this.candidate(candidateId), target };
    });
  }
  confirmSource(item, locale = 'ko', automatic = false) {
    return this.transaction(() => {
      const source = this.message(item.source_id), session = source && this.session(source.session_id);
      const old = item.supersedes ? this.decision(item.supersedes) : null;
      if (!source || source.role !== 'user' || session.project_id !== item.project_id || !source.content.includes(item.content)) throw new Error('사용자 원문 근거를 확인할 수 없습니다.');
      if (item.supersedes && (!old || old.project_id !== item.project_id || old.status !== 'active')) throw new Error('대체할 결정이 변경됐습니다. 후보를 무시하고 다시 추출하세요.');
      if (!['project', 'topic'].includes(item.scope) || (item.scope === 'topic' && !item.topics.length)) throw new Error('결정의 적용 범위를 확인하세요.');
      const decision = { id: id('dec'), project_id: item.project_id, source_id: source.id, content: item.content, scope: item.scope, topics: item.topics, version: old ? old.version + 1 : 1, supersedes: item.supersedes, status: 'active', created_at: now() };
      if (old) this.db.prepare("UPDATE decisions SET status='superseded' WHERE id=?").run(old.id);
      this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?)').run(decision.id, decision.project_id, decision.source_id, decision.content, decision.scope, encode(decision.topics), decision.version, decision.supersedes, decision.status, decision.created_at);
      this.addMessage(source.session_id, 'system', automatic ? (locale === 'en' ? `Automatically registered decision v${decision.version} from the original user message.` : `사용자 원문에서 결정 v${decision.version}을 자동 등록했습니다.`) : locale === 'en' ? `Confirmed and saved decision v${decision.version} from the original message.` : `원문에서 추출한 결정 v${decision.version}을 확인하여 저장했습니다.`, decision.topics);
      return decision;
    });
  }
  createRun(sessionId, userId, settings, purpose = 'chat') {
    const runId = id('run');
    this.db.prepare('INSERT INTO runs(id,session_id,user_message_id,provider,model,status,created_at,purpose) VALUES(?,?,?,?,?,?,?,?)').run(runId, sessionId, userId, settings.provider, settings.model, 'running', now(), purpose);
    return runId;
  }
  finishRun(runId, status, validation = null, error = null, assistantId = null) {
    this.db.prepare('UPDATE runs SET status=?,validation=?,error=?,assistant_message_id=COALESCE(?,assistant_message_id) WHERE id=?').run(status, validation ? encode(validation) : null, error, assistantId, runId);
  }
  snapshot(runId, phase, request, blocks, excluded) {
    const payload = encode(request.payload);
    const snapshot = { id: id('ctx'), run_id: runId, phase, ordinal: this.db.prepare('SELECT COUNT(*) count FROM snapshots WHERE run_id=?').get(runId).count, provider: request.provider, model: request.model, endpoint: request.endpoint, payload, blocks: encode(blocks), excluded: encode(excluded), hash: createHash('sha256').update(payload).digest('hex'), created_at: now() };
    this.transaction(() => {
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(snapshot));
      this.db.prepare('INSERT INTO call_results(snapshot_id,status) VALUES(?,?)').run(snapshot.id, 'pending');
    });
    return snapshot;
  }
  result(snapshotId, result) {
    this.db.prepare('UPDATE call_results SET status=?,output=?,usage=?,latency_ms=?,error=?,diagnostic=? WHERE snapshot_id=?').run(result.error ? 'failed' : 'completed', result.text ?? null, result.usage ? encode(result.usage) : null, result.latency ?? null, result.error ?? null, result.diagnostic ? encode(result.diagnostic) : null, snapshotId);
  }
  inferredTopics(sessionId) {
    const result = new Map();
    const rows = this.db.prepare("SELECT r.user_message_id,r.assistant_message_id,s.blocks FROM snapshots s JOIN runs r ON r.id=s.run_id WHERE r.session_id=? AND s.phase='generation' ORDER BY s.rowid").all(sessionId);
    for (const row of rows) {
      const block = JSON.parse(row.blocks).find(b => b.key === 'PROJECT_SCOPE');
      const topics = block ? JSON.parse(block.content).topics || [] : [];
      result.set(row.user_message_id, topics);
      if (row.assistant_message_id) result.set(row.assistant_message_id, topics);
    }
    return result;
  }
  runs(sessionId) { return this.db.prepare('SELECT * FROM runs WHERE session_id=? ORDER BY rowid DESC').all(sessionId).map(r => decode(r, ['validation'].filter(() => r.validation))); }
  run(runId) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    if (!run) return null;
    return { ...decode(run, run.validation ? ['validation'] : []), snapshots: this.db.prepare('SELECT s.*,c.status call_status,c.output,c.usage,c.latency_ms,c.error call_error,c.diagnostic FROM snapshots s JOIN call_results c ON c.snapshot_id=s.id WHERE run_id=? ORDER BY ordinal').all(runId).map(r => decode(r, ['blocks', 'excluded', ...(r.usage ? ['usage'] : []), ...(r.diagnostic ? ['diagnostic'] : [])])) };
  }
  export() {
    const tables = ['projects', 'sessions', 'messages', 'decisions', 'contexts', 'context_suppressions', 'context_overrides', 'context_candidates', 'runs', 'snapshots', 'call_results'];
    return { format: 'contextpulse-v1', exported_at: now(), tables: Object.fromEntries(tables.map(t => [t, this.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])) };
  }
  deleteSession(sessionId, locale = 'en') {
    this.db.exec('PRAGMA secure_delete=ON;');
    const result = this.transaction(() => {
      const session = this.session(sessionId);
      if (!session) throw new Error('대화를 찾을 수 없습니다.');
      const projectId = session.project_id;
      const messageIds = this.db.prepare('SELECT id FROM messages WHERE session_id=?').all(sessionId).map(row => row.id);
      const runIds = this.db.prepare('SELECT id FROM runs WHERE session_id=?').all(sessionId).map(row => row.id);
      const messageSet = new Set(messageIds);
      const runSet = new Set(runIds);
      const contextRows = this.db.prepare('SELECT id,root_id,source_id,version,run_id FROM contexts WHERE project_id=?').all(projectId);
      const contextRoots = new Set(contextRows.filter(row => messageSet.has(row.source_id) || runSet.has(row.run_id)).map(row => row.root_id));
      const contextVersions = contextRows.filter(row => contextRoots.has(row.root_id)).sort((a, b) => b.version - a.version);
      const contextIds = contextVersions.map(row => row.id);
      const decisionRows = this.db.prepare('SELECT id,source_id FROM decisions WHERE project_id=?').all(projectId);
      const decisionsToDelete = new Set(decisionRows.filter(row => messageSet.has(row.source_id)).map(row => row.id));
      for (const id of [...decisionsToDelete]) for (const item of this.decisionChain(id)) decisionsToDelete.add(item.id);
      const decisionChain = this.db.prepare('SELECT id,source_id,version FROM decisions WHERE project_id=?').all(projectId).filter(row => decisionsToDelete.has(row.id)).sort((a, b) => b.version - a.version);
      const sourceIdsToSuppress = new Set([
        ...contextVersions.map(row => row.source_id),
        ...decisionChain.map(row => row.source_id)
      ].filter(sourceId => sourceId && !messageSet.has(sourceId)));
      for (const sourceId of sourceIdsToSuppress) this.suppressSource(sourceId);

      for (const id of contextIds) this.db.prepare('DELETE FROM context_search WHERE context_id=?').run(id);
      for (const rootId of contextRoots) this.db.prepare('DELETE FROM context_overrides WHERE root_id=?').run(rootId);
      this.db.prepare('DELETE FROM context_overrides WHERE session_id=?').run(sessionId);
      for (const candidate of this.db.prepare('SELECT id,source_id,supersedes,target_id FROM context_candidates').all()) {
        if (candidate.source_id && messageSet.has(candidate.source_id) || candidate.supersedes && decisionsToDelete.has(candidate.supersedes) || candidate.target_id && (contextRoots.has(candidate.target_id) || contextIds.includes(candidate.target_id) || decisionsToDelete.has(candidate.target_id))) {
          this.db.prepare('DELETE FROM context_candidates WHERE id=?').run(candidate.id);
        }
      }
      for (const row of contextVersions) this.db.prepare('DELETE FROM contexts WHERE id=?').run(row.id);
      for (const row of decisionChain) this.db.prepare('DELETE FROM context_candidates WHERE source_id=? OR supersedes=? OR target_id=?').run(row.source_id, row.id, row.id);
      for (const row of decisionChain) this.db.prepare('DELETE FROM decisions WHERE id=?').run(row.id);

      this.db.exec('DROP TRIGGER IF EXISTS immutable_snapshot_delete');
      for (const runId of runIds) {
        this.db.prepare('DELETE FROM call_results WHERE snapshot_id IN (SELECT id FROM snapshots WHERE run_id=?)').run(runId);
        this.db.prepare('DELETE FROM snapshots WHERE run_id=?').run(runId);
      }
      this.db.exec("CREATE TRIGGER immutable_snapshot_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshot is immutable'); END;");
      for (const runId of runIds) this.db.prepare('DELETE FROM context_candidates WHERE run_id=?').run(runId);
      for (const runId of runIds) this.db.prepare('DELETE FROM runs WHERE id=?').run(runId);
      for (const messageId of messageIds) this.db.prepare('DELETE FROM context_suppressions WHERE source_id=?').run(messageId);
      for (const messageId of messageIds) this.db.prepare('DELETE FROM messages WHERE id=?').run(messageId);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
      let replacementSession = this.sessions(projectId)[0] || null;
      if (!replacementSession) replacementSession = this.createSession(projectId, locale);
      return { deleted: true, session_id: sessionId, project_id: projectId, replacement_session: replacementSession };
    });
    this.compactAfterDeletion();
    return result;
  }
  clearAllData(locale = 'en') {
    this.db.exec('PRAGMA secure_delete=ON;');
    const project = this.transaction(() => {
      this.db.exec('DROP TRIGGER IF EXISTS immutable_snapshot_delete; DELETE FROM context_search;');
      this.db.exec(`
        DELETE FROM call_results;
        DELETE FROM snapshots;
        DELETE FROM context_candidates;
        DELETE FROM context_suppressions;
        DELETE FROM context_overrides;
        DELETE FROM contexts;
        DELETE FROM decisions;
        DELETE FROM runs;
        DELETE FROM messages;
        DELETE FROM sessions;
        DELETE FROM projects;
      `);
      this.db.exec("CREATE TRIGGER immutable_snapshot_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshot is immutable'); END;");
      return this.createProject('First project', locale);
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    return project;
  }
  close() { this.db.close(); }
}
