const CLIENT_BUILD_ID = '05e57ab8cc37';
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
let inspectorMode = 'columns';
const models = new Map();
let oauthAttempt = { status: 'idle' }, oauthTimer = null, oauthUrl = '', oauthPopup = null, chatgptModelsState = '';
let modelsLoading = null, syncTask = null;
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
function pill(text, color = 'slate') { return `<span class="px-2 py-0.5 rounded border text-xs ${color === 'green' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : color === 'red' ? 'bg-rose-50 border-rose-200 text-rose-800' : color === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-600'}">${esc(text)}</span>`; }
function raw(value) { return `<pre class="bg-slate-900 text-indigo-200 rounded-lg p-3 text-xs overflow-auto max-h-[600px]">${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`; }
function topicValues(value) { return [...new Set(value.split(/[,，]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 12); }
function demoNotice() { return `<div class="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs">시연 기록 · 실제 모델 호출 없음 · 고정된 사례로 교정 흐름을 확인합니다.</div>`; }
function oauthCardHtml() {
  if (state.mode === 'hosted') return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">공개 데모</h2><p class="text-sm text-slate-600">방문자별로 대화와 인증 정보를 분리합니다. 시연 모드 또는 본인의 API 키로 사용할 수 있습니다. ChatGPT OAuth는 로컬 앱에서 제공합니다.</p></section>`;
  const pending = ['pending', 'processing'].includes(oauthAttempt.status);
  const account = state.auth.accounts.find(a => a.active);
  const choices = models.get('chatgpt') || [];
  const savedModel = state.settings.provider === 'chatgpt' ? state.settings.model : '';
  const shownChoices = savedModel && !choices.some(m => m.id === savedModel) ? [{ id: savedModel, name: savedModel }, ...choices] : choices;
  const status = pending ? oauthAttempt.message : state.auth.chatgptConnected ? '계정 연결 완료' : state.auth.signedIn ? '로그인 완료 · 플랜 사용 권한 필요' : '계정 미연결';
  return `<section id="oauth-card" class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><div class="flex flex-wrap justify-between items-start gap-3"><div><h2 class="font-semibold">ChatGPT 계정 연결</h2><p class="text-sm text-slate-500 mt-2">ChatGPT 플랜을 이 앱의 답변 생성·검증·컨텍스트 관리에 사용합니다.</p></div>${pill(status, state.auth.chatgptConnected ? 'green' : pending ? 'amber' : 'slate')}</div><div class="flex flex-wrap gap-2 items-center"><button type="button" data-action="login" class="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm" ${pending ? 'disabled' : ''}>Continue with ChatGPT</button>${state.auth.accounts.length ? '<span class="text-xs text-slate-500">다른 계정이나 워크스페이스 추가</span>' : ''}${state.auth.signedIn ? button('연결 해제', 'disconnect') : ''}<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-700 underline">ChatGPT 사용량 관리</a></div><p class="text-xs text-slate-500">공식 로그인 창에서 인증과 권한을 승인합니다. 기존 ChatGPT 대화 기록은 가져오지 않습니다.</p>
  ${pending ? `<div role="status" class="rounded-lg bg-indigo-50 border border-indigo-200 p-3 space-y-2"><p class="text-sm text-indigo-900">${esc(oauthAttempt.message)}</p><p class="text-xs text-indigo-700">승인 후 자동으로 연결 상태를 확인합니다. 로그인 창이 열리지 않으면 아래 버튼을 사용하세요.</p><div class="flex flex-wrap gap-2">${button('이 탭에서 로그인 계속', 'oauth-continue')}${oauthAttempt.status === 'pending' ? button('로그인 취소', 'oauth-cancel') : ''}</div></div>` : ['failed', 'expired', 'cancelled', 'permission_required'].includes(oauthAttempt.status) ? `<p role="status" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">${esc(oauthAttempt.message)}</p>` : ''}
  ${state.auth.accounts.length ? `<div class="space-y-2">${state.auth.accounts.map(a => `<div class="p-3 rounded-lg border ${a.active ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200'} flex flex-wrap justify-between items-center gap-3"><div><p class="text-sm font-medium">${esc(a.label)}</p><p class="mt-1 text-xs text-slate-500">${a.active ? '현재 계정 · ' : ''}${!a.connected ? '재연결 필요' : a.planEnabled ? 'ChatGPT 플랜 사용 권한 승인됨' : '플랜 사용 권한 필요'}</p></div><div class="flex flex-wrap gap-2">${!a.active && a.connected ? button('이 계정 사용', 'choose-account', `data-client="${esc(a.client_id)}" ${pending ? 'disabled' : ''}`) : ''}${button(a.connected && !a.planEnabled ? '플랜 사용 권한 승인' : '다시 연결', 'reauth', `data-client="${esc(a.client_id)}" data-consent="${a.connected && !a.planEnabled}" ${pending ? 'disabled' : ''}`)}</div></div>`).join('')}</div>` : ''}
  ${state.auth.chatgptConnected ? `<form id="oauth-model-form" class="border-t border-slate-200 pt-4 space-y-3"><label class="block text-sm">이 계정에서 사용할 모델<select id="oauth-model" required class="block w-full rounded-lg border-slate-200 mt-2 text-sm" ${shownChoices.length ? '' : 'disabled'}><option value="">모델을 선택하세요</option>${shownChoices.map(m => `<option value="${esc(m.id)}" ${state.settings.provider === 'chatgpt' && state.settings.model === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label><p class="text-xs text-slate-500">${esc(chatgptModelsState || (savedModel ? '저장된 모델로 채팅할 수 있습니다.' : '계정에서 사용할 수 있는 모델 목록을 불러오세요.'))}</p><div class="flex flex-wrap gap-2"><button class="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm" ${shownChoices.length ? '' : 'disabled'}>이 모델로 채팅 시작</button>${button('모델 목록 새로고침', 'oauth-models')}</div></form>` : account && !account.planEnabled ? '<p class="text-xs text-amber-900">플랜 사용 권한이 승인되기 전에는 이 계정으로 모델을 호출하지 않습니다.</p>' : ''}</section>`;
}
function renderOAuthCard() { const card = $('#oauth-card'); if (card) card.outerHTML = oauthCardHtml(); }
async function loadChatGPTModels(force = false) {
  if (modelsLoading?.accountId === state.auth.activeClientId) return modelsLoading.promise;
  if (!force && models.has('chatgpt')) { renderOAuthCard(); return; }
  const loading = { accountId: state.auth.activeClientId };
  loading.promise = fetchChatGPTModels().finally(() => { if (modelsLoading === loading) modelsLoading = null; });
  modelsLoading = loading; return loading.promise;
}
async function fetchChatGPTModels() {
  if (!state.auth.chatgptConnected) return;
  const accountId = state.auth.activeClientId;
  chatgptModelsState = '사용 가능한 모델을 확인하고 있습니다.'; renderOAuthCard();
  try {
    const result = await api('/models', 'POST', { provider: 'chatgpt' });
    if (state.auth.activeClientId !== accountId) return;
    models.set('chatgpt', result.models);
    chatgptModelsState = result.models.length ? `${result.models.length}개 모델 확인. 사용할 모델을 선택하세요.` : '이 계정에서 사용할 수 있는 모델이 없습니다. 계정 권한을 확인하세요.';
  } catch (error) { if (state.auth.activeClientId !== accountId) return; models.delete('chatgpt'); chatgptModelsState = error.message; }
  renderOAuthCard();
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
  state = await api('/state'); models.delete('chatgpt'); chatgptModelsState = '';
  sessionStorage.removeItem('contextpulse.oauthAttempt');
  await navigate(state.settings.model && state.auth.chatgptConnected ? 'chat' : 'settings');
  if (oauthPopup && !oauthPopup.closed) oauthPopup.close(); oauthPopup = null;
  toast(oauthAttempt.message);
  showPlanWelcome(); await loadChatGPTModels();
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
function renderShell() {
  $('#brand-link').href = routePath('chat');
  $('#language-switch').href = routePath(pageName, LOCALE === 'ko' ? 'en' : 'ko');
  $('#language-switch').textContent = LOCALE === 'ko' ? 'English' : String.fromCodePoint(0xd55c, 0xad6d, 0xc5b4);
  $('#sidebar-model').textContent = state.settings.model || '모델 선택 필요';
  $('#sidebar-provider').textContent = { chatgpt: 'ChatGPT', openai: 'API', ollama: '로컬', demo: '시연' }[state.settings.provider];
  $('#workspace-name').textContent = project.project.name;
  $('#project-switch .sidebar-label').textContent = project.project.name;
  $('#header-topics').textContent = topics.length ? '자동 주제: ' + topics.map(t => `#${t}`).join(' ') : '주제 자동 관리';
  $('#connection-badge').textContent = state.settings.provider === 'demo' ? '시연 모드' : state.settings.provider === 'chatgpt' ? state.auth.chatgptConnected ? state.settings.model ? 'ChatGPT 연결됨' : '계정 연결됨 · 모델 선택 필요' : '모델 미연결' : state.settings.model ? '모델 선택됨' : '모델 미선택';
  document.querySelectorAll('[data-page]').forEach(el => {
    const active = el.dataset.page === pageName;
    el.classList.toggle('bg-indigo-50', active); el.classList.toggle('text-indigo-700', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
}
function render() {
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
  const time = new Date(message.created_at).toLocaleTimeString(DATE_LOCALE, { hour: '2-digit', minute: '2-digit' });
  return `<article id="${esc(message.id)}" class="flex flex-col gap-2 w-full">
    <div class="flex items-center justify-between text-xs text-slate-500"><span class="font-semibold ${ai ? 'text-indigo-900' : 'text-slate-900'}">${ai ? 'ContextPulse Assistant' : '나'}</span><span>${time}</span></div>
    ${run ? `<div class="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg border ${['uncertain', 'unresolved'].includes(run.status) ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}">${pill(run.status === 'running' && run.assistant_message_id ? '검증 완료 · 맥락 자동 등록 중' : statusLabel[run.status], run.status === 'corrected' || run.status === 'consistent' ? 'green' : 'amber')}${run.provider === 'demo' ? pill('시연 · 모델 호출 없음', 'amber') : ''}${button('교정 과정·컨텍스트 보기', 'inspect', `data-run="${esc(run.id)}"`)}</div>` : ''}
    <div class="p-4 rounded-xl ${ai ? 'bg-white border-2 border-indigo-200' : 'bg-slate-100 border border-slate-300'} shadow-sm"><div class="message-body">${esc(message.content)}</div></div>
    <div class="flex items-center justify-between gap-2">${run?.validation?.context_warning ? `<p class="text-xs text-amber-800">${esc(run.ui_warning || run.validation.context_warning)}</p>` : ''}${run?.validation?.note ? `<details class="text-xs text-slate-500"><summary>검증 메모</summary><p class="mt-2">${esc(run.validation.note)}</p></details>` : ''}</div>
    ${run ? usedContextHtml(run) : ''}${run?.validation?.automatically_registered?.length ? `<p class="text-xs text-emerald-700">맥락 ${run.validation.automatically_registered.length}개 자동 등록 · 원문과 함께 관리</p>` : ''}
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
  return `<section class="answer-context rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-3" data-context-run="${esc(run.id)}"><div class="flex flex-wrap gap-2 items-center justify-between"><h3 class="text-sm font-semibold text-indigo-900">이번 답변에 전달한 컨텍스트</h3><span class="text-xs text-slate-500">${esc(used.model)} · ${phaseLabel[used.phase]}</span></div><div class="flex flex-wrap gap-2"><span class="text-xs text-slate-600">질문에서 추론한 주제:</span>${used.topics.map(t => pill(`#${t}`)).join('')}${pill(`저장 맥락 ${used.contexts.length}개`)}${pill(`대화 맥락 ${used.decisions.length}개`)}${pill(`이전 대화 ${used.history.length}개`)}</div>${used.decisions.length ? `<div class="space-y-1">${used.decisions.map(d => `<p class="text-xs text-indigo-900">${esc(d.content.length > 180 ? d.content.slice(0, 180) + '…' : d.content)} · v${d.version}</p>`).join('')}</div>` : ''}${used.contexts.length ? `<div class="flex flex-wrap gap-2">${used.contexts.map(c => `<span class="text-xs text-indigo-800">${esc(c.title)} · v${c.version}</span>`).join('')}</div>` : ''}<p class="text-xs text-slate-500">이 답변을 만들 때의 기록입니다. 이후 대화나 새로 저장된 맥락은 포함하지 않습니다.</p><details><summary class="text-xs text-indigo-800 cursor-pointer">내용과 원문 확인</summary><div class="space-y-2 mt-3">${used.current_question ? item(used.current_question, '이 답변의 질문 · 저장 맥락 아님') : ''}${used.contexts.map(c => item(c, kindLabel[c.kind] || '참고 자료')).join('')}${used.decisions.map(d => item(d, '사용자 대화에서 파악한 내용')).join('')}${used.history.map(h => item(h, h.role === 'user' ? '이전 사용자 발화' : '이전 답변')).join('')}${!used.contexts.length && !used.decisions.length && !used.history.length ? '<p class="text-sm text-slate-500">추가 맥락 없이 현재 질문만 전달했습니다.</p>' : ''}</div></details>${button('전체 전달 기록·비교', 'inspect', `data-run="${esc(run.id)}"`)}</section>`;
}
function renderChat() {
  const busy = sending || detail.runs.some(r => r.status === 'running');
  const failed = detail.runs.filter(r => r.status === 'failed');
  $('#view').innerHTML = `<div class="bg-white border-b border-slate-200 px-4 py-2 flex flex-wrap gap-3 items-center justify-between"><select id="session-select" aria-label="대화 선택" class="rounded border-slate-200 text-xs max-w-xs">${project.sessions.map(s => `<option value="${s.id}" ${s.id === session.id ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select><span class="text-xs text-slate-500">대화와 실제 전달 기록을 저장</span></div>
    <div class="grid grid-cols-1 xl:grid-cols-12 min-h-[calc(100vh-110px)]"><section class="xl:col-span-8 border-r border-slate-200 min-w-0 flex flex-col">
    <div id="chat-stream" class="px-4 md:px-6 py-6 flex flex-col gap-6 flex-1">
    ${detail.messages.length ? detail.messages.map(messageHtml).join('') : `<div class="py-8 space-y-3"><h2 class="text-xl font-semibold">대화를 시작하면 맥락을 자동으로 관리합니다</h2><p class="text-sm text-slate-500">사용자 발화와 모델 답변에서 필요한 맥락을 등록하고 주제별로 선택합니다. 모델 제안은 가설로 구분합니다.</p><div class="flex gap-2">${button('모델 연결', 'settings')}</div></div>`}
    ${failed.map(r => `<div class="p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-800">처리 실패: ${esc(r.ui_error || r.error)} ${button('실패 호출 기록', 'inspect', `data-run="${r.id}"`)}</div>`).join('')}
    ${busy ? '<div id="processing-status" role="status" class="p-3 rounded-lg bg-indigo-50 text-indigo-700 text-sm">'+ esc(progressLabel()) + '</div>' : ''}</div>
    <form id="chat-form" class="p-4 md:p-6 bg-white border-t border-slate-200 space-y-3">
    <p class="text-xs text-slate-500">대화 주제를 파악하고 관련 컨텍스트를 자동으로 찾아 답변에 반영합니다.</p>
    <textarea id="chat-input" aria-label="메시지" maxlength="4000" rows="3" class="w-full rounded-lg border-slate-200 bg-slate-50 text-sm" placeholder="메시지를 입력하세요." ${busy ? 'disabled' : ''}>${esc(draft)}</textarea>
    <div class="flex justify-between items-center text-xs text-slate-500"><span>${state.settings.provider === 'chatgpt' && state.auth.chatgptConnected ? 'ChatGPT 플랜 사용 · <a class="text-indigo-700 underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">사용량 관리</a><br>' : ''}⌘ / Ctrl + Enter 전송 · Enter 줄바꿈 <span id="char-count">${draft.length}/4000</span></span><button class="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold" ${busy ? 'disabled' : ''}>보내기</button></div></form></section>
    <aside class="xl:col-span-4 p-4 md:p-6 space-y-5 bg-slate-50">${chatContextPanel()}</aside></div>`;
}
function chatContextPanel() {
  const selected = contextPreview.selected;
  return `<div class="flex justify-between items-center gap-2"><h2 class="text-sm font-semibold">이번 대화의 컨텍스트</h2>${button('관리', 'contexts')}</div><p class="text-xs text-slate-500">질문마다 에이전트가 주제와 맥락을 자동으로 선택합니다. 아래에는 마지막 답변의 주제에 해당하는 저장 맥락을 표시합니다.</p>
    ${lastSelectionHtml()}${candidatePanel(true)}<section class="space-y-3"><div class="flex justify-between text-xs font-medium text-slate-600"><span>마지막 주제의 저장 맥락</span><span>${selected.length}개</span></div>${selected.map(item => `<div class="rounded-lg border border-indigo-200 bg-white p-3 space-y-2"><div class="flex justify-between gap-2"><span class="text-sm font-semibold">${esc(item.title)}</span>${pill(kindLabel[item.kind], item.kind === 'hypothesis' ? 'amber' : 'slate')}</div><p class="context-snippet text-xs text-slate-600">${esc(item.content)}</p><p class="text-xs text-indigo-600">${esc(item.selection_reason)} · v${item.version}</p><div class="flex gap-2">${button('이 대화에서 제외', 'context-override', `data-context="${item.id}" data-mode="exclude"`)}${item.override !== 'auto' ? button('자동 선택으로 복원', 'context-override', `data-context="${item.id}" data-mode="auto"`) : ''}</div></div>`).join('') || '<div class="rounded-lg border border-dashed border-slate-300 p-4 text-xs text-slate-500">대화에서 유용한 맥락을 자동 등록하고 다음 질문에 맞춰 선택합니다.</div>'}</section>
    <details class="text-xs text-slate-600"><summary>제외된 맥락 ${contextPreview.excluded.length}개</summary><div class="mt-3 space-y-3">${contextPreview.excluded.map(item => `<div class="rounded-lg border border-slate-200 bg-white p-3 space-y-2"><p class="font-semibold">${esc(item.title)}</p><p class="text-slate-500">${esc(item.selection_reason)}</p>${item.status === 'active' ? button('이 대화에 포함', 'context-override', `data-context="${item.id}" data-mode="include"`) + (item.override !== 'auto' ? ' ' + button('자동 선택으로 복원', 'context-override', `data-context="${item.id}" data-mode="auto"`) : '') : ''}</div>`).join('') || '없음'}</div></details>`;
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
  const left = compare?.left || run.snapshots.find(s => s.phase === 'generation')?.id || run.snapshots[0]?.id;
  const right = compare?.right || run.snapshots.find(s => s.phase === 'correction')?.id || run.snapshots.find(s => s.phase === 'generation')?.id || run.snapshots.at(-1)?.id;
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
  $('#view').innerHTML = `<div class="p-4 md:p-6 space-y-5"><div class="bg-white border border-slate-200 rounded-xl p-5"><h1 class="text-xl font-semibold">설정</h1><p class="mt-3 text-sm text-slate-600">대화와 실제 전달 기록은 서버 저장소에 보존합니다. 클라우드 모델을 연결하면 선택한 입력이 해당 모델 제공자에게 전송됩니다. 검증과 교정은 추가 호출을 사용합니다.</p></div>${oauthCardHtml()}<div class="grid grid-cols-1 xl:grid-cols-2 gap-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><h2 class="font-semibold">모델 연결</h2>
  <form id="settings-form" class="space-y-3"><label class="block text-sm">연결 방식<select id="provider-input" class="block mt-1 w-full rounded border-slate-200 text-sm">${[['chatgpt', 'ChatGPT OAuth'], ['openai', 'OpenAI API 키'], ['ollama', '로컬 모델 · Ollama / Gemma'], ['demo', '시연 · 모델 호출 없음']].filter(([id]) => !state.capabilities || state.capabilities.providers.includes(id)).map(([id, name]) => `<option value="${id}" ${s.provider === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label id="manual-model-field" class="block text-sm ${s.provider === 'chatgpt' ? 'hidden' : ''}">모델 ID<input id="model-input" class="block mt-1 w-full rounded border-slate-200 text-sm" value="${esc(s.model)}" list="model-choices" placeholder="연결 후 모델 목록을 불러오세요"><datalist id="model-choices">${(models.get(s.provider) || []).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</datalist></label><label class="block text-sm ${state.mode === 'hosted' ? 'hidden' : ''}">로컬 모델 주소<input id="ollama-url" class="block mt-1 w-full rounded border-slate-200 text-sm" value="${esc(s.ollamaUrl)}"></label><label class="block text-sm">OpenAI API 키 <span class="text-xs text-slate-500">${state.auth.apiKeySet ? '등록됨 · 빈칸은 유지' : '미등록'}</span><input id="api-key" type="password" autocomplete="off" class="block mt-1 w-full rounded border-slate-200 text-sm" placeholder="새 키를 등록할 때만 입력"></label><label class="flex gap-2 items-center text-sm"><input id="auto-context" type="checkbox" ${s.autoContext ? 'checked' : ''}>대화 맥락 자동 등록·질문별 의미 선택</label><p class="text-xs text-slate-500">실제 모델 연결 시 선택·자동 등록에 최대 2회 추가 호출합니다. 사용자 원문과 모델 답변에서 맥락을 자동 등록합니다. 모델 제안은 검토 중인 가설로 분류합니다. 현재 질문에서 파악한 내용은 바로 반영하고, 답변에서 찾은 맥락은 다음 답변부터 사용합니다.</p><div class="flex gap-2"><button class="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm">설정 저장</button><span id="manual-model-check" class="${s.provider === 'chatgpt' ? 'hidden' : ''}">${button('모델 목록·연결 확인', 'models')}</span></div><p id="model-list-result" class="text-xs text-slate-500"></p></form><p class="text-xs text-slate-500">인증 정보는 서버 전용 파일에 저장하며 호출 기록·내보내기에 포함하지 않습니다. 공개 데모의 API 키는 암호화해 저장합니다.</p></section>
  <div class="space-y-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">저장소와 내보내기</h2><p class="text-sm text-slate-600">저장 용량 ${(state.storage_bytes / 1024).toFixed(1)} KB · 프로젝트 ${state.projects.length}개</p><div class="flex flex-wrap gap-2">${button('전체 기록 JSON 다운로드', 'export-json')}${button('실제 SQLite 다운로드', 'export-sqlite')}</div><p class="text-xs text-slate-500">대화 원문이 포함됩니다. 인증 정보는 제외합니다. 기록 삭제·가져오기는 아직 제공하지 않습니다.</p></section><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">검증 정책</h2><p class="text-sm text-slate-600">교정 최대 1회 · 재검증 1회<br>원문 인용 확인 후 교정<br>프로젝트 범위 분리<br>호출 당시 입력은 수정·덮어쓰기 금지</p><p class="text-xs text-slate-500">근거가 부족하거나 검증 응답이 올바르지 않으면 판단 보류로 표시합니다. 재검증 후에도 충돌하면 미해결로 남깁니다.</p></section><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">교정 흐름 시연</h2><p class="text-sm text-slate-600">별도 시연 프로젝트에서 대화의 맥락과 어긋난 초안 → 원문 확인 → 답변 수정 → 재검증을 확인합니다.</p>${button('새 시연 프로젝트 만들기', 'demo')}<p class="text-xs text-amber-800">시연은 실제 모델을 호출하지 않습니다. 일반 채팅의 의미 검증 성능을 입증하는 테스트가 아닙니다.</p></section></div></div></div>`;
}
async function sendMessage() {
  if (sending || detail.runs.some(r => r.status === 'running') || !draft.trim()) return;
  sending = true;
  try {
    const response = await api(`/sessions/${session.id}/messages`, 'POST', { content: draft, topics: [] });
    draft = ''; selectedRun = response.run_id || selectedRun;
    sending = false;
    await refresh();
    $('#chat-stream')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    if (previous !== state.auth.activeClientId) { models.delete('chatgpt'); chatgptModelsState = ''; }
    renderShell();
    if (pageName === 'settings') { renderOAuthCard(); showPlanWelcome(); loadChatGPTModels().catch(error => toast(error.message)); }
  })().finally(() => { syncTask = null; });
  return syncTask;
}
async function navigate(name) {
  pageName = name; history.pushState(null, '', routePath(name));
  render(); await syncConnection();
  if (pageName === 'settings') { showPlanWelcome(); await loadChatGPTModels(); }
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
  state = await api('/settings', 'POST', { provider: $('#provider-input').value, model: $('#provider-input').value === 'chatgpt' ? state.settings.provider === 'chatgpt' ? state.settings.model : '' : $('#model-input').value, ollamaUrl: $('#ollama-url').value, apiKey: $('#api-key').value, autoContext: $('#auto-context').checked });
  toast('모델 설정을 저장했습니다.'); render();
}

document.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (event.target.id === 'chat-form') return await sendMessage();
    if (event.target.id === 'oauth-model-form') {
      const model = $('#oauth-model').value;
      if (!model || (!(models.get('chatgpt') || []).some(m => m.id === model) && model !== state.settings.model)) throw new Error('계정에서 사용할 수 있는 모델을 선택하세요.');
      state = await api('/settings', 'POST', { ...state.settings, provider: 'chatgpt', model });
      toast('ChatGPT 계정과 선택한 모델로 연결했습니다.'); return navigate('chat');
    }
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
  if (event.target.id === 'chat-input') { draft = event.target.value; $('#char-count').textContent = `${draft.length}/4000`; }
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
    if (event.target.id === 'context-kind-filter') { contextKind = event.target.value; $('#context-list').innerHTML = contextListHtml(); }
    if (event.target.id === 'context-status-filter') { contextStatus = event.target.value; $('#context-list').innerHTML = contextListHtml(); }
    if (event.target.id === 'session-select') { draft = ''; await loadProject(project.project.id, event.target.value); render(); }
    if (event.target.id === 'run-select') { selectedRun = event.target.value; compare = null; renderInspector(); }
    if (['compare-left', 'compare-right'].includes(event.target.id)) await loadComparison();
    if (event.target.id === 'provider-input') {
      $('#manual-model-field').classList.toggle('hidden', event.target.value === 'chatgpt');
      $('#manual-model-check').classList.toggle('hidden', event.target.value === 'chatgpt');
      $('#model-input').value = event.target.value === 'demo' ? 'context-demo' : '';
      $('#model-choices').innerHTML = (models.get(event.target.value) || []).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    }
  } catch (error) { toast(error.message); }
});
document.addEventListener('click', async event => {
  if (event.target.closest('#language-switch')) {
    event.preventDefault();
    sessionStorage.setItem('contextpulse.languageDraft', JSON.stringify({ sessionId: session.id, projectId: project.project.id, draft, topics, contextTab, editor, selectedRun, inspectorMode }));
    location.assign(routePath(pageName, LOCALE === 'ko' ? 'en' : 'ko')); return;
  }
  const brand = event.target.closest('#brand-link');
  if (brand) { event.preventDefault(); return navigate('chat'); }
  const nav = event.target.closest('[data-page]');
  if (nav) return navigate(nav.dataset.page);
  const target = event.target.closest('[data-action]');
  if (!target) return;
  try {
    const action = target.dataset.action;
    if (['settings', 'contexts'].includes(action)) return navigate(action);
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
    if (action === 'oauth-models') return await loadChatGPTModels(true);
    if (action === 'choose-account') {
      state = await api('/auth/select', 'POST', { client_id: target.dataset.client });
      models.delete('chatgpt'); chatgptModelsState = ''; render(); showPlanWelcome(); await loadChatGPTModels(); return;
    }
    if (action === 'disconnect') {
      target.disabled = true; state = await api('/auth/disconnect', 'POST', {});
      models.delete('chatgpt'); oauthAttempt = { status: 'idle' }; render(); toast(state.disconnect.message); return;
    }
    if (action === 'models') {
      target.disabled = true;
      const provider = $('#provider-input').value;
      if (provider === 'openai' && $('#api-key').value.trim()) {
        state = await api('/settings', 'POST', { provider, model: $('#model-input').value, ollamaUrl: $('#ollama-url').value, apiKey: $('#api-key').value, autoContext: $('#auto-context').checked });
        $('#api-key').value = '';
      }
      const result = await api('/models', 'POST', { provider, ollamaUrl: $('#ollama-url').value });
      models.set(provider, result.models);
      $('#model-choices').innerHTML = result.models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      if (!$('#model-input').value && result.models.length) $('#model-input').value = result.models[0].id;
      $('#model-list-result').textContent = `${result.models.length}개 모델 확인. 모델을 선택하고 설정을 저장하세요.`; target.disabled = false; return;
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
  try { const next = await api('/sessions', 'POST', { project_id: project.project.id }); draft = ''; await loadProject(project.project.id, next.id); navigate('chat'); }
  catch (error) { toast(error.message); }
});
window.addEventListener('focus', () => { if (state && project) syncConnection().catch(error => toast(error.message)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state && project) syncConnection().catch(error => toast(error.message)); });
window.addEventListener('hashchange', () => {
  if (!project) return;
  const name = routeName();
  if (name !== pageName) { pageName = name; render(); }
});

window.addEventListener('popstate', async () => { pageName = routeName(); await syncConnection(); render(); });

async function init() {
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
  if (pageName === 'settings') { renderOAuthCard(); showPlanWelcome(); if (state.auth.chatgptConnected) loadChatGPTModels(); }
  if (['pending', 'processing'].includes(oauthAttempt.status)) watchOAuth();
}
init().catch(error => { $('#view').textContent = `앱을 불러오지 못했습니다: ${error.message}`; });
