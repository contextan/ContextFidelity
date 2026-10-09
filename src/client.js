const CLIENT_BUILD_ID = '__CONTEXT_PULSE_BUILD__';
const LOCALE = /^\/ko(?:\/|$)/.test(location.pathname) ? 'ko' : 'en';
const DATE_LOCALE = LOCALE === 'ko' ? 'ko-KR' : 'en-US';
const PAGE_ROUTES = { chat: '', contexts: 'contexts', settings: 'settings', inspector: 'records' };
function routePath(name, locale = LOCALE) { return `${locale === 'ko' ? '/ko' : ''}/${PAGE_ROUTES[name] || ''}`; }
function routeName() {
  return Object.keys(PAGE_ROUTES).find(p => location.hash.startsWith(`#${p}`)) || Object.entries(PAGE_ROUTES).find(([, route]) => route === location.pathname.replace(/^\/ko(?:\/|$)/, '/').replace(/^\/|\/$/g, ''))?.[0] || 'chat';
}
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phaseLabel = { selection: '질문별 컨텍스트 선택', extraction: '대화 맥락 자동 등록', generation: '초안 생성', validation: '검증', correction: '교정', revalidation: '재검증' };
const statusLabel = { extracted: '자동 등록 완료', running: '처리 중', corrected: '충돌 교정 완료', consistent: '검증 통과', uncertain: '판단 보류', unresolved: '충돌 미해결', failed: '처리 실패', no_decisions: '확인할 맥락 없음' };
let state, project, session, detail, selectedRun = null, compare = null;
let pageName = routeName();
let topics = [], draft = '', sending = false, poll = null, toastTimer;
let contextPanelOpen = false;
let inspectorMode = 'columns';
const models = new Map();
let oauthAttempt = { status: 'idle' }, oauthTimer = null, oauthUrl = '', oauthPopup = null;
let modelsLoading = null, syncTask = null;
const modelErrors = new Map();
const kindLabel = { background: '배경 정보', reference: '참고 자료', hypothesis: '검토 중인 가설' };
const includeLabel = { auto: '범위·주제에 따라 선택', always: '프로젝트에 항상 포함', off: '기본 포함 꺼짐' };
let contextPreview = { selected: [], excluded: [] }, contextTab = 'materials', contextFilter = '', contextStatus = 'active', contextKind = 'all', editor = null, previewSequence = 0;

