import { WorkspaceManager } from './workspaces.js';
import { serverConfig } from './config.js';
import { backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { currentBuildId } from './build-id.js';
import { contextUsage } from './context-usage.js';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store, id } from './store.js';
import { Auth } from './auth.js';
import { Provider } from './provider.js';
import { executeRun, compareSnapshots, selectMaterials } from './pipeline.js';
import { systemText, systemMessage, interfaceLocale } from './localization.js';
import { analyzeConversation } from './context-ai.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildId = currentBuildId();
const LIMIT = 1_000_000;
const requiredText = (value, maximum = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`1~${maximum}자 이내의 내용을 입력하세요.`);
  return value;
};
const normalizeTopics = (value) => {
  if (!Array.isArray(value) || value.length > 12 || value.some(t => typeof t !== 'string' || !t.trim() || t.length > 50)) throw new Error('주제는 50자 이내, 최대 12개로 입력하세요.');
  return [...new Set(value.map(t => t.trim().replace(/^#/, '')))];
};
const localUrl = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('로컬 모델 주소는 http://127.0.0.1:11434 같은 루프백 주소를 사용하세요.');
  return url.origin;
};
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > LIMIT) { req.resume(); throw Object.assign(new Error('Request is too large.'), { status: 413 }); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('올바른 JSON 요청이 아닙니다.'); }
}

export function createApp({ port = 8899, directory = join(root, 'data'), fetcher = fetch, mode = 'local', publicOrigin = `http://127.0.0.1:${port}`, workspaceOptions } = {}) {
  const config = serverConfig({ CONTEXTPULSE_MODE: mode, CONTEXTPULSE_PORT: String(port), PUBLIC_ORIGIN: publicOrigin, CONTEXTPULSE_DATA_DIR: directory }, root);
  const origin = mode === 'hosted' ? config.publicOrigin : `http://127.0.0.1:${port}`;
  const hosted = mode === 'hosted';
  const manager = hosted ? new WorkspaceManager(directory, origin, fetcher, workspaceOptions) : null;
  const localStore = hosted ? null : new Store(directory);
  const localAuth = hosted ? null : new Auth(directory, origin, fetcher);
  const local = hosted ? null : { store: localStore, auth: localAuth, provider: new Provider(localAuth, fetcher), csrf: randomBytes(32).toString('hex'), busy: new Set(), inflight: 0 };
  const browserSessions = new Set();
  const cookieName = hosted ? 'contextpulse_visitor' : `contextpulse_session_${port}`;
  let draining = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let locale = 'en', runtime;
    const json = (data, status = 200) => {
      if (data.error) data = { ...data, error: systemText(data.error, locale) }; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (!(hosted ? [new URL(origin).host] : [`127.0.0.1:${port}`, `localhost:${port}`]).includes(req.headers.host)) return json({ error: '허용되지 않은 호스트입니다.' }, 403);
      if (req.headers.origin && !(hosted ? [origin] : [origin, `http://localhost:${port}`]).includes(req.headers.origin)) return json({ error: '외부 웹사이트의 요청은 허용하지 않습니다.' }, 403);
      const url = new URL(req.url, origin), path = url.pathname;
      locale = /^\/ko(?:\/|$)/.test(path) ? 'ko' : interfaceLocale(req.headers['x-contextpulse-locale']);
      // Keep the app and its loopback callback on one cookie host.
      if (!hosted && req.headers.host === `localhost:${port}` && req.method === 'GET') { res.writeHead(308, { Location: `${origin}${url.pathname}${url.search}` }); return res.end(); }
      if (path === '/healthz' && req.method === 'GET') return json({ status: draining ? 'draining' : 'ok', build_id: buildId }, draining ? 503 : 200);
      if (draining) return json({ error: 'Server is restarting. Please try again shortly.' }, 503);
      let browserSession = req.headers.cookie?.split(';').map(part => part.trim().split('=')).find(([name]) => name === cookieName)?.[1];
      if (hosted && (path.startsWith('/api/') || path.startsWith('/auth/'))) {
        const visitor = manager.resolve(browserSession);
        runtime = visitor.runtime; browserSession = visitor.id;
        if (visitor.issued) res.setHeader('Set-Cookie', `${cookieName}=${visitor.issued}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${origin.startsWith('https:') ? '; Secure' : ''}`);
      } else if (!hosted) {
        runtime = local;
        if (!browserSessions.has(browserSession)) {
          browserSession = randomBytes(24).toString('hex'); browserSessions.add(browserSession);
          res.setHeader('Set-Cookie', `${cookieName}=${browserSession}; HttpOnly; SameSite=Lax; Path=/`);
        }
      }
      // Static assets never create visitor databases.
      const { store, auth, provider, csrf, busy } = runtime || {};
      if (runtime) { runtime.inflight++; res.once('close', () => { runtime.inflight--; }); }
      const requireIdle = (projectId) => {
        if (busy.has(projectId)) throw Object.assign(new Error('이 프로젝트에서 답변을 처리 중입니다. 완료 후 다시 시도하세요.'), { status: 409 });
        if (hosted && (busy.size >= 2 || manager.busyCount() >= 8)) throw Object.assign(new Error('Demo is busy. Please try again shortly.'), { status: 429 });
        if (hosted && (store.db.prepare('SELECT COUNT(*) n FROM messages').get().n >= 20000 || statSync(store.path).size > 128 * 1024 * 1024)) throw Object.assign(new Error('Visitor storage limit reached.'), { status: 429 });
      };
      const allowedProviders = hosted ? ['openai', 'demo'] : ['chatgpt', 'openai', 'ollama', 'demo'];
      const checkProvider = (name) => { if (!allowedProviders.includes(name)) throw Object.assign(new Error('This connection is available only in the local app. The web demo supports demo mode or your own API key.'), { status: 400 }); };
      const connectedSettings = (locale = 'en', session = null, requireModel = true) => {
        const settings = { ...store.settings(), locale }; checkProvider(settings.provider);
        if (session?.model && session.model_provider === settings.provider) settings.model = session.model;
        if (requireModel && !settings.model) throw new Error('채팅 입력창에서 모델을 선택하세요.');
        if (settings.provider === 'chatgpt' && !auth.publicStatus().signedIn) throw new Error('설정에서 Continue with ChatGPT로 연결하세요.');
        if (settings.provider === 'chatgpt' && !auth.planEnabled()) throw new Error('ChatGPT 플랜 사용 권한을 승인하세요.');
        if (settings.provider === 'chatgpt') settings.accountClientId = auth.account().client_id;
        if (settings.provider === 'openai' && !auth.value.apiKey) throw new Error('설정에서 API 키를 등록하세요.');
        return settings;
      };
      const publicState = () => ({ build_id: buildId, mode, capabilities: { providers: allowedProviders, oauth: !hosted }, projects: store.projects(), settings: store.settings(), auth: auth.publicStatus(), busy: [...busy], csrf, storage_bytes: statSync(store.path).size + (existsSync(`${store.path}-wal`) ? statSync(`${store.path}-wal`).size : 0) });
      if (path === '/api/state' && req.method === 'GET') return json(publicState());
      if (path.startsWith('/api/') && req.headers['x-contextpulse-token'] !== csrf) return json({ error: '앱을 새로고침한 뒤 다시 시도하세요.', code: 'CSRF_RELOAD' }, 403);
      if (hosted && ((path.startsWith('/api/auth/') && path !== '/api/auth/status') || path === '/auth/callback')) return json({ error: 'ChatGPT OAuth is available in the local app. Use demo mode or your own API key on the web.' }, 400);
      if (path === '/auth/callback' && req.method === 'GET') {
        let message, destination = 'settings'; const callbackLocale = auth.pending.get(url.searchParams.get('state'))?.locale || 'en';
        const previousAccount = auth.account()?.client_id;
        try { const result = await auth.callback(url.searchParams, browserSession); message = result.message; const settings = store.settings(); const accountId = auth.account()?.client_id; const model = settings.chatgptModels?.[accountId] || (settings.provider === 'chatgpt' && accountId === previousAccount ? settings.model : ''); store.saveSettings({ ...settings, provider: 'chatgpt', model }); if (result.status === 'connected') destination = ''; }
        catch (error) { message = error.message; }
        res.writeHead(303, { Location: `${callbackLocale === 'ko' ? '/ko' : ''}/${destination}?auth=${encodeURIComponent(systemText(message, callbackLocale))}` }); return res.end();
      }
      if (path === '/api/projects' && req.method === 'POST') { if (hosted && store.projects().length >= 200) return json({ error: 'Visitor project limit reached.' }, 429); return json(store.createProject(requiredText((await body(req)).name, 100), locale), 201); }
      const messageRoute = path.match(/^\/api\/messages\/([^/]+)$/);
      if (messageRoute && req.method === 'GET') {
        const message = store.message(messageRoute[1]);
        return message ? json(message) : json({ error: '원문을 찾을 수 없습니다.' }, 404);
      }
      const projectRoute = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute && req.method === 'GET') {
        const project = store.project(projectRoute[1]);
        if (!project) return json({ error: '프로젝트를 찾을 수 없습니다.' }, 404);
        return json({ project, sessions: store.sessions(project.id), decisions: store.decisions(project.id), contexts: store.contexts(project.id), candidates: store.candidates(project.id) });
      }
      if (path === '/api/sessions' && req.method === 'POST') {
        const data = await body(req); requireIdle(data.project_id); return json(store.createSession(data.project_id, locale), 201);
      }
      const sessionRoute = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionRoute && req.method === 'GET') {
        const session = store.session(sessionRoute[1]);
        if (!session) return json({ error: '대화를 찾을 수 없습니다.' }, 404);
        return json({ session, messages: store.messages(session.id).map(m => m.role === 'system' ? { ...m, content: systemMessage(m.content, locale) } : m), runs: store.runs(session.id).map(run => ({ ...run, context_usage: contextUsage(store.run(run.id), locale), ui_warning: systemText(run.validation?.context_warning, locale), ui_error: systemText(run.error, locale), progress: run.status === 'running' ? (() => { const last = store.run(run.id).snapshots.at(-1); return last ? { phase: last.phase, completed: last.call_status === 'completed' } : null; })() : null })) });
      }
      const sessionModelRoute = path.match(/^\/api\/sessions\/([^/]+)\/model$/);
      if (sessionModelRoute && req.method === 'POST') {
        const session = store.session(sessionModelRoute[1]);
        if (!session) return json({ error: '대화를 찾을 수 없습니다.' }, 404);
        requireIdle(session.project_id);
        const data = await body(req), model = requiredText(data.model, 200);
        const settings = connectedSettings(locale, session, false);
        store.setSessionModel(session.id, settings.provider, model);
        return json({ session: store.session(session.id) });
      }
      const contextCollection = path.match(/^\/api\/projects\/([^/]+)\/contexts$/);
      const contextRoute = path.match(/^\/api\/contexts\/([^/]+)$/);
      if ((contextCollection || contextRoute) && req.method === 'POST') {
        const old = contextRoute ? store.context(contextRoute[1]) : null;
        if (contextRoute && !old) throw new Error('컨텍스트를 찾을 수 없습니다.');
        const projectId = old?.project_id || contextCollection[1];
        const data = await body(req);
        requireIdle(projectId);
        return json(store.saveContext(projectId, { title: requiredText(data.title, 120), content: requiredText(data.content, 30000), kind: data.kind || 'background', scope: data.scope || 'project', topics: normalizeTopics(data.topics || []), include_mode: data.include_mode || 'auto', ...(data.source_id ? { source_id: data.source_id } : {}) }, old?.id || null), 201);
      }
      if (contextRoute && req.method === 'GET') {
        const item = store.context(contextRoute[1]);
        return item ? json({ context: item, versions: store.contextVersions(item.id) }) : json({ error: '컨텍스트를 찾을 수 없습니다.' }, 404);
      }
      const archiveRoute = path.match(/^\/api\/contexts\/([^/]+)\/archive$/);
      if (archiveRoute && req.method === 'POST') {
        const item = store.context(archiveRoute[1]);
        if (!item) throw new Error('컨텍스트를 찾을 수 없습니다.');
        const data = await body(req);
        requireIdle(item.project_id);
        if (typeof data.archived !== 'boolean') throw new Error('보관 여부를 지정하세요.');
        return json(store.archiveContext(item.id, data.archived));
      }
      const previewRoute = path.match(/^\/api\/sessions\/([^/]+)\/context-preview$/);
      if (previewRoute && req.method === 'POST') {
        const topics = normalizeTopics((await body(req)).topics || []);
        const materials = selectMaterials(store, previewRoute[1], topics, null, locale);
        const session = store.session(previewRoute[1]);
        const decisions = store.decisions(session.project_id).filter(d => d.status === 'active' && (d.scope === 'project' || d.topics.some(t => topics.includes(t))));
        const latest = store.runs(session.id).find(r => r.purpose === 'chat' && r.status !== 'running' && r.status !== 'failed');
        const generation = latest && store.run(latest.id).snapshots.find(s => s.phase === 'generation');
        const selection = generation?.blocks.find(b => b.key === 'CONTEXT_SELECTION');
        const last_selection = generation ? { run_id: latest.id, question: store.message(latest.user_message_id).content, mode: selection ? JSON.parse(selection.content).mode : 'tags', items: generation.blocks.filter(b => b.context_id).map(b => ({ ...JSON.parse(b.content), id: b.context_id })) } : null;
        return json({ ...materials, decisions, last_selection });
      }
      const overrideRoute = path.match(/^\/api\/sessions\/([^/]+)\/context-selection$/);
      if (overrideRoute && req.method === 'POST') {
        const session = store.session(overrideRoute[1]);
        if (!session) throw new Error('대화를 찾을 수 없습니다.');
        const data = await body(req);
        requireIdle(session.project_id);
        store.setOverride(session.id, data.context_id, data.mode);
        return json({ overrides: store.overrides(session.id) });
      }
      const sendRoute = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      const analyzeRoute = path.match(/^\/api\/sessions\/([^/]+)\/analyze-context$/);
      if (analyzeRoute && req.method === 'POST') {
        const session = store.session(analyzeRoute[1]);
        if (!session) throw new Error('대화를 찾을 수 없습니다.');
        requireIdle(session.project_id);
        const settings = connectedSettings(locale, session);
        if (settings.provider === 'demo') throw new Error('시연 모드에는 자동 추출이 없습니다. 설정에서 실제 모델을 연결하세요.');
        if (!store.messages(session.id).some(m => m.role === 'user')) throw new Error('먼저 대화에 사용자 메시지를 남겨주세요.');
        busy.add(session.project_id);
        const task = analyzeConversation(store, provider, session.id, { ...settings });
        const run = store.runs(session.id)[0];
        task.finally(() => busy.delete(session.project_id)).catch(() => {});
        return json({ run_id: run.id }, 202);
      }
      const candidateRoute = path.match(/^\/api\/context-candidates\/([^/]+)\/review$/);
      if (candidateRoute && req.method === 'POST') {
        const item = store.candidate(candidateRoute[1]);
        if (!item) throw new Error('컨텍스트 후보를 찾을 수 없습니다.');
        const data = await body(req);
        requireIdle(item.project_id);
        return json(store.reviewCandidate(item.id, data.action, locale));
      }
      if (sendRoute && req.method === 'POST') {
        const session = store.session(sendRoute[1]);
        if (!session) return json({ error: '대화를 찾을 수 없습니다.' }, 404);
        const data = await body(req), content = requiredText(data.content), topics = normalizeTopics(data.topics || []);
        requireIdle(session.project_id);
        if (data.decision) return json(store.register(session.id, content, topics, { scope: data.decision.scope, supersedes: data.decision.supersedes || null, locale }), 201);
        const settings = connectedSettings(locale, session);
        const message = store.addMessage(session.id, 'user', content, topics);
        busy.add(session.project_id);
        const task = executeRun(store, provider, session.id, message, { ...settings });
        const run = store.runs(session.id).find(r => r.user_message_id === message.id);
        task.finally(() => busy.delete(session.project_id)).catch(() => {});
        return json({ message, run_id: run.id }, 202);
      }
      const runRoute = path.match(/^\/api\/runs\/([^/]+)$/);
      if (runRoute && req.method === 'GET') { const run = store.run(runRoute[1]); return run ? json({ ...run, context_usage: contextUsage(run, locale), ui_warning: systemText(run.validation?.context_warning, locale), ui_error: systemText(run.error, locale) }) : json({ error: '답변 기록을 찾을 수 없습니다.' }, 404); }
      if (path === '/api/compare' && req.method === 'GET') {
        const all = [url.searchParams.get('leftRun'), url.searchParams.get('rightRun')].map(r => store.run(r));
        const left = all[0]?.snapshots.find(s => s.id === url.searchParams.get('left'));
        const right = all[1]?.snapshots.find(s => s.id === url.searchParams.get('right'));
        if (!left || !right) throw new Error('비교할 호출을 선택하세요.');
        const leftSession = store.session(all[0].session_id), rightSession = store.session(all[1].session_id);
        if (leftSession.project_id !== rightSession.project_id) throw new Error('같은 프로젝트의 호출끼리 비교하세요.');
        const comparison = compareSnapshots(left, right); return json({ ...comparison, note: systemText(comparison.note, locale) });
      }
      if (path === '/api/settings' && req.method === 'POST') {
        if (busy.size) throw Object.assign(new Error('Wait for the current answer before changing connection settings.'), { status: 409 });
        const data = await body(req);
        checkProvider(data.provider);
        if (data.autoContext !== undefined && typeof data.autoContext !== 'boolean') throw new Error('자동 컨텍스트 설정을 확인하세요.');
        const settings = { provider: data.provider, model: typeof data.model === 'string' ? data.model.trim().slice(0, 200) : '', ollamaUrl: localUrl(data.ollamaUrl || 'http://127.0.0.1:11434'), autoContext: data.autoContext ?? store.settings().autoContext };
        settings.chatgptModels = { ...store.settings().chatgptModels };
        if (settings.provider === 'chatgpt' && auth.account()) {
          const current = store.settings();
          if (!settings.model && current.provider === 'chatgpt' && current.model) settings.model = current.model;
          settings.chatgptModels[auth.account().client_id] = settings.model;
        }
        if (settings.provider === 'demo') settings.model = 'context-demo';
        if (typeof data.apiKey === 'string' && data.apiKey.trim()) auth.setApiKey(requiredText(data.apiKey.trim(), 1000));
        store.saveSettings(settings); return json(publicState());
      }
      if (path === '/api/models' && req.method === 'POST') {
        const data = await body(req), settings = { ...store.settings(), provider: data.provider || store.settings().provider, ollamaUrl: localUrl(data.ollamaUrl || store.settings().ollamaUrl), accountClientId: auth.account()?.client_id, locale };
        checkProvider(settings.provider);
        return json({ models: (await provider.models(settings)).map(m => m.id === 'context-demo' ? { ...m, name: systemText(m.name, locale) } : m) });
      }
      if (path === '/api/auth/status' && req.method === 'GET') return json({ attempt: { ...auth.status(browserSession), message: systemText(auth.status(browserSession).message, locale) }, auth: auth.publicStatus() });
      if (path === '/api/auth/start' && req.method === 'POST') { const data = await body(req); return json({ url: auth.begin(browserSession, data.client_id || null, data.consent === true, locale), attempt: { ...auth.status(browserSession), message: systemText(auth.status(browserSession).message, locale) } }); }
      if (path === '/api/auth/resume' && req.method === 'POST') return json({ url: auth.resume(browserSession) });
      if (path === '/api/auth/cancel' && req.method === 'POST') return json({ attempt: { ...auth.cancel(browserSession), message: systemText(auth.status(browserSession).message, locale) } });
      if (path === '/api/auth/acknowledge' && req.method === 'POST') { auth.acknowledge(); return json(publicState()); }
      if (path === '/api/auth/select' && req.method === 'POST') {
        const data = await body(req);
        if (busy.size) throw new Error('답변 처리가 끝난 뒤 계정을 변경하세요.');
        const settings = store.settings(), previous = auth.account()?.client_id;
        const saved = { ...settings.chatgptModels, ...(previous && settings.provider === 'chatgpt' ? { [previous]: settings.model } : {}) };
        auth.select(data.client_id); store.saveSettings({ ...settings, chatgptModels: saved, provider: 'chatgpt', model: saved[data.client_id] || '' }); return json(publicState());
      }
      if (path === '/api/auth/disconnect' && req.method === 'POST') {
        if (busy.size) throw new Error('답변 처리가 끝난 뒤 연결을 해제하세요.');
        const activeClientId = auth.account()?.client_id, result = await auth.disconnect();
        if (activeClientId && store.settings().provider === 'chatgpt') store.saveSettings({ ...store.settings(), model: '' });
        return json({ ...publicState(), disconnect: { ...result, message: systemText(result.message, locale) } });
      }
      if (path === '/api/auth/forget' && req.method === 'POST') {
        if (busy.size) throw new Error('답변 처리가 끝난 뒤 연결 정보를 정리하세요.');
        const data = await body(req), clientId = requiredText(data.client_id, 200), settings = store.settings();
        const wasActive = auth.account()?.client_id === clientId;
        auth.forgetDisconnected(clientId);
        const chatgptModels = { ...settings.chatgptModels }; delete chatgptModels[clientId];
        store.saveSettings({ ...settings, chatgptModels, ...(settings.provider === 'chatgpt' && (wasActive || settings.model === settings.chatgptModels?.[clientId]) ? { model: '' } : {}) });
        return json(publicState());
      }
      if (path === '/api/export' && req.method === 'GET') { res.setHeader('Content-Disposition', 'attachment; filename="contextpulse-backup.json"'); return json(store.export()); }
      if (path === '/api/export/sqlite' && req.method === 'GET') {
        const temporary = mkdtempSync(join(tmpdir(), 'contextpulse-backup-'));
        try {
          const file = join(temporary, 'contextpulse.sqlite');
          await backup(store.db, file);
          res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': 'attachment; filename="contextpulse.sqlite"' }); res.end(readFileSync(file));
        } finally { rmSync(temporary, { recursive: true, force: true }); }
        return;
      }
      if (path === '/api/demo' && req.method === 'POST') {
        requireIdle('__demo__'); busy.add('__demo__');
        try {
        const project = store.createProject(systemText('결정 교정 시연', locale), locale);
        const session = store.sessions(project.id)[0];
        const old = store.register(session.id, locale === 'ko' ? 'Solana 필수성 입증이 없으면 아이디어를 낮게 평가한다.' : 'Lower the idea rating unless Solana is proven essential.', [locale === 'ko' ? '평가기준' : 'Evaluation']).decision;
        store.register(session.id, locale === 'ko' ? '이 프로젝트에서는 Solana 필수성 입증을 주요 평가조건으로 삼지 않는다.' : 'In this project, proving Solana is essential is not a major evaluation criterion.', [locale === 'ko' ? '평가기준' : 'Evaluation'], { scope: 'project', supersedes: old.id, locale });
        const message = store.addMessage(session.id, 'user', locale === 'ko' ? '대화 맥락을 검증하는 서비스 아이디어를 평가해줘.' : 'Evaluate a service that checks consistency with conversation decisions.', [locale === 'ko' ? '평가기준' : 'Evaluation']);
        const run = await executeRun(store, provider, session.id, message, { provider: 'demo', model: 'context-demo', locale }, true);
        return json({ project, session, run_id: run.id }, 201);
        } finally { busy.delete('__demo__'); }
      }
      if (path.startsWith('/api/')) return json({ error: '지원하지 않는 요청입니다.' }, 404);
      if (req.method !== 'GET') return json({ error: '지원하지 않는 요청입니다.' }, 405);
      const appRoutes = new Set(['/', '/chat', '/contexts', '/decisions', '/settings', '/records']);
      const route = path.replace(/^\/ko(?:\/|$)/, '/').replace(/\/$/, '') || '/';
      const file = resolve(root, 'public', appRoutes.has(route) ? locale === 'ko' ? 'index.ko.html' : 'index.html' : `.${decodeURIComponent(path)}`);
      if (!file.startsWith(join(root, 'public') + '/') || !existsSync(file) || !statSync(file).isFile()) return json({ error: '파일을 찾을 수 없습니다.' }, 404);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
    } catch (error) { if (!res.headersSent) json({ error: error.message, ...(error.details ? { diagnostic: error.details } : {}) }, error.status || 400); else res.end(); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  const close = async () => {
    draining = true;
    const stopped = new Promise(resolve => server.close(resolve)); server.closeIdleConnections();
    const deadline = Date.now() + 30_000;
    while ((hosted ? manager.busyCount() : local.busy.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    // Do not close a DB beneath a provider call. Interrupted runs recover on restart.
    if (hosted ? manager.busyCount() : local.busy.size) return false;
    await stopped;
    hosted ? manager.close() : localStore.close(); return true;
  };
  return { server, store: localStore, auth: localAuth, manager, origin, close };

}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = serverConfig(process.env, root);
  const app = createApp(config);
  app.server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'server_started', mode: config.mode, origin: app.origin })));
  app.server.on('error', error => { console.error(JSON.stringify({ event: 'server_error', code: error.code })); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    const timer = setTimeout(() => process.exit(1), 35_000); timer.unref();
    const clean = await app.close(); console.log(JSON.stringify({ event: 'server_stopped', clean })); process.exit(clean ? 0 : 1);
  });
}