async function api(path, method = 'GET', data) {
  const request = () => fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-ContextPulse-Locale': LOCALE, ...(state?.csrf ? { 'X-ContextPulse-Token': state.csrf } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  let response = await request(), result = await response.json();
  if (response.status === 403 && result.code === 'CSRF_RELOAD') {
    state = await (await fetch('/api/state', { headers: { 'X-ContextPulse-Locale': LOCALE } })).json();
    response = await request(); result = await response.json();
  }
  if (!response.ok) throw new Error(result.error || '요청을 완료하지 못했습니다.');
  return result;
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 5500);
}
function button(text, action, attrs = '') { return `<button type="button" data-action="${action}" ${attrs} class="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-medium">${text}</button>`; }
function pill(text, color = 'slate') { return `<span class="px-2 py-0.5 rounded border text-xs ${color === 'green' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : color === 'red' ? 'bg-rose-50 border-rose-200 text-rose-800' : color === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-800' : color === 'indigo' ? 'bg-indigo-50 border-indigo-200 text-indigo-800' : 'bg-slate-50 border-slate-200 text-slate-600'}">${esc(text)}</span>`; }
function countLabel(count, koLabel, enPlural, enSingular = enPlural) { return LOCALE === 'ko' ? `${koLabel} ${count}\uac1c` : `${count} ${count === 1 ? enSingular : enPlural}`; }
function raw(value) { return `<pre class="bg-slate-900 text-indigo-200 rounded-lg p-3 text-xs overflow-auto max-h-[600px]">${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`; }
function topicValues(value) { return [...new Set(value.split(/[,，]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 12); }
function demoNotice() { return `<div class="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs">시연 기록 · 실제 모델 호출 없음 · 고정된 사례로 교정 흐름을 확인합니다.</div>`; }
function oauthCardHtml() {
  if (state.mode === 'hosted') return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">공개 데모</h2><p class="text-sm text-slate-600">이 데모는 로그인 없이 사용할 수 있습니다. 기본 시연은 모델을 호출하지 않으며, 실제 답변을 사용하려면 본인의 API 키를 설정하세요. 대화와 컨텍스트는 방문자별로 분리해 저장합니다.</p></section>`;
  const pending = ['pending', 'processing'].includes(oauthAttempt.status);
  const activeAccount = state.auth.accounts.find(a => a.active);
  const connectedAccounts = state.auth.accounts.filter(a => a.connected);
  const status = pending ? oauthAttempt.message : state.auth.chatgptConnected ? '계정 연결 완료' : state.auth.signedIn ? '플랜 사용 권한 필요' : '';
  return `<section id="oauth-card" class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><div class="flex flex-wrap justify-between items-start gap-3"><div><h2 class="font-semibold">ChatGPT 모델 연결 · 선택 사항</h2><p class="text-sm text-slate-500 mt-2">ChatGPT OAuth는 실제 모델 답변과 자동 컨텍스트 처리를 위한 선택적 연결입니다. 프로젝트·대화·저장된 컨텍스트는 로그인 없이도 유지되고 관리됩니다.</p></div>${status ? pill(status, state.auth.chatgptConnected ? 'green' : pending ? 'amber' : 'slate') : ''}</div><div class="flex flex-wrap gap-2 items-center">${state.auth.signedIn ? button('연결 해제', 'disconnect') : ''}${state.auth.chatgptConnected ? '<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-700 underline">ChatGPT 사용량 관리</a>' : ''}</div><p class="text-xs text-slate-500">OAuth는 모델 제공자 인증에만 사용합니다. 기존 ChatGPT 대화 기록은 가져오지 않습니다.</p>
  ${pending ? `<div role="status" class="rounded-lg bg-indigo-50 border border-indigo-200 p-3 space-y-2"><p class="text-sm text-indigo-900">${esc(oauthAttempt.message)}</p><p class="text-xs text-indigo-700">승인 후 자동으로 연결 상태를 확인합니다. 로그인 창이 열리지 않으면 아래 버튼을 사용하세요.</p><div class="flex flex-wrap gap-2">${button('이 탭에서 로그인 계속', 'oauth-continue')}${oauthAttempt.status === 'pending' ? button('로그인 취소', 'oauth-cancel') : ''}</div></div>` : ['failed', 'expired', 'cancelled', 'permission_required'].includes(oauthAttempt.status) ? `<p role="status" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">${esc(oauthAttempt.message)}</p>` : ''}
  ${connectedAccounts.length ? `<div class="space-y-2">${connectedAccounts.map(a => `<div class="p-3 rounded-lg border ${a.active ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200'} flex flex-wrap justify-between items-center gap-3"><div><p class="text-sm font-medium">${esc(a.label)}</p><p class="mt-1 text-xs text-slate-500">${a.active ? '현재 계정 · ' : ''}${a.planEnabled ? 'ChatGPT 플랜 사용 권한 승인됨' : '플랜 사용 권한 필요'}</p></div>${!a.active ? button('이 계정 사용', 'choose-account', `data-client="${esc(a.client_id)}" ${pending ? 'disabled' : ''}`) : ''}</div>`).join('')}</div>` : ''}
  ${state.auth.signedIn && activeAccount && !activeAccount.planEnabled ? '<p class="text-xs text-amber-900">플랜 사용 권한이 필요하면 왼쪽 아래에서 계속 진행할 수 있습니다.</p>' : ''}</section>`;
}
function renderOAuthCard() { const card = $('#oauth-card'); if (card) card.outerHTML = oauthCardHtml(); }
async function loadModelsForProvider(provider = state.settings.provider, force = false) {
  if (provider === 'chatgpt' && !state.auth.chatgptConnected) return;
  const accountId = provider === 'chatgpt' ? state.auth.activeClientId : null;
  if (modelsLoading?.provider === provider && modelsLoading.accountId === accountId) return modelsLoading.promise;
  if (!force && models.has(provider)) return;
  const loading = { provider, accountId, promise: null };
  modelsLoading = loading;
  modelErrors.delete(provider);
  renderShell();
  loading.promise = (async () => {
    try {
      const result = await api('/models', 'POST', { provider, ollamaUrl: state.settings.ollamaUrl });
      if (provider === 'chatgpt' && state.auth.activeClientId !== accountId) return;
      models.set(provider, result.models);
    } catch (error) {
      if (provider === 'chatgpt' && state.auth.activeClientId !== accountId) return;
      models.delete(provider); modelErrors.set(provider, error.message);
    } finally {
      if (modelsLoading === loading) { modelsLoading = null; renderShell(); }
    }
  })();
  return loading.promise;
}
function showPlanWelcome() {
  if (!state.auth.accounts.some(a => a.active && a.connected && a.welcomePending) || $('#plan-welcome')) return;
  const dialog = document.createElement('dialog'); dialog.id = 'plan-welcome';
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-lg w-[90vw]';
  dialog.innerHTML = `<h2 class="text-lg font-semibold">ChatGPT 플랜을 사용합니다</h2><p class="text-sm text-slate-600 mt-3">이 앱의 지원되는 모델 요청은 연결한 ChatGPT 플랜의 사용량에 반영됩니다. 컨텍스트 선택·추출·검증·교정도 추가 요청을 사용합니다.</p><a class="block mt-3 text-sm text-indigo-700 underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">ChatGPT 사용량 관리</a><div class="mt-5">${button('확인', 'acknowledge-plan')}</div>`;
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.querySelector('button').click(); });
  document.body.append(dialog); dialog.showModal();
}
async function oauthCompleted() {
  clearTimeout(oauthTimer); oauthTimer = null; oauthUrl = '';
  state = await api('/state'); models.delete('chatgpt'); modelErrors.delete('chatgpt');
  sessionStorage.removeItem('contextpulse.oauthAttempt');
  await navigate(state.auth.chatgptConnected ? 'chat' : 'settings');
  if (oauthPopup && !oauthPopup.closed) oauthPopup.close(); oauthPopup = null;
  toast(oauthAttempt.message);
  showPlanWelcome();
}
function watchOAuth() {
  clearTimeout(oauthTimer);
  oauthTimer = setTimeout(async () => {
    try {
      const result = await api('/auth/status'); oauthAttempt = result.attempt; state.auth = result.auth;
      if (['connected', 'permission_required'].includes(oauthAttempt.status)) return await oauthCompleted();
      renderOAuthCard();
      if (['pending', 'processing'].includes(oauthAttempt.status)) watchOAuth();
      else { oauthUrl = ''; toast(oauthAttempt.message || '로그인 요청이 종료됐습니다. 다시 연결하세요.'); }
    } catch (error) { oauthAttempt = { status: 'failed', message: error.message }; renderOAuthCard(); }
  }, 1500);
}
async function startOAuth(target) {
  oauthPopup = window.open('', '_blank');
  if (oauthPopup) { oauthPopup.opener = null; oauthPopup.document.body.textContent = '공식 ChatGPT 로그인 창을 준비하고 있습니다.'; }
  target.disabled = true;
  try {
    const result = await api('/auth/start', 'POST', { client_id: target.dataset.client || null, consent: target.dataset.consent === 'true' });
    oauthUrl = result.url; oauthAttempt = result.attempt;
    sessionStorage.setItem('contextpulse.oauthAttempt', oauthAttempt.id);
    if (oauthPopup) oauthPopup.location = oauthUrl;
    await navigate('settings'); watchOAuth();
  } catch (error) { oauthPopup?.close(); oauthAttempt = { status: 'failed', message: error.message }; renderOAuthCard(); throw error; }
}
function shortId(value) { return value?.slice(0, 14) || ''; }

function currentChatModel() {
  return session?.model && session.model_provider === state.settings.provider ? session.model : state.settings.model || '';
}
function renderModelPicker() {
  const picker = $('#model-picker');
  if (!picker) return;
  const wasOpen = $('#model-menu')?.open || false;
  picker.classList.toggle('hidden', pageName !== 'chat' || chatNeedsLogin());
  picker.innerHTML = pageName === 'chat' && !chatNeedsLogin() ? modelPickerHtml() : '';
  if (wasOpen) { const menu = $('#model-menu'); if (menu) menu.open = true; }
}
function modelPickerHtml() {
  const provider = state.settings.provider;
  const available = [...(models.get(provider) || [])];
  const current = currentChatModel();
  if (current && !available.some(model => model.id === current)) available.unshift({ id: current, name: current });
  const loading = modelsLoading?.provider === provider && modelsLoading.accountId === (provider === 'chatgpt' ? state.auth.activeClientId : null);
  const connected = provider === 'demo' || provider === 'ollama' || (provider === 'chatgpt' ? state.auth.chatgptConnected : state.auth.apiKeySet);
  const label = available.find(model => model.id === current)?.name || (current || '모델 선택');
  const busy = (state.busy || []).length > 0;
  const options = available.map(model => `<button type="button" role="menuitemradio" aria-checked="${model.id === current}" data-action="model-select" data-model="${esc(model.id)}" class="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 ${model.id === current ? 'text-indigo-700 bg-indigo-50' : 'text-slate-700'}" ${busy || loading ? 'disabled' : ''}><span class="truncate">${esc(model.name)}</span>${model.id === current ? '<span class="material-symbols-outlined text-[18px]">check</span>' : ''}</button>`).join('');
  const emptyState = loading ? '<p class="px-3 py-3 text-xs text-slate-500" role="status">모델 목록을 불러오는 중…</p>'
    : !connected ? `<p class="px-3 py-3 text-xs text-slate-500">${provider === 'chatgpt' ? 'ChatGPT 계정을 연결하세요.' : '설정에서 API 키를 등록하세요.'}</p>`
      : modelErrors.has(provider) ? `<p class="px-3 py-3 text-xs text-rose-700" role="status">${esc(modelErrors.get(provider))}</p>`
        : !available.length ? '<p class="px-3 py-3 text-xs text-slate-500">사용 가능한 모델이 없습니다.</p>' : '';
  return `<details id="model-menu" class="relative"><summary aria-label="모델 선택: ${esc(label)}" class="list-none cursor-pointer flex max-w-[180px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"><span class="material-symbols-outlined text-indigo-600 text-[18px]">auto_awesome</span><span class="truncate">${esc(label)}</span><span class="material-symbols-outlined text-slate-400 text-[18px]">expand_more</span></summary><div role="menu" aria-label="모델 선택" class="absolute right-0 bottom-full z-[60] mb-2 w-72 max-w-[calc(100vw-24px)] rounded-xl border border-slate-200 bg-white p-2 shadow-xl"><p class="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">사용 가능한 모델</p>${options || emptyState}<div class="mt-2 border-t border-slate-100 pt-2">${button('새로고침', 'models-refresh', loading || busy ? 'disabled' : '')}</div></div></details>`;
}

async function loadProject(projectId, sessionId) {
  const previousSession = session?.id;
  project = await api(`/projects/${projectId}`);
  localStorage.setItem('contextpulse.project', projectId);
  const remembered = localStorage.getItem(`contextpulse.session.${projectId}`);
  const candidate = sessionId || remembered;
  session = project.sessions.find(s => s.id === candidate) || project.sessions[0];
  if (!session) session = await api('/sessions', 'POST', { project_id: projectId });
  detail = await api(`/sessions/${session.id}`);
  session = detail.session;
  if (session.id !== previousSession) {
    topics = detail.runs.find(r => r.context_usage)?.context_usage.topics || [];
    editor = null;
  }
  localStorage.setItem(`contextpulse.session.${projectId}`, session.id);
  if (!detail.runs.some(r => r.id === selectedRun)) selectedRun = detail.runs[0]?.id || null;
  await loadContextPreview();
  startPolling();
}
async function loadContextPreview() {
  topics = detail.runs.find(r => r.context_usage)?.context_usage.topics || topics;
  const request = ++previewSequence;
  const value = await api(`/sessions/${session.id}/context-preview`, 'POST', { topics });
  if (request === previewSequence) contextPreview = value;
}
async function refresh() {
  state = await api('/state');
  await loadProject(project.project.id, session.id);
  render();
}
function startPolling() {
  clearInterval(poll);
  if (!detail.runs.some(r => r.status === 'running')) return;
  const watching = session.id;
  poll = setInterval(async () => {
    try {
      const next = await api(`/sessions/${watching}`);
      if (session.id !== watching) return;
      detail = next;
      if (!next.runs.some(r => r.status === 'running')) {
        clearInterval(poll); poll = null; sending = false;
        state = await api('/state'); project = await api(`/projects/${project.project.id}`);
        render();
        const last = next.runs[0];
        await loadContextPreview(); render();
        toast(last.status === 'failed' ? last.ui_error || last.error : last.purpose === 'analysis' ? last.validation?.note : last.ui_warning || last.validation?.context_warning || '답변과 호출별 컨텍스트를 저장했습니다.');
      } else {
        const badge = $('#processing-status');
        if (badge) badge.textContent = progressLabel();
        if (next.runs.some(r => r.assistant_message_id)) render();
      }
    } catch (error) { clearInterval(poll); poll = null; sending = false; toast(error.message); }
  }, 1000);
}
function renderSessionList() {
  const list = $('#session-list');
  if (!list) return;
  list.innerHTML = project.sessions.length ? project.sessions.map(item => {
    const untitled = ['\uc0c8 \ub300\ud654', 'New conversation'].includes(item.title);
    const title = untitled ? '새 대화' : item.title;
    const current = item.id === session.id;
    return `<button type="button" data-session-id="${esc(item.id)}" aria-current="${current ? 'page' : 'false'}" title="${esc(title)}" class="sidebar-session"><span class="material-symbols-outlined">chat_bubble_outline</span><span class="sidebar-session-title">${esc(title)}</span></button>`;
  }).join('') : '<p class="sidebar-empty">대화가 없습니다.</p>';
}
function chatNeedsLogin() {
  return state.settings.provider === 'chatgpt' && !state.auth.chatgptConnected;
}
function closeSidebar() {
  const sidebar = $('#app-sidebar');
  const mobile = window.innerWidth <= 850;
  sidebar?.classList.remove('is-open');
  if (sidebar) {
    sidebar.inert = mobile;
    sidebar.setAttribute('aria-hidden', String(mobile));
  }
  $('#sidebar-toggle')?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sidebar-drawer-open');
  if (mobile) $('#sidebar-toggle')?.focus();
}
function openSidebar() {
  const sidebar = $('#app-sidebar');
  if (!sidebar) return;
  sidebar.inert = false;
  sidebar.setAttribute('aria-hidden', 'false');
  sidebar.classList.add('is-open');
  $('#sidebar-toggle')?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('sidebar-drawer-open');
  (sidebar.querySelector('[data-session-id]') || $('#new-chat'))?.focus();
}
function syncSidebarAccessibility() {
  const sidebar = $('#app-sidebar');
  if (!sidebar) return;
  const mobile = window.innerWidth <= 850;
  const open = mobile && sidebar.classList.contains('is-open');
  sidebar.inert = mobile && !open;
  sidebar.setAttribute('aria-hidden', String(mobile && !open));
  $('#sidebar-toggle')?.setAttribute('aria-expanded', String(open));
}
function renderShell() {
  $('#brand-link').href = routePath('chat');
  $('#workspace-name').textContent = project.project.name;
  $('#project-name').textContent = project.project.name;
  renderSessionList();
  $('#header-topics').textContent = topics.length ? '자동 주제: ' + topics.map(t => `#${t}`).join(' ') : '주제 자동 관리';
  const settingsTab = $('#settings-tab');
  const loginRequired = chatNeedsLogin();
  const pendingLogin = ['pending', 'processing'].includes(oauthAttempt.status);
  const activeAccount = state.auth.accounts.find(account => account.active);
  if (loginRequired) {
    const action = state.auth.signedIn && activeAccount ? 'reauth' : 'login';
    settingsTab.removeAttribute('data-page');
    settingsTab.dataset.action = action;
    if (action === 'reauth') {
      settingsTab.dataset.client = activeAccount.client_id;
      settingsTab.dataset.consent = 'true';
    } else {
      delete settingsTab.dataset.client;
      delete settingsTab.dataset.consent;
    }
    settingsTab.disabled = pendingLogin;
    settingsTab.setAttribute('aria-label', pendingLogin ? '로그인 확인 중' : state.auth.signedIn ? '플랜 권한 승인' : 'ChatGPT 로그인');
    settingsTab.title = pendingLogin ? '로그인 확인 중' : state.auth.signedIn ? '플랜 권한 승인' : 'ChatGPT 로그인';
    settingsTab.classList.remove('sidebar-settings-tab');
    settingsTab.classList.add('sidebar-login-tab');
    settingsTab.innerHTML = `<span class="material-symbols-outlined">${pendingLogin ? 'hourglass_top' : 'login'}</span><span>${pendingLogin ? '로그인 확인 중' : state.auth.signedIn ? '플랜 권한 승인' : 'ChatGPT 로그인'}</span>`;
  } else {
    settingsTab.dataset.page = 'settings';
    delete settingsTab.dataset.action;
    delete settingsTab.dataset.client;
    delete settingsTab.dataset.consent;
    settingsTab.disabled = false;
    settingsTab.setAttribute('aria-label', '설정');
    settingsTab.title = '설정';
    settingsTab.classList.remove('sidebar-login-tab');
    settingsTab.classList.add('sidebar-settings-tab');
    settingsTab.innerHTML = '<span class="material-symbols-outlined">tune</span><span>설정</span>';
  }
  const contextToggle = $('#context-panel-toggle');
  contextToggle?.classList.toggle('hidden', pageName !== 'chat');
  contextToggle?.setAttribute('aria-expanded', String(pageName === 'chat' && contextPanelOpen));
  renderModelPicker();
  document.querySelectorAll('[data-page]').forEach(el => {
    const active = el.dataset.page === pageName;
    el.classList.toggle('bg-indigo-50', active); el.classList.toggle('text-indigo-700', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
}
function render() {
  if (pageName !== 'chat') { document.body.classList.remove('chat-mode'); contextPanelOpen = false; }
  renderShell();
  if (pageName === 'chat') renderChat();
  if (pageName === 'contexts') renderContexts();
  if (pageName === 'settings') renderSettings();
  if (pageName === 'inspector') renderInspector().catch(error => toast(error.message));
}
function messageHtml(message) {
  const run = detail.runs.find(r => r.assistant_message_id === message.id);
  const ai = message.role === 'assistant';
  if (message.role === 'system') return `<div id="${esc(message.id)}" class="text-xs text-emerald-700 px-2 py-1">${esc(message.content)}</div>`;
  return `<article id="${esc(message.id)}" class="chat-message ${ai ? 'chat-message-assistant' : 'chat-message-user'}">
    <div class="chat-message-content">
      <div class="chat-message-heading"><span class="${ai ? 'chat-assistant-name' : 'chat-user-name'}">${ai ? 'ContextPulse' : '나'}</span></div>
      <div class="chat-message-bubble ${ai ? 'chat-assistant-bubble' : 'chat-user-bubble'}"><div class="message-body">${esc(message.content)}</div></div>
      ${run ? `<div class="chat-run-meta">${pill(run.status === 'running' && run.assistant_message_id ? '검증 완료 · 맥락 자동 등록 중' : statusLabel[run.status], run.status === 'corrected' || run.status === 'consistent' ? 'green' : 'amber')}${run.provider === 'demo' ? pill('시연 · 모델 호출 없음', 'amber') : ''}${button('검증 기록', 'inspect', `data-run="${esc(run.id)}"`)}</div>` : ''}
      ${run?.validation?.context_warning ? `<p class="mt-2 text-xs text-amber-800">${esc(run.ui_warning || run.validation.context_warning)}</p>` : ''}
      ${run?.validation?.note ? `<details class="mt-2 text-xs text-slate-500"><summary>검증 메모</summary><p class="mt-2">${esc(run.validation.note)}</p></details>` : ''}
      ${run ? usedContextHtml(run) : ''}
      ${run?.validation?.automatically_registered?.length ? `<p class="mt-2 text-xs text-emerald-700">맥락 ${run.validation.automatically_registered.length}개 자동 등록 · 원문과 함께 관리</p>` : ''}
    </div>
  </article>`;
}
function progressLabel() {
  const active = detail.runs.find(r => r.status === 'running');
  const phase = active?.progress?.phase;
  return phase ? `${phaseLabel[phase]} · ${active.progress.completed ? '완료' : '진행 중'}` : '답변을 준비하고 있습니다.';
}
function usedContextHtml(run) {
  const used = run.context_usage;
  if (!used) return `<p class="text-xs text-slate-500">이 답변의 전달 기록을 찾을 수 없습니다.</p>`;
  const item = (value, label) => `<div class="p-3 bg-white rounded border border-slate-200 space-y-2"><div class="flex flex-wrap items-center gap-2 text-xs">${pill(label)}${value.version ? `<span>v${value.version}</span>` : ''}${value.title ? `<strong>${esc(value.title)}</strong>` : ''}${value.topics?.length ? `<span>${esc(value.topics.map(t => '#' + t).join(' '))}</span>` : ''}</div><p class="message-body text-sm">${esc(value.content)}</p>${value.selection_reason ? `<p class="text-xs text-slate-500">${esc(value.selection_reason)}</p>` : ''}${value.source_id ? button('원문 보기', 'source', `data-message="${esc(value.source_id)}"`) : ''}</div>`;
  const topicItem = (value, included) => {
    const title = value.title || value.content?.slice(0, 64) || '내용 없음';
    const label = value.entry_type === 'conversation' ? '대화에서 파악한 내용' : kindLabel[value.kind] || '참고 자료';
    return included
      ? `<div class="rounded border border-emerald-100 bg-white p-2.5 space-y-1.5"><div class="flex flex-wrap items-center gap-2 text-[11px]">${pill('요청 입력에 포함', 'green')}${pill(label)}${value.version ? `<span>v${value.version}</span>` : ''}<strong>${esc(title)}</strong></div><p class="text-xs text-slate-700">${esc(value.selection_reason || '이번 답변의 실제 요청 입력에 포함')}</p>${value.source_id ? button('원문 보기', 'source', `data-message="${esc(value.source_id)}"`) : ''}</div>`
      : `<details class="rounded border border-slate-200 bg-white p-2.5 text-[11px]"><summary class="cursor-pointer text-slate-700">제외 · ${esc(title)}${value.version ? ` · v${value.version}` : ''}</summary><div class="mt-2 space-y-2"><p class="message-body text-xs text-slate-600">${esc(value.content || '')}</p><p class="text-slate-500">${esc(value.selection_reason || '이번 요청 입력에는 포함되지 않음')}</p>${value.source_id ? button('원문 보기', 'source', `data-message="${esc(value.source_id)}"`) : ''}</div></details>`;
  };

  const includedCount = used.contexts.length + used.decisions.length + used.history.length;
  const excludedCount = used.excluded_contexts.length + used.excluded_decisions.length;
  return `<details class="answer-context rounded-xl border border-indigo-200 bg-indigo-50/70" data-context-run="${esc(run.id)}">
    <summary class="answer-context-summary"><span class="font-semibold">이번 답변에 전달된 컨텍스트</span><span class="text-xs font-normal text-slate-500">${countLabel(includedCount, '포함', 'items sent', 'item sent')} · ${countLabel(excludedCount, '제외', 'items excluded', 'item excluded')} · ${esc(used.model)}</span></summary>
    <div class="px-4 pb-4 space-y-4">
    <div class="flex flex-wrap gap-2 items-center justify-end border-b border-indigo-100 pb-3 text-xs text-slate-500">
      <span>${esc(phaseLabel[used.phase] || used.phase)}</span>
    </div>

    <div class="space-y-2">
      <div class="flex flex-wrap items-center justify-between text-xs gap-2">
        <span class="font-medium text-slate-700">질문에서 파악한 주제 · ${used.selection_mode === 'semantic' ? '의미 기반 선택' : '태그·규칙 기반 선택'}</span>
        <div class="flex gap-1.5">
          ${pill(countLabel(used.contexts.length, '저장 컨텍스트 포함', 'stored contexts included', 'stored context included'), 'green')}
          ${pill(countLabel(used.decisions.length, '대화 맥락 포함', 'conversation context included'))}
          ${pill(countLabel(used.excluded_contexts.length, '저장 컨텍스트 제외', 'stored contexts excluded', 'stored context excluded'))}
          ${pill(countLabel(used.excluded_decisions.length, '대화 맥락 제외', 'conversation context excluded'))}
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5">${used.topics.length ? used.topics.map(topic => pill(`#${topic}`, 'indigo')).join('') : '<span class="text-xs text-slate-500">감지된 주제가 없습니다.</span>'}</div>
      ${used.selection_warning ? `<p class="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">${esc(used.selection_warning)}</p>` : ''}
      ${used.topic_clusters?.length ? `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          ${used.topic_clusters.map(cluster => `
            <div class="rounded-lg border ${cluster.included_count ? 'border-emerald-200 bg-white' : 'border-slate-200 bg-slate-50'} p-3 space-y-2">
              <div class="flex items-center justify-between gap-1">
                <span class="font-semibold text-xs text-slate-900">${cluster.scope === 'project' ? esc(cluster.topic) : `#${esc(cluster.topic)}`}</span>
                <div class="flex flex-wrap justify-end gap-1">
                  ${cluster.scope === 'project' ? '' : pill(cluster.question_matched ? '질문 주제 일치' : '질문 주제 외', cluster.question_matched ? 'indigo' : 'slate')}
                  ${cluster.included_count ? pill(countLabel(cluster.included_count, '포함', 'items included', 'item included'), 'green') : ''}
                  ${cluster.excluded_count ? pill(countLabel(cluster.excluded_count, '제외', 'items excluded', 'item excluded'), 'slate') : ''}
                </div>
              </div>
              <p class="text-[11px] text-slate-500">${esc(cluster.reason)}</p>
              <div class="space-y-1.5 pt-1.5 border-t border-slate-100">
                ${cluster.injected_items.map(it => topicItem(it, true)).join('')}
                ${cluster.excluded_items.map(it => topicItem(it, false)).join('')}
          ${!cluster.injected_items.length && !cluster.excluded_items.length ? '<p class="text-[11px] text-slate-500">이 주제에 연결된 저장 맥락이 없습니다.</p>' : ''}
              </div>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="flex flex-wrap gap-2 text-xs">
          <span class="text-slate-600">질문에서 추론한 주제:</span>
          ${used.topics.map(t => pill(`#${t}`)).join('')}
          ${pill(countLabel(used.contexts.length, '저장 맥락', 'stored contexts', 'stored context'))}
          ${pill(countLabel(used.decisions.length, '대화 맥락', 'conversation context entries', 'conversation context entry'))}
          ${pill(countLabel(used.history.length, '이전 대화', 'earlier messages', 'earlier message'))}
        </div>
      `}
    </div>

    <div class="space-y-2 pt-2 border-t border-indigo-100">
      <div class="flex items-center justify-between text-xs">
        <span class="font-medium text-slate-700">모델 요청에 실제 포함된 내용</span>
        <span class="text-[11px] text-slate-500">질문 처리 시점에 저장한 입력</span>
      </div>
      <div class="space-y-2">
        ${used.current_question ? item(used.current_question, '이 답변의 질문 · 저장 맥락 아님') : ''}
        ${used.contexts.map(c => item(c, kindLabel[c.kind] || '참고 자료')).join('')}
        ${used.decisions.map(d => item(d, '사용자 대화에서 파악한 내용')).join('')}
        ${used.history.map(h => item(h, h.role === 'user' ? '이전 사용자 발화' : '이전 답변')).join('')}
        ${!used.contexts.length && !used.decisions.length && !used.history.length ? '<p class="text-xs text-slate-500 bg-white p-2.5 rounded border border-slate-200">추가 맥락 없이 현재 질문만 전달했습니다.</p>' : ''}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
      <span class="text-slate-500">질문 당시 확정된 컨텍스트 영수증입니다.</span>
      ${button('전체 전달 기록·비교', 'inspect', `data-run="${esc(run.id)}"`)}
    </div>
    </div>
  </details>`;
}
function renderChat() {
  const previousStream = $('#chat-stream');
  const previousTop = previousStream?.scrollTop || 0;
  const wasNearBottom = !previousStream || previousStream.scrollHeight - previousStream.scrollTop - previousStream.clientHeight < 100;
  const busy = sending || detail.runs.some(r => r.status === 'running');
  const loginRequired = chatNeedsLogin();
  const failed = detail.runs.filter(r => r.status === 'failed');
  document.body.classList.add('chat-mode');
  $('#view').innerHTML = `<section class="chat-layout">
    <div id="chat-stream" class="chat-stream">
      <div class="chat-messages ${detail.messages.length ? '' : 'chat-messages-empty'}">
        ${detail.messages.length ? detail.messages.map(messageHtml).join('') : `<div class="chat-welcome"><div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></div><h1>${loginRequired ? 'ChatGPT 모델 연결이 필요합니다' : '대화를 시작해 보세요'}</h1><p>${loginRequired ? '저장된 컨텍스트와 대화 관리는 로그인 없이 가능합니다. ChatGPT 로그인은 실제 모델 답변을 생성할 때만 필요합니다.' : '대화가 이어지면 관련 맥락을 자동으로 관리하고, 답변마다 실제 전달 내용을 보여줍니다.'}</p>${!loginRequired && !currentChatModel() ? button('모델 선택', 'open-model-picker') : ''}</div>`}
        ${failed.map(r => `<div class="chat-failure"><p>처리 실패: ${esc(r.ui_error || r.error)}</p>${button('실패 호출 기록', 'inspect', `data-run="${r.id}"`)}</div>`).join('')}
        ${busy ? '<div id="processing-status" role="status" class="chat-processing">'+ esc(progressLabel()) + '</div>' : ''}
      </div>
    </div>
    <div class="chat-composer-dock">
      <form id="chat-form" class="chat-composer">
        <p id="chat-model-guidance" class="chat-model-guidance">${loginRequired ? 'ChatGPT 로그인은 실제 모델 답변을 만들 때 필요합니다. 저장된 컨텍스트와 대화는 그대로 유지됩니다.' : currentChatModel() ? '대화 주제를 파악하고 관련 컨텍스트를 자동으로 찾아 답변에 반영합니다.' : '입력창에서 모델을 선택하면 바로 대화를 시작할 수 있습니다.'}</p>
        <textarea id="chat-input" aria-label="메시지" maxlength="4000" rows="1" class="chat-input" placeholder="${loginRequired ? 'ChatGPT 모델 연결 후 메시지 보내기' : '메시지 보내기'}" ${busy || loginRequired ? 'disabled' : ''}>${esc(draft)}</textarea>
        <div class="chat-composer-toolbar"><span class="chat-composer-hint">${state.settings.provider === 'chatgpt' && state.auth.chatgptConnected ? '<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">ChatGPT 사용량</a> · ' : ''}⌘ / Ctrl + Enter 전송 · Enter 줄바꿈 · <span id="char-count">${draft.length}/4000</span></span><div class="chat-composer-actions"><div id="model-picker" class="${loginRequired ? 'hidden' : ''}"></div><button type="submit" class="chat-send" aria-label="보내기" title="보내기" ${busy || loginRequired || !currentChatModel() ? 'disabled' : ''}><span class="material-symbols-outlined">arrow_upward</span></button></div></div>
      </form>
      <p class="chat-footer-note">답변 아래에서 실제로 전달된 컨텍스트와 원문 근거를 확인할 수 있습니다.</p>
    </div>
  </section>
  <button type="button" id="chat-context-backdrop" class="chat-context-backdrop ${contextPanelOpen ? 'is-open' : ''}" data-action="close-context-panel" aria-label="컨텍스트 패널 닫기" tabindex="-1"></button>
  <aside id="chat-context-drawer" class="chat-context-drawer ${contextPanelOpen ? 'is-open' : ''}" role="complementary" aria-label="이번 대화의 컨텍스트" aria-hidden="${!contextPanelOpen}" ${contextPanelOpen ? '' : 'inert'}>${chatContextPanel()}</aside>`;
  const stream = $('#chat-stream');
  if (stream && detail.messages.length) stream.scrollTop = wasNearBottom ? stream.scrollHeight : previousTop;
  renderModelPicker();
  $('#context-panel-toggle')?.setAttribute('aria-expanded', String(contextPanelOpen));
}
function syncChatModelState() {
  const guide = $('#chat-model-guidance');
  if (guide) guide.textContent = chatNeedsLogin() ? 'ChatGPT 로그인은 실제 모델 답변을 만들 때 필요합니다. 저장된 컨텍스트와 대화는 그대로 유지됩니다.' : currentChatModel() ? '대화 주제를 파악하고 관련 컨텍스트를 자동으로 찾아 답변에 반영합니다.' : '입력창에서 모델을 선택하면 바로 대화를 시작할 수 있습니다.';
  const submit = $('#chat-form button[type="submit"]');
  const busy = sending || (detail?.runs || []).some(run => run.status === 'running');
  if (submit) submit.disabled = chatNeedsLogin() || !currentChatModel() || busy;
  const input = $('#chat-input');
  if (input) { input.disabled = chatNeedsLogin() || busy; input.placeholder = chatNeedsLogin() ? 'ChatGPT 모델 연결 후 메시지 보내기' : '메시지 보내기'; }
}
function chatContextPanel() {
  const selected = contextPreview.selected || [];
  const excluded = contextPreview.excluded || [];

  const topicMap = new Map();
  for (const item of selected) {
    const ts = item.scope === 'project' ? ['프로젝트 전체'] : item.topics?.length ? item.topics : ['주제 미지정'];
    for (const t of ts) {
      if (!topicMap.has(t)) topicMap.set(t, { topic: t, selected: [], excluded: [] });
      topicMap.get(t).selected.push(item);
    }
  }
  for (const item of excluded) {
    const ts = item.scope === 'project' ? ['프로젝트 전체'] : item.topics?.length ? item.topics : ['주제 미지정'];
    for (const t of ts) {
      if (!topicMap.has(t)) topicMap.set(t, { topic: t, selected: [], excluded: [] });
      topicMap.get(t).excluded.push(item);
    }
  }

  const groups = Array.from(topicMap.values());

  return `<div class="flex justify-between items-center gap-2"><h2 class="text-sm font-semibold">이번 대화의 컨텍스트</h2>${button('관리', 'contexts')}</div><p class="text-xs text-slate-500">주제 범위와 대화별 직접 설정을 기준으로 한 미리보기입니다. 의미 기반 자동 선택은 질문마다 수행하며 실제 결과는 답변 영수증에 기록합니다.</p>
    ${lastSelectionHtml()}${candidatePanel(true)}<section class="space-y-3"><div class="flex justify-between text-xs font-medium text-slate-600"><span>주제·포함 설정 미리보기</span>${pill(countLabel(selected.length, '규칙상 포함', 'contexts included by rules', 'context included by rules'), 'green')}</div>
    <div class="flex flex-wrap items-center gap-1.5 text-xs"><span class="text-slate-500">최근 답변 주제:</span>${topics.length ? topics.map(topic => pill(`#${topic}`, 'indigo')).join('') : '<span class="text-slate-500">아직 파악된 주제가 없습니다.</span>'}</div>
    ${groups.map(group => `
      <div class="rounded-xl border ${group.selected.length ? 'border-indigo-200 bg-white' : 'border-slate-200 bg-slate-100/60'} p-3 space-y-2.5">
        <div class="flex justify-between items-center gap-1">
          <span class="text-xs font-bold ${group.selected.length ? 'text-indigo-900' : 'text-slate-600'}">${group.topic === '프로젝트 전체' ? esc(group.topic) : `#${esc(group.topic)}`}</span>
          <div class="flex gap-1">${group.selected.length ? pill(countLabel(group.selected.length, '규칙상 포함', 'contexts included by rules', 'context included by rules'), 'green') : ''}${group.excluded.length ? pill(countLabel(group.excluded.length, '규칙상 제외', 'contexts excluded by rules', 'context excluded by rules')) : ''}</div>
        </div>
        ${group.selected.map(item => `
          <div class="rounded-lg border border-indigo-100 bg-indigo-50/50 p-2.5 space-y-1.5 text-xs">
            <div class="flex justify-between gap-1 items-center">
              <span class="font-semibold text-slate-900">${esc(item.title)}</span>
              ${pill(kindLabel[item.kind], item.kind === 'hypothesis' ? 'amber' : 'slate')}
            </div>
            <p class="context-snippet text-[11px] text-slate-600">${esc(item.content)}</p>
            <p class="text-[11px] text-indigo-700">${esc(item.selection_reason)} · v${item.version}</p>
            <div class="flex gap-2 pt-1">${button('이 대화에서 제외', 'context-override', `data-context="${item.id}" data-mode="exclude"`)}${item.override !== 'auto' ? button('자동 선택으로 복원', 'context-override', `data-context="${item.id}" data-mode="auto"`) : ''}</div>
          </div>
        `).join('')}
        ${group.excluded.length ? `
          <details class="text-[11px] text-slate-500"><summary class="cursor-pointer hover:text-slate-700">제외된 맥락 ${group.excluded.length}개</summary>
            <div class="mt-2 space-y-2">
              ${group.excluded.map(item => `
                <div class="rounded border border-slate-200 bg-white p-2 space-y-1 text-[11px]">
                  <p class="font-medium text-slate-800">${esc(item.title)}</p>
                  <p class="context-snippet text-slate-600">${esc(item.content)}</p>
                  <p class="text-slate-500">${esc(item.selection_reason)}</p>
                  ${item.source_id ? button('원문 보기', 'source', `data-message="${esc(item.source_id)}"`) : ''}
                  ${item.status === 'active' ? button('이 대화에 포함', 'context-override', `data-context="${item.id}" data-mode="include"`) + (item.override !== 'auto' ? ' ' + button('자동 선택으로 복원', 'context-override', `data-context="${item.id}" data-mode="auto"`) : '') : ''}
                </div>
              `).join('')}
            </div>
          </details>
        ` : ''}
      </div>
    `).join('') || '<div class="rounded-lg border border-dashed border-slate-300 p-4 text-xs text-slate-500">대화에서 유용한 맥락을 자동 등록하고 다음 질문에 맞춰 선택합니다.</div>'}
    </section>`;
}

function visibleContexts() {
  const query = contextFilter.trim().toLowerCase();
  return project.contexts.filter(item => (contextStatus === 'all' || item.status === contextStatus) && (contextKind === 'all' || item.kind === contextKind) && (!query || [item.title, item.content, ...item.topics].join(' ').toLowerCase().includes(query)));
}
function candidatePanel(compact = false) {
  const all = project.candidates.filter(c => c.status === 'accepted');
  const items = compact ? all.slice(0, 3) : all;
  return `<section class="space-y-3"><div class="flex justify-between items-center"><h2 class="text-sm font-semibold">자동 등록 이력 · ${all.length}개</h2>${compact ? button('전체 보기', 'context-candidates') : ''}</div><p class="text-xs text-slate-500">사용자 발화와 모델 답변에서 원문을 확인해 맥락을 자동 등록합니다. 모델 제안은 가설로 유지합니다.</p>${items.map(item => `<article class="rounded-xl border border-emerald-200 bg-white p-4 space-y-3"><h3 class="text-sm font-semibold">${esc(item.title)}</h3>${pill(item.kind === 'decision' ? '사용자 대화에서 파악한 내용' : kindLabel[item.kind])}<blockquote class="message-body border-l-2 border-slate-300 pl-3 text-sm">${esc(item.content)}</blockquote><p class="text-xs text-slate-500">${item.scope === 'project' ? '프로젝트 전체' : item.topics.map(t => '#' + esc(t)).join(' ')} · ${esc(new Date(item.created_at).toLocaleString(DATE_LOCALE))}</p><div class="flex gap-2">${button('원문 보기', 'source', `data-message="${item.source_id}"`)}${button('추출 입력·결과', 'inspect', `data-run="${item.run_id}"`)}</div></article>`).join('') || '<p class="text-xs text-slate-500">아직 자동 등록된 맥락이 없습니다. 실제 모델을 연결하고 대화하면 등록됩니다.</p>'}</section>`;
}
function lastSelectionHtml() {
  const last = contextPreview.last_selection;
  if (!last) return '';
  return `<section class="p-4 rounded-xl border border-indigo-200 bg-white space-y-3"><h3 class="text-sm font-semibold">최근 답변에 사용한 맥락</h3><p class="text-xs text-slate-500">${esc(last.question)} · ${last.mode === 'semantic' ? '질문 의미로 자동 선택' : last.mode === 'tag_fallback' ? '자동 선택 실패 · 태그 기준 사용' : '태그·수동 선택'}</p>${last.items.map(item => `<div class="text-xs space-y-1"><p class="font-semibold">${esc(item.title)} · v${item.version}</p><p class="text-indigo-600">${esc(item.selection_reason)}</p></div>`).join('') || '<p class="text-xs text-slate-500">사용한 참고 맥락 없음</p>'}${button('선택 입력·실제 전달 내용', 'inspect', `data-run="${last.run_id}"`)}</section>`;
}
function contextListHtml() {
  const items = visibleContexts();
  return items.map(item => `<article class="bg-white border ${editor?.id === item.id ? 'border-indigo-300' : 'border-slate-200'} rounded-xl p-4 space-y-3"><div class="flex flex-wrap justify-between gap-2"><button type="button" data-action="edit-context" data-context="${item.id}" class="font-semibold text-sm text-left hover:text-indigo-700">${esc(item.title)}</button><div class="flex gap-1">${pill(kindLabel[item.kind], item.kind === 'hypothesis' ? 'amber' : 'slate')}${item.registration === 'automatic' ? pill('자동 등록', 'green') : ''}${item.status === 'archived' ? pill('보관됨') : ''}</div></div><p class="context-snippet text-sm text-slate-600">${esc(item.content)}</p><div class="flex flex-wrap gap-2 text-xs text-slate-500"><span>${item.scope === 'project' ? '프로젝트 전체' : item.topics.map(t => `#${esc(t)}`).join(' ')}</span><span>· ${includeLabel[item.include_mode]}</span><span>· v${item.version}</span></div><div class="flex flex-wrap gap-2">${button('편집', 'edit-context', `data-context="${item.id}"`)}${button('버전 이력', 'context-history', `data-context="${item.id}"`)}${item.source_id ? button('대화 원문', 'source', `data-message="${item.source_id}"`) : ''}${button(item.status === 'archived' ? '다시 사용' : '보관', 'archive-context', `data-context="${item.id}" data-archived="${item.status !== 'archived'}"`)}</div></article>`).join('') || `<div class="p-6 border border-dashed border-slate-300 rounded-xl text-sm text-slate-500">${project.contexts.length ? '검색 조건에 맞는 컨텍스트가 없습니다.' : '아직 컨텍스트가 없습니다. 대화하면 원문에서 자동 등록합니다.'}</div>`;
}
function renderContexts() {
  const tab = contextTab;
  $('#view').innerHTML = `<div class="p-4 md:p-6 space-y-5"><div class="flex flex-wrap justify-between gap-3 items-center"><div><h1 class="text-xl font-semibold">컨텍스트 관리</h1><p class="text-sm text-slate-500 mt-2">${esc(project.project.name)}의 배경·참고 자료와 대화에서 자동으로 찾은 맥락을 확인합니다.</p></div><div class="flex flex-wrap gap-2">${button('새 컨텍스트', 'new-context')}</div></div>
  <div class="flex gap-5 border-b border-slate-200"><button type="button" data-action="context-materials" class="pb-3 text-sm ${tab === 'materials' ? 'border-b-2 border-indigo-600 text-indigo-700 font-semibold' : 'text-slate-500'}">배경·참고·가설 ${project.contexts.filter(c => c.status === 'active').length}</button><button type="button" data-action="context-candidates" class="pb-3 text-sm ${tab === 'candidates' ? 'border-b-2 border-indigo-600 text-indigo-700 font-semibold' : 'text-slate-500'}">자동 등록 이력 ${project.candidates.filter(c => c.status === 'accepted').length}</button></div>
  ${tab === 'candidates' ? candidatePanel(false) : `<div class="grid grid-cols-1 xl:grid-cols-12 gap-5"><section class="xl:col-span-7 space-y-4"><div class="flex flex-wrap gap-2"><input id="context-search" aria-label="컨텍스트 검색" class="flex-1 min-w-0 rounded-lg border-slate-200 text-sm" placeholder="제목·내용·주제 검색" value="${esc(contextFilter)}"><select id="context-kind-filter" aria-label="컨텍스트 종류 필터" class="rounded-lg border-slate-200 text-sm"><option value="all">모든 종류</option>${Object.entries(kindLabel).map(([key, label]) => `<option value="${key}" ${contextKind === key ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="context-status-filter" aria-label="컨텍스트 상태 필터" class="rounded-lg border-slate-200 text-sm">${[['active', '사용 중'], ['archived', '보관됨'], ['all', '모두']].map(([key, label]) => `<option value="${key}" ${contextStatus === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div id="context-list" class="space-y-3">${contextListHtml()}</div></section><aside class="xl:col-span-5"><div class="context-editor">${contextEditorHtml()}</div></aside></div>`}</div>`;
}
function contextEditorHtml() {
  if (!editor) return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><h2 class="font-semibold">필요한 부분만 답변에 사용</h2><p class="text-sm text-slate-500 leading-relaxed">프로젝트 배경, 참고 자료, 검토 중인 가설을 분리해 관리합니다. 자동 관리가 켜져 있으면 모델이 질문과 각 항목의 내용을 비교해 필요한 자료를 선택합니다.</p><p class="text-sm text-slate-500 leading-relaxed">채팅에서 직접 포함하거나 제외할 수 있으며, 대화에서 파악한 맥락은 답변마다 실제 전달 내역에서 확인할 수 있습니다.</p>${project.contexts.length ? '<p class="text-xs text-indigo-600">목록에서 항목을 선택하면 내용과 적용 범위를 편집할 수 있습니다.</p>' : button('첫 컨텍스트 추가', 'new-context')}</section>`;
  const item = editor;
  return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><div class="flex items-center justify-between"><h2 class="font-semibold">${item.id ? '컨텍스트 편집' : '새 컨텍스트'}</h2>${item.id ? pill(`v${item.version}`) : ''}</div><form id="context-form" class="space-y-4"><label class="block text-xs text-slate-600">제목<input name="title" required maxlength="120" class="block w-full rounded-lg border-slate-200 text-sm mt-1" placeholder="예: 사용자와 해결할 문제" value="${esc(item.title)}"></label><label class="block text-xs text-slate-600">종류<select name="kind" class="block w-full rounded-lg border-slate-200 text-sm mt-1">${Object.entries(kindLabel).map(([key, label]) => `<option value="${key}" ${item.kind === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="block text-xs text-slate-600">내용<textarea name="content" required maxlength="30000" rows="8" class="block w-full rounded-lg border-slate-200 text-sm mt-1" placeholder="답변에 필요한 맥락을 적어주세요.">${esc(item.content)}</textarea></label><div class="grid grid-cols-2 gap-3"><label class="block text-xs text-slate-600">적용 범위<select name="scope" class="block w-full rounded-lg border-slate-200 text-sm mt-1"><option value="project" ${item.scope === 'project' ? 'selected' : ''}>프로젝트 전체</option><option value="topic" ${item.scope === 'topic' ? 'selected' : ''}>지정한 주제</option></select></label><label class="block text-xs text-slate-600">포함 방식<select name="include_mode" class="block w-full rounded-lg border-slate-200 text-sm mt-1">${Object.entries(includeLabel).map(([key, label]) => `<option value="${key}" ${item.include_mode === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><label class="block text-xs text-slate-600">주제<input name="topics" class="block w-full rounded-lg border-slate-200 text-sm mt-1" placeholder="제품, 평가기준 · 쉼표로 구분" value="${esc(item.topics.join(', '))}"></label><p class="text-xs text-slate-500">가설은 확정된 사실로 취급하지 않습니다. ‘항상 포함’은 이 프로젝트의 모든 대화에 포함합니다.</p>${item.source_id ? '<p class="text-xs text-indigo-600">대화 원문이 연결되어 있습니다. 편집 내용은 별도 버전으로 보관합니다.</p>' : ''}<div class="flex gap-2"><button class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium">${item.id ? '새 버전 저장' : '컨텍스트 저장'}</button>${button('닫기', 'close-editor')}</div></form></section>`;
}
function newContext(message = null) {
  editor = { title: message ? message.content.slice(0, 60) : '', content: message?.content || '', kind: message ? 'reference' : 'background', scope: 'project', topics: message?.topics || [...topics], include_mode: 'auto', source_id: message?.id || null };
  contextTab = 'materials';
  navigate('contexts');
}
async function saveContextEditor() {
  const values = new FormData($('#context-form'));
  const data = { title: values.get('title'), content: values.get('content'), kind: values.get('kind'), scope: values.get('scope'), topics: topicValues(values.get('topics')), include_mode: values.get('include_mode'), ...(editor.source_id ? { source_id: editor.source_id } : {}) };
  const item = await api(editor.id ? `/contexts/${editor.id}` : `/projects/${project.project.id}/contexts`, 'POST', data);
  editor = item; contextStatus = 'active'; contextFilter = ''; contextKind = 'all';
  await refresh(); toast(item.version > 1 ? '새 버전을 저장했습니다. 과거 답변의 입력은 유지됩니다.' : '컨텍스트를 저장했습니다. 다음 답변부터 필요한 맥락으로 자동 선택됩니다.');
}
async function contextHistory(contextId) {
  const result = await api(`/contexts/${contextId}`);
  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-2xl w-[90vw] max-h-[85vh] overflow-auto';
  dialog.innerHTML = `<h2 class="font-semibold mb-4">${esc(result.context.title)} · 버전 이력</h2><div class="space-y-4">${result.versions.map(item => `<div class="border-l-2 border-indigo-200 pl-4 space-y-2"><div class="flex gap-2 text-xs">${pill(`v${item.version}`)}${pill(item.status === 'active' ? '사용 중' : item.status === 'archived' ? '보관됨' : '이전 버전')}<span class="text-slate-500">${new Date(item.created_at).toLocaleString(DATE_LOCALE)}</span></div><p class="font-semibold text-sm">${esc(item.title)}</p><p class="message-body text-sm text-slate-600">${esc(item.content)}</p><p class="text-xs text-slate-500">${kindLabel[item.kind]} · ${includeLabel[item.include_mode]} · ${item.scope === 'project' ? '프로젝트 전체' : esc(item.topics.join(', '))}</p></div>`).join('')}</div><div class="mt-5">${button('닫기', 'close-dialog')}</div>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
}
async function renderInspector() {
  const runId = selectedRun || detail.runs[0]?.id;
  if (!runId) { $('#view').innerHTML = `<div class="p-6"><h1 class="text-xl font-semibold">답변 기록</h1><p class="mt-3 text-slate-500">아직 호출 기록이 없습니다. 모델을 연결해 질문하거나 교정 흐름을 시연하세요.</p><div class="mt-4">${button('교정 흐름 시연', 'demo')}</div></div>`; return; }
  const run = await api(`/runs/${runId}`);
  if (pageName !== 'inspector') return;
  selectedRun = runId;
  $('#view').innerHTML = `${run.provider === 'demo' ? demoNotice() : ''}<div class="p-4 md:p-6 space-y-4"><div class="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap justify-between gap-3"><div class="space-y-2"><h1 class="text-lg font-semibold">답변별 실제 전달 컨텍스트</h1><select id="run-select" aria-label="답변 선택" class="text-xs rounded border-slate-200">${detail.runs.map(r => `<option value="${r.id}" ${r.id === run.id ? 'selected' : ''}>${esc(shortId(r.id))} · ${esc(statusLabel[r.status])}</option>`).join('')}</select> ${pill(run.status === 'running' && run.assistant_message_id ? '검증 완료 · 맥락 자동 등록 중' : statusLabel[run.status], run.status === 'failed' ? 'red' : 'slate')}<p class="text-xs text-slate-500">호출 당시 입력을 보존한 기록입니다. 모델 내부의 영향도나 주의 집중을 뜻하지 않습니다.</p></div><div class="flex gap-2 items-start">${button('단계별 보기', 'inspector-columns')}${button('입력 차이 비교', 'inspector-diff')}</div></div>
  ${run.validation?.context_warning ? `<p class="p-3 rounded bg-amber-50 text-amber-900 text-sm">${esc(run.ui_warning || run.validation.context_warning)}</p>` : ''}
  ${run.error ? `<p class="p-3 rounded bg-rose-50 text-rose-800 text-sm">${esc(run.error)}<br>실패한 호출은 준비된 요청 본문을 기록하며, 제공자가 입력을 수신했는지는 보장하지 않습니다.</p>` : ''}
  ${inspectorMode === 'diff' ? compareControls(run) + '<div id="comparison-result"></div>' : `<div class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4 gap-4">${run.snapshots.map(snapshotCard).join('')}</div>`}
  <section class="bg-white border border-slate-200 rounded-lg p-4 space-y-3"><h2 class="font-semibold">선택한 답변의 원문 근거</h2><div class="space-y-2">${run.snapshots.flatMap(s => s.blocks.filter(b => b.source_id && (b.decision_id || b.context_id))).filter((b, i, all) => all.findIndex(x => x.source_id === b.source_id && x.version === b.version) === i).map(b => `<div class="flex flex-wrap gap-2 items-center text-xs"><span>${b.context_id ? '참고 맥락' : '대화에서 파악한 내용'} · v${b.version} · 원문 ${esc(shortId(b.source_id))}</span>${button('원문 보기', 'source', `data-message="${esc(b.source_id)}"`)}</div>`).join('') || '<p class="text-sm text-slate-500">연결된 대화 원문 없음</p>'}</div></section></div>`;
  if (inspectorMode === 'diff' && run.snapshots.length >= 2) await loadComparison();
}
function snapshotCard(s) {
  const usage = s.usage?.input_tokens;
  return `<article class="bg-white border border-slate-200 rounded-lg overflow-hidden min-w-0"><div class="p-4 bg-slate-50 border-b border-slate-200 space-y-2"><h2 class="font-semibold">${s.ordinal + 1}. ${phaseLabel[s.phase]}</h2><div class="text-xs text-slate-500">${esc(s.model)} · ${s.latency_ms ?? '—'} ms</div>${pill(s.call_status === 'completed' ? '호출 완료' : s.call_status === 'failed' ? '호출 실패' : '호출 중', s.call_status === 'failed' ? 'red' : 'slate')}<p class="text-xs text-slate-500">입력 ${usage != null ? `${usage} 토큰` : '토큰 미측정'} · ${new TextEncoder().encode(s.payload).length} bytes</p></div><div class="p-4 space-y-4"><section><h3 class="text-sm font-semibold text-indigo-700 mb-2">[A] 실제 전달한 입력</h3>${s.blocks.map(b => `<details class="mb-2 border border-slate-200 rounded p-2 text-xs"><summary class="font-medium text-slate-700">${esc(b.key)}${b.version ? ` · v${b.version}` : ''}</summary><div class="message-body mt-2 text-slate-600">${esc(b.content)}</div></details>`).join('')}<details class="mt-2"><summary class="text-xs text-indigo-700">RAW · 전체 전송 본문</summary>${raw(JSON.parse(s.payload))}</details></section><section><h3 class="text-sm font-semibold text-emerald-700 mb-2">[B] 처리 결과</h3><div class="message-body text-sm text-slate-700">${esc(s.output || s.call_error || '처리 중')}</div></section><details><summary class="text-xs text-slate-500">호출 메타데이터</summary>${raw({ id: s.id, run_id: s.run_id, phase: s.phase, endpoint: s.endpoint, model: s.model, usage: s.usage, hash: s.hash, created_at: s.created_at, latency_ms: s.latency_ms })}</details><details><summary class="text-xs text-slate-500">컨텍스트 선택에서 제외된 후보 · 전송 본문 아님</summary>${raw(s.excluded)}</details></div></article>`;
}
function compareControls(run) {
  const options = (value) => run.snapshots.map(s => `<option value="${run.id}|${s.id}" ${s.id === value ? 'selected' : ''}>${phaseLabel[s.phase]} · ${shortId(run.id)}</option>`).join('');
  const selection = run.snapshots.find(s => s.phase === 'selection');
  const generation = run.snapshots.find(s => s.phase === 'generation');
  const left = compare?.left || selection?.id || generation?.id || run.snapshots[0]?.id;
  const right = compare?.right || (generation?.id !== left ? generation?.id : run.snapshots.find(s => s.id !== left)?.id) || left;
  return `<div class="bg-white border border-slate-200 rounded-lg p-4 space-y-3"><p class="text-sm font-semibold">비교할 두 호출 선택</p><div class="flex flex-wrap gap-2"><select id="compare-left" aria-label="비교 기준 호출" class="text-xs rounded border-slate-200">${options(left)}</select><span>→</span><select id="compare-right" aria-label="비교 대상 호출" class="text-xs rounded border-slate-200">${options(right)}</select>${button('이전 답변의 마지막 호출과 비교', 'compare-previous')}</div><p class="text-xs text-slate-500">공통·추가·제거·변경 블록을 비교합니다. 다른 호출은 입력 구조와 목적이 다를 수 있습니다.</p></div>`;
}
async function loadComparison() {
  if (!$('#compare-left') || !$('#compare-right')) return;
  const [leftRun, left] = $('#compare-left').value.split('|'), [rightRun, right] = $('#compare-right').value.split('|');
  if (!left || !right) return;
  const result = await api(`/compare?${new URLSearchParams({ leftRun, rightRun, left, right })}`);
  compare = { left, right };
  $('#comparison-result').innerHTML = `<div class="bg-white border border-slate-200 rounded-lg p-4 space-y-4"><div class="flex flex-wrap gap-2">${pill(`공통 ${result.common.length}개`)}${pill(`추가 ${result.added.length}개`, 'green')}${pill(`제거 ${result.removed.length}개`, 'red')}${pill(`변경 ${result.changed.length}개`, 'amber')}</div><p class="text-xs text-slate-500">전체 본문 ${result.left_bytes} → ${result.right_bytes} bytes. ${esc(result.note)}</p>${result.added.map(b => `<details class="p-3 rounded bg-emerald-50 border border-emerald-200"><summary class="text-sm text-emerald-800">+ ${esc(b.key)}</summary><pre class="text-xs mt-2">${esc(b.content)}</pre></details>`).join('')}${result.removed.map(b => `<details class="p-3 rounded bg-rose-50 border border-rose-200"><summary class="text-sm text-rose-800">− ${esc(b.key)}</summary><pre class="text-xs mt-2">${esc(b.content)}</pre></details>`).join('')}${result.changed.map(b => `<details class="p-3 rounded bg-amber-50 border border-amber-200"><summary class="text-sm text-amber-800">변경 ${esc(b.key)}</summary><pre class="text-xs mt-2">이전:\n${esc(b.before.content)}\n\n이후:\n${esc(b.after.content)}</pre></details>`).join('')}<details class="p-3 border border-slate-200 rounded"><summary class="text-sm">공통 블록</summary>${raw(result.common)}</details></div>`;
}
function renderSettings() {
  const s = state.settings;
  $('#view').innerHTML = `<div class="p-4 md:p-6 space-y-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><div><h1 class="text-xl font-semibold">설정</h1><p class="mt-2 text-sm text-slate-600">언어와 저장 정보를 관리합니다.</p></div><label class="block max-w-sm rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">인터페이스 언어<select id="language-select" class="block mt-2 w-full rounded-lg border-slate-200 bg-white text-sm text-slate-800"><option value="en" ${LOCALE === 'en' ? 'selected' : ''}>English</option><option value="ko" ${LOCALE === 'ko' ? 'selected' : ''}>한국어</option></select></label><p class="text-xs text-slate-500">기록은 서버 저장소에 보존</p></section>${oauthCardHtml()}<div class="grid grid-cols-1 xl:grid-cols-2 gap-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><h2 class="font-semibold">연결 설정</h2>
  <form id="settings-form" class="space-y-3"><label class="block text-sm">연결 방식<select id="provider-input" class="block mt-1 w-full rounded border-slate-200 text-sm">${[['chatgpt', 'ChatGPT OAuth'], ['openai', 'OpenAI API 키'], ['ollama', '로컬 모델 · Ollama / Gemma'], ['demo', '시연 · 모델 호출 없음']].filter(([id]) => !state.capabilities || state.capabilities.providers.includes(id)).map(([id, name]) => `<option value="${id}" ${s.provider === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label id="ollama-field" class="block text-sm ${s.provider !== 'ollama' || state.mode === 'hosted' ? 'hidden' : ''}">로컬 모델 주소<input id="ollama-url" class="block mt-1 w-full rounded border-slate-200 text-sm" value="${esc(s.ollamaUrl)}"></label><label id="api-key-field" class="block text-sm ${s.provider !== 'openai' ? 'hidden' : ''}">OpenAI API 키 <span class="text-xs text-slate-500">${state.auth.apiKeySet ? '등록됨 · 빈칸은 유지' : '미등록'}</span><input id="api-key" type="password" autocomplete="off" class="block mt-1 w-full rounded border-slate-200 text-sm" placeholder="새 키를 등록할 때만 입력"></label><p class="text-xs text-slate-500">모델은 각 대화의 입력창에서 선택합니다.</p><label class="flex gap-2 items-center text-sm"><input id="auto-context" type="checkbox" ${s.autoContext ? 'checked' : ''}>대화 맥락 자동 등록·질문별 의미 선택</label><p class="text-xs text-slate-500">실제 모델 연결 시 선택·자동 등록에 최대 2회 추가 호출합니다. 사용자 원문과 모델 답변에서 맥락을 자동 등록합니다. 모델 제안은 검토 중인 가설로 분류합니다. 현재 질문에서 파악한 내용은 바로 반영하고, 답변에서 찾은 맥락은 다음 답변부터 사용합니다.</p><button class="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm">설정 저장</button></form><p class="text-xs text-slate-500">인증 정보는 서버 전용 파일에 저장하며 호출 기록·내보내기에 포함하지 않습니다. 공개 데모의 API 키는 암호화해 저장합니다.</p></section>
  <div class="space-y-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">저장소와 내보내기</h2><p class="text-sm text-slate-600">저장 용량 ${(state.storage_bytes / 1024).toFixed(1)} KB · 프로젝트 ${state.projects.length}개</p><div class="flex flex-wrap gap-2">${button('전체 기록 JSON 다운로드', 'export-json')}${button('실제 SQLite 다운로드', 'export-sqlite')}</div><p class="text-xs text-slate-500">대화 원문이 포함됩니다. 인증 정보는 제외합니다. 기록 삭제·가져오기는 아직 제공하지 않습니다.</p></section><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">검증 정책</h2><p class="text-sm text-slate-600">교정 최대 1회 · 재검증 1회<br>원문 인용 확인 후 교정<br>프로젝트 범위 분리<br>호출 당시 입력은 수정·덮어쓰기 금지</p><p class="text-xs text-slate-500">근거가 부족하거나 검증 응답이 올바르지 않으면 판단 보류로 표시합니다. 재검증 후에도 충돌하면 미해결로 남깁니다.</p></section><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">교정 흐름 시연</h2><p class="text-sm text-slate-600">별도 시연 프로젝트에서 대화의 맥락과 어긋난 초안 → 원문 확인 → 답변 수정 → 재검증을 확인합니다.</p>${button('새 시연 프로젝트 만들기', 'demo')}<p class="text-xs text-amber-800">시연은 실제 모델을 호출하지 않습니다. 일반 채팅의 의미 검증 성능을 입증하는 테스트가 아닙니다.</p></section></div></div></div>`;
}
async function sendMessage() {
  if (chatNeedsLogin()) { toast('왼쪽 아래에서 ChatGPT에 로그인하세요.'); return; }
  if (sending || detail.runs.some(r => r.status === 'running') || !draft.trim()) return;
  sending = true;
  try {
    const response = await api(`/sessions/${session.id}/messages`, 'POST', { content: draft, topics: [] });
    draft = ''; selectedRun = response.run_id || selectedRun;
    sending = false;
    await refresh();
    const stream = $('#chat-stream'); if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
  } catch (error) { sending = false; toast(error.message); render(); }
}
async function syncConnection() {
  if (syncTask) return syncTask;
  syncTask = (async () => {
    const previous = state?.auth?.activeClientId, next = await api('/state');
    if (next.build_id && next.build_id !== CLIENT_BUILD_ID) {
      sessionStorage.setItem('contextpulse.languageDraft', JSON.stringify({ projectId: project?.project.id, sessionId: session?.id, draft, topics, contextTab, editor, selectedRun, inspectorMode }));
      location.reload(); return;
    }
    state = next;
    if (previous !== state.auth.activeClientId) { models.delete('chatgpt'); modelErrors.delete('chatgpt'); }
    renderShell();
    if (pageName === 'settings') { renderOAuthCard(); showPlanWelcome(); }
    if (pageName === 'chat') {
      syncChatModelState();
      if (!models.has(state.settings.provider)) loadModelsForProvider().catch(error => toast(error.message));
    }
  })().finally(() => { syncTask = null; });
  return syncTask;
}
async function navigate(name) {
  pageName = name; if (name !== 'chat') contextPanelOpen = false; history.pushState(null, '', routePath(name));
  render(); await syncConnection();
  if (pageName === 'settings') showPlanWelcome();
  if (pageName === 'chat' && !models.has(state.settings.provider)) loadModelsForProvider().catch(error => toast(error.message));
}
async function source(messageId) {
  const message = await api(`/messages/${messageId}`);
  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-2xl w-[90vw]';
  dialog.innerHTML = `<h2 class="font-semibold mb-3">원문 메시지</h2><div class="message-body text-sm">${esc(message.content)}</div><p class="text-xs text-slate-500 mt-3">${esc(message.id)} · ${new Date(message.created_at).toLocaleString(DATE_LOCALE)}</p><div class="mt-4">${button('닫기', 'close-dialog')}</div>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
}
function projectDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-lg w-[90vw]';
  dialog.innerHTML = `<h2 class="font-semibold mb-4">프로젝트 선택</h2><div class="space-y-2">${state.projects.map(p => `<button data-action="choose-project" data-project="${p.id}" class="block w-full text-left p-3 rounded-lg border border-slate-200 text-sm">${esc(p.name)}</button>`).join('')}</div><form id="project-form" class="mt-4 flex gap-2"><input name="name" required maxlength="100" class="rounded border-slate-200 text-sm min-w-0" placeholder="새 프로젝트 이름"><button class="rounded bg-indigo-600 text-white px-3 py-2 text-sm">만들기</button></form><div class="mt-4">${button('닫기', 'close-dialog')}</div>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
}
async function download(path, filename) {
  const response = await fetch(`/api${path}`, { headers: { 'X-ContextPulse-Token': state.csrf, 'X-ContextPulse-Locale': LOCALE } });
  if (!response.ok) throw new Error('내보내기에 실패했습니다.');
  const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveSettings() {
  const provider = $('#provider-input').value;
  const previous = state.settings;
  const model = provider === state.settings.provider ? state.settings.model : provider === 'chatgpt' ? state.settings.chatgptModels?.[state.auth.activeClientId] || '' : '';
  const ollamaUrl = $('#ollama-url')?.value || state.settings.ollamaUrl;
  const apiKey = $('#api-key')?.value || '';
  state = await api('/settings', 'POST', { provider, model, ollamaUrl, apiKey, autoContext: $('#auto-context').checked });
  if (previous.provider !== provider || previous.ollamaUrl !== ollamaUrl || apiKey) { models.delete(provider); modelErrors.delete(provider); }
  toast('모델 설정을 저장했습니다.'); render();
}

document.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (event.target.id === 'chat-form') return await sendMessage();
    if (event.target.id === 'settings-form') return await saveSettings();
    if (event.target.id === 'context-form') {
      const submit = event.target.querySelector('button:not([data-action])');
      submit.disabled = true;
      try { await saveContextEditor(); } finally { submit.disabled = false; }
      return;
    }
    if (event.target.id === 'project-form') {
      const p = await api('/projects', 'POST', { name: new FormData(event.target).get('name') });
      event.target.closest('dialog').close(); state = await api('/state'); draft = ''; 
      await loadProject(p.id); navigate('chat');
    }
  } catch (error) { toast(error.message); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'chat-input') { draft = event.target.value; $('#char-count').textContent = `${draft.length}/4000`; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`; }
  if (event.target.id === 'context-search') { contextFilter = event.target.value; $('#context-list').innerHTML = contextListHtml(); }
  if (event.target.closest('#context-form') && editor) {
    if (event.target.name === 'topics') editor.topics = topicValues(event.target.value);
    else if (event.target.name) editor[event.target.name] = event.target.value;
  }
});
document.addEventListener('keydown', event => {
  if (event.target.id === 'chat-input' && !event.isComposing && event.keyCode !== 229 && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); sendMessage(); }
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'language-select') {
      const nextLocale = event.target.value;
      if (nextLocale !== LOCALE && ['en', 'ko'].includes(nextLocale)) {
        sessionStorage.setItem('contextpulse.languageDraft', JSON.stringify({ sessionId: session.id, projectId: project.project.id, draft, topics, contextTab, editor, selectedRun, inspectorMode }));
        location.assign(routePath(pageName, nextLocale));
      }
      return;
    }
    if (event.target.id === 'context-kind-filter') { contextKind = event.target.value; $('#context-list').innerHTML = contextListHtml(); }
    if (event.target.id === 'context-status-filter') { contextStatus = event.target.value; $('#context-list').innerHTML = contextListHtml(); }
    if (event.target.id === 'run-select') { selectedRun = event.target.value; compare = null; renderInspector(); }
    if (['compare-left', 'compare-right'].includes(event.target.id)) await loadComparison();
    if (event.target.id === 'provider-input') {
      $('#ollama-field').classList.toggle('hidden', event.target.value !== 'ollama' || state.mode === 'hosted');
      $('#api-key-field').classList.toggle('hidden', event.target.value !== 'openai');
    }
  } catch (error) { toast(error.message); }
});
document.addEventListener('click', async event => {
  if (event.target.closest('#sidebar-toggle')) {
    if ($('#app-sidebar').classList.contains('is-open')) closeSidebar(); else openSidebar();
    return;
  }
  if (event.target.closest('#sidebar-backdrop')) { closeSidebar(); return; }
  const brand = event.target.closest('#brand-link');
  if (brand) { event.preventDefault(); closeSidebar(); return navigate('chat'); }
  const conversation = event.target.closest('[data-session-id]');
  if (conversation) {
    const nextSessionId = conversation.dataset.sessionId;
    closeSidebar();
    if (nextSessionId !== session.id) {
      draft = ''; compare = null;
      await loadProject(project.project.id, nextSessionId);
    }
    return navigate('chat');
  }
  const nav = event.target.closest('[data-page]');
  if (nav) { closeSidebar(); return navigate(nav.dataset.page); }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  try {
    const action = target.dataset.action;
    if (action === 'toggle-context-panel' || action === 'close-context-panel') {
      contextPanelOpen = action === 'toggle-context-panel' ? !contextPanelOpen : false;
      $('#chat-context-backdrop')?.classList.toggle('is-open', contextPanelOpen);
      $('#chat-context-drawer')?.classList.toggle('is-open', contextPanelOpen);
      const drawer = $('#chat-context-drawer');
      if (drawer) { drawer.setAttribute('aria-hidden', String(!contextPanelOpen)); drawer.inert = !contextPanelOpen; }
      $('#context-panel-toggle')?.setAttribute('aria-expanded', String(contextPanelOpen));
      if (contextPanelOpen) $('#chat-context-drawer')?.querySelector('button, [href], input, select, textarea')?.focus();
      else $('#context-panel-toggle')?.focus();
      return;
    }
    if (['settings', 'contexts'].includes(action)) return navigate(action);
    if (action === 'open-model-picker') {
      const menu = $('#model-menu');
      if (menu) { menu.open = true; menu.querySelector('summary')?.focus(); }
      return;
    }
    if (action === 'model-select') {
      const model = target.dataset.model;
      if (!model || (!(models.get(state.settings.provider) || []).some(item => item.id === model) && model !== currentChatModel())) throw new Error('사용 가능한 모델 목록에서 선택하세요.');
      if (session.model_provider === state.settings.provider && model === session.model) { $('#model-menu').open = false; return; }
      const result = await api(`/sessions/${session.id}/model`, 'POST', { model });
      session = result.session; detail.session = session;
      renderChat(); syncChatModelState(); toast('이 대화의 모델을 변경했습니다.'); return;
    }
    if (action === 'models-refresh') return await loadModelsForProvider(state.settings.provider, true);
    if (['context-materials', 'context-candidates'].includes(action)) { contextTab = action.split('-')[1]; return navigate('contexts'); }
    if (action === 'analyze-context') {
      target.disabled = true;
      const result = await api(`/sessions/${session.id}/analyze-context`, 'POST', {});
      selectedRun = result.run_id; contextTab = 'materials'; await refresh(); navigate('contexts');
      const run = detail.runs.find(r => r.id === result.run_id);
      toast(run?.status === 'running' ? '사용자 발화와 모델 답변에서 맥락을 자동 등록하고 있습니다.' : run?.status === 'failed' ? run.error : run?.validation?.note || '자동 등록 결과를 반영했습니다.'); return;
    }
    if (action === 'review-candidate') {
      target.disabled = true;
      await api(`/context-candidates/${target.dataset.candidate}/review`, 'POST', { action: target.dataset.review });
      await refresh(); toast('컨텍스트 상태를 업데이트했습니다.'); return;
    }
    if (action === 'new-context') return newContext();
    if (action === 'edit-context') { editor = structuredClone(project.contexts.find(c => c.id === target.dataset.context)); return renderContexts(); }
    if (action === 'close-editor') { editor = null; return renderContexts(); }
        if (action === 'context-history') return contextHistory(target.dataset.context);
    if (action === 'archive-context') {
      await api(`/contexts/${target.dataset.context}/archive`, 'POST', { archived: target.dataset.archived === 'true' });
      if (editor?.id === target.dataset.context) editor = null;
      await refresh(); toast(target.dataset.archived === 'true' ? '보관했습니다. 다음 호출부터 자동으로 제외됩니다.' : '다시 사용할 수 있도록 복원했습니다.'); return;
    }
    if (action === 'context-override') {
      await api(`/sessions/${session.id}/context-selection`, 'POST', { context_id: target.dataset.context, mode: target.dataset.mode });
      await loadContextPreview(); renderChat(); toast('이 대화의 컨텍스트 선택을 저장했습니다.'); return;
    }
    if (action === 'inspect') { selectedRun = target.dataset.run; compare = null; return navigate('inspector'); }
    if (action === 'inspector-columns' || action === 'inspector-diff') { inspectorMode = action.endsWith('diff') ? 'diff' : 'columns'; return renderInspector(); }
    if (action === 'source') return source(target.dataset.message);
        if (action === 'close-dialog') return target.closest('dialog').close();
    if (action === 'choose-project') { target.closest('dialog').close(); draft = ''; editor = null; await loadProject(target.dataset.project); return navigate('chat'); }
    if (action === 'demo') { target.disabled = true; const demo = await api('/demo', 'POST', {}); state = await api('/state'); await loadProject(demo.project.id, demo.session.id); selectedRun = demo.run_id; inspectorMode = 'columns'; return navigate('inspector'); }
    if (action === 'login' || action === 'reauth') return await startOAuth(target);
    if (action === 'oauth-continue') {
      if (!oauthUrl) oauthUrl = (await api('/auth/resume', 'POST', {})).url;
      location.assign(oauthUrl); return;
    }
    if (action === 'oauth-cancel') {
      const result = await api('/auth/cancel', 'POST', {}); oauthAttempt = result.attempt;
      clearTimeout(oauthTimer); sessionStorage.removeItem('contextpulse.oauthAttempt'); oauthUrl = ''; oauthPopup?.close(); oauthPopup = null; renderOAuthCard(); return;
    }
    if (action === 'acknowledge-plan') {
      state = await api('/auth/acknowledge', 'POST', {}); $('#plan-welcome')?.remove(); return;
    }
    if (action === 'choose-account') {
      state = await api('/auth/select', 'POST', { client_id: target.dataset.client });
      models.delete('chatgpt'); modelErrors.delete('chatgpt'); render(); showPlanWelcome(); return;
    }
    if (action === 'disconnect') {
      target.disabled = true; state = await api('/auth/disconnect', 'POST', {});
      models.delete('chatgpt'); modelErrors.delete('chatgpt'); oauthAttempt = { status: 'idle' }; render(); toast(state.disconnect.message); return;
    }
    if (action === 'export-json') return download('/export', 'contextpulse-backup.json');
    if (action === 'export-sqlite') return download('/export/sqlite', 'contextpulse.sqlite');
    if (action === 'compare-previous') {
      const current = detail.runs.findIndex(r => r.id === selectedRun), previous = detail.runs[current + 1];
      if (!previous) throw new Error('이전 답변 기록이 없습니다.');
      const old = await api(`/runs/${previous.id}`), snapshot = old.snapshots.find(s => s.phase === 'correction') || old.snapshots.find(s => s.phase === 'generation') || old.snapshots.at(-1);
      if (!snapshot) throw new Error('이전 답변에 호출 기록이 없습니다.');
      $('#compare-left').insertAdjacentHTML('beforeend', `<option value="${old.id}|${snapshot.id}">이전 답변 · ${phaseLabel[snapshot.phase]}</option>`);
      $('#compare-left').value = `${old.id}|${snapshot.id}`; return loadComparison();
    }
  } catch (error) { target.disabled = false; toast(error.message); }
});
$('#project-switch').addEventListener('click', projectDialog);
$('#new-chat').addEventListener('click', async () => {
  try { closeSidebar(); const next = await api('/sessions', 'POST', { project_id: project.project.id }); draft = ''; compare = null; await loadProject(project.project.id, next.id); navigate('chat'); }
  catch (error) { toast(error.message); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (contextPanelOpen) {
      contextPanelOpen = false;
      $('#chat-context-backdrop')?.classList.remove('is-open'); $('#chat-context-drawer')?.classList.remove('is-open');
      const drawer = $('#chat-context-drawer'); if (drawer) { drawer.setAttribute('aria-hidden', 'true'); drawer.inert = true; }
      $('#context-panel-toggle')?.setAttribute('aria-expanded', 'false'); $('#context-panel-toggle')?.focus();
    }
    closeSidebar();
  }
});
window.addEventListener('resize', () => { if (window.innerWidth > 850) closeSidebar(); else syncSidebarAccessibility(); });
window.addEventListener('focus', () => { if (state && project) syncConnection().catch(error => toast(error.message)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state && project) syncConnection().catch(error => toast(error.message)); });
window.addEventListener('hashchange', () => {
  if (!project) return;
  const name = routeName();
  if (name !== pageName) { pageName = name; render(); }
});

window.addEventListener('popstate', async () => { pageName = routeName(); await syncConnection(); render(); });

async function init() {
  syncSidebarAccessibility();
  state = await api('/state');
  const preferred = localStorage.getItem('contextpulse.project');
  await loadProject(state.projects.find(p => p.id === preferred)?.id || state.projects[0].id);
  try {
    const saved = JSON.parse(sessionStorage.getItem('contextpulse.languageDraft') || 'null');
    sessionStorage.removeItem('contextpulse.languageDraft');
    if (saved?.sessionId === session.id && saved?.projectId === project.project.id) {
      draft = saved.draft; topics = saved.topics;
      contextTab = saved.contextTab; editor = saved.editor; selectedRun = saved.selectedRun; inspectorMode = saved.inspectorMode;
      await loadContextPreview();
    }
  } catch { /* Ignore an expired or invalid temporary draft. */ }
  render();
  const authStatus = await api('/auth/status'); oauthAttempt = authStatus.attempt;
  if (sessionStorage.getItem('contextpulse.oauthAttempt') && oauthAttempt.status === 'idle') { sessionStorage.removeItem('contextpulse.oauthAttempt'); toast('앱 재시작으로 로그인 요청이 종료됐습니다. 연결을 다시 시작하세요.'); }
  if (['connected', 'permission_required'].includes(oauthAttempt.status)) sessionStorage.removeItem('contextpulse.oauthAttempt');
  const authMessage = new URLSearchParams(location.search).get('auth') || (location.hash.includes('?auth=') ? decodeURIComponent(location.hash.split('?auth=')[1]) : '');
  if (authMessage) { toast(authMessage); history.replaceState(null, '', routePath(pageName)); }
  if (pageName === 'settings') { renderOAuthCard(); showPlanWelcome(); }
  if (pageName === 'chat') loadModelsForProvider().catch(error => toast(error.message));
  if (['pending', 'processing'].includes(oauthAttempt.status)) watchOAuth();
}
init().catch(error => { $('#view').textContent = `앱을 불러오지 못했습니다: ${error.message}`; });
