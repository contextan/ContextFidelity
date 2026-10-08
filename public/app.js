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
const phaseLabel = { selection: 'Select context for the question', extraction: 'Automatic conversation context registration', generation: 'Generate draft', validation: 'Validate', correction: 'Correct', revalidation: 'Revalidate' };
const statusLabel = { extracted: 'Automatic registration complete', running: 'Processing', corrected: 'Conflict corrected', consistent: 'Validation passed', uncertain: 'Uncertain', unresolved: 'Conflict unresolved', failed: 'Failed', no_decisions: 'No relevant context found' };
let state, project, session, detail, selectedRun = null, compare = null;
let pageName = routeName();
let topics = [], draft = '', sending = false, poll = null, toastTimer;
let inspectorMode = 'columns';
const models = new Map();
let oauthAttempt = { status: 'idle' }, oauthTimer = null, oauthUrl = '', oauthPopup = null, chatgptModelsState = '';
let modelsLoading = null, syncTask = null;
const kindLabel = { background: 'Background', reference: 'Reference', hypothesis: 'Hypothesis' };
const includeLabel = { auto: 'Select automatically', always: 'Always include in this project', off: 'Exclude by default' };
let contextPreview = { selected: [], excluded: [] }, contextTab = 'materials', contextFilter = '', contextStatus = 'active', contextKind = 'all', editor = null, previewSequence = 0;

async function api(path, method = 'GET', data) {
  const request = () => fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-ContextPulse-Locale': LOCALE, ...(state?.csrf ? { 'X-ContextPulse-Token': state.csrf } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  let response = await request(), result = await response.json();
  if (response.status === 403 && result.code === 'CSRF_RELOAD') {
    state = await (await fetch('/api/state', { headers: { 'X-ContextPulse-Locale': LOCALE } })).json();
    response = await request(); result = await response.json();
  }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
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
function demoNotice() { return `<div class="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs">Demo record · No model call · This fixed example demonstrates the correction flow.</div>`; }
function oauthCardHtml() {
  if (state.mode === 'hosted') return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">Public demo</h2><p class="text-sm text-slate-600">Conversations and credentials are isolated per visitor. Use demo mode or your own API key. ChatGPT OAuth is available in the local app.</p></section>`;
  const pending = ['pending', 'processing'].includes(oauthAttempt.status);
  const account = state.auth.accounts.find(a => a.active);
  const choices = models.get('chatgpt') || [];
  const savedModel = state.settings.provider === 'chatgpt' ? state.settings.model : '';
  const shownChoices = savedModel && !choices.some(m => m.id === savedModel) ? [{ id: savedModel, name: savedModel }, ...choices] : choices;
  const status = pending ? oauthAttempt.message : state.auth.chatgptConnected ? 'Account connected' : state.auth.signedIn ? 'Signed in · Plan permission required' : 'Account not connected';
  return `<section id="oauth-card" class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><div class="flex flex-wrap justify-between items-start gap-3"><div><h2 class="font-semibold">Connect your ChatGPT account</h2><p class="text-sm text-slate-500 mt-2">Use your ChatGPT plan for answers, validation, and context management in this app.</p></div>${pill(status, state.auth.chatgptConnected ? 'green' : pending ? 'amber' : 'slate')}</div><div class="flex flex-wrap gap-2 items-center"><button type="button" data-action="login" class="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm" ${pending ? 'disabled' : ''}>Continue with ChatGPT</button>${state.auth.accounts.length ? '<span class="text-xs text-slate-500">Add another account or workspace</span>' : ''}${state.auth.signedIn ? button('Disconnect', 'disconnect') : ''}<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-700 underline">Manage ChatGPT usage</a></div><p class="text-xs text-slate-500">Sign in and approve access in the official login window. Existing ChatGPT conversations are not imported.</p>
  ${pending ? `<div role="status" class="rounded-lg bg-indigo-50 border border-indigo-200 p-3 space-y-2"><p class="text-sm text-indigo-900">${esc(oauthAttempt.message)}</p><p class="text-xs text-indigo-700">The app checks your connection after approval. If the login window did not open, use the button below.</p><div class="flex flex-wrap gap-2">${button('Continue login in this tab', 'oauth-continue')}${oauthAttempt.status === 'pending' ? button('Cancel login', 'oauth-cancel') : ''}</div></div>` : ['failed', 'expired', 'cancelled', 'permission_required'].includes(oauthAttempt.status) ? `<p role="status" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">${esc(oauthAttempt.message)}</p>` : ''}
  ${state.auth.accounts.length ? `<div class="space-y-2">${state.auth.accounts.map(a => `<div class="p-3 rounded-lg border ${a.active ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200'} flex flex-wrap justify-between items-center gap-3"><div><p class="text-sm font-medium">${esc(a.label)}</p><p class="mt-1 text-xs text-slate-500">${a.active ? 'Active account · ' : ''}${!a.connected ? 'Reconnect required' : a.planEnabled ? 'ChatGPT plan access approved' : 'Plan permission required'}</p></div><div class="flex flex-wrap gap-2">${!a.active && a.connected ? button('Use this account', 'choose-account', `data-client="${esc(a.client_id)}" ${pending ? 'disabled' : ''}`) : ''}${button(a.connected && !a.planEnabled ? 'Approve plan access' : 'Reconnect', 'reauth', `data-client="${esc(a.client_id)}" data-consent="${a.connected && !a.planEnabled}" ${pending ? 'disabled' : ''}`)}</div></div>`).join('')}</div>` : ''}
  ${state.auth.chatgptConnected ? `<form id="oauth-model-form" class="border-t border-slate-200 pt-4 space-y-3"><label class="block text-sm">Model for this account<select id="oauth-model" required class="block w-full rounded-lg border-slate-200 mt-2 text-sm" ${shownChoices.length ? '' : 'disabled'}><option value="">Select a model</option>${shownChoices.map(m => `<option value="${esc(m.id)}" ${state.settings.provider === 'chatgpt' && state.settings.model === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label><p class="text-xs text-slate-500">${esc(chatgptModelsState || (savedModel ? 'You can chat with the saved model.' : 'Load the models available to this account.'))}</p><div class="flex flex-wrap gap-2"><button class="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm" ${shownChoices.length ? '' : 'disabled'}>Start chatting with this model</button>${button('Refresh models', 'oauth-models')}</div></form>` : account && !account.planEnabled ? '<p class="text-xs text-amber-900">This account cannot make model requests until plan access is approved.</p>' : ''}</section>`;
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
  chatgptModelsState = 'Checking available models.'; renderOAuthCard();
  try {
    const result = await api('/models', 'POST', { provider: 'chatgpt' });
    if (state.auth.activeClientId !== accountId) return;
    models.set('chatgpt', result.models);
    chatgptModelsState = result.models.length ? `${result.models.length} models available. Select a model.` : 'No models are available to this account. Check account permissions.';
  } catch (error) { if (state.auth.activeClientId !== accountId) return; models.delete('chatgpt'); chatgptModelsState = error.message; }
  renderOAuthCard();
}
function showPlanWelcome() {
  if (!state.auth.accounts.some(a => a.active && a.connected && a.welcomePending) || $('#plan-welcome')) return;
  const dialog = document.createElement('dialog'); dialog.id = 'plan-welcome';
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-lg w-[90vw]';
  dialog.innerHTML = `<h2 class="text-lg font-semibold">You are using your ChatGPT plan</h2><p class="text-sm text-slate-600 mt-3">Eligible model requests in this app use your connected ChatGPT plan. Context selection, extraction, validation, and correction also use additional requests.</p><a class="block mt-3 text-sm text-indigo-700 underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage ChatGPT usage</a><div class="mt-5">${button('Got it', 'acknowledge-plan')}</div>`;
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
      else { oauthUrl = ''; toast(oauthAttempt.message || 'The login attempt ended. Please reconnect.'); }
    } catch (error) { oauthAttempt = { status: 'failed', message: error.message }; renderOAuthCard(); }
  }, 1500);
}
async function startOAuth(target) {
  oauthPopup = window.open('', '_blank');
  if (oauthPopup) { oauthPopup.opener = null; oauthPopup.document.body.textContent = 'Opening the official ChatGPT login window.'; }
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
        toast(last.status === 'failed' ? last.ui_error || last.error : last.purpose === 'analysis' ? last.validation?.note : last.ui_warning || last.validation?.context_warning || 'Saved the answer and context for each call.');
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
  $('#sidebar-model').textContent = state.settings.model || 'Select a model';
  $('#sidebar-provider').textContent = { chatgpt: 'ChatGPT', openai: 'API', ollama: 'Local', demo: 'Demo' }[state.settings.provider];
  $('#workspace-name').textContent = project.project.name;
  $('#project-switch .sidebar-label').textContent = project.project.name;
  $('#header-topics').textContent = topics.length ? 'Auto topic: ' + topics.map(t => `#${t}`).join(' ') : 'Topics managed automatically';
  $('#connection-badge').textContent = state.settings.provider === 'demo' ? 'Demo mode' : state.settings.provider === 'chatgpt' ? state.auth.chatgptConnected ? state.settings.model ? 'ChatGPT connected' : 'Account connected · Select a model' : 'Model not connected' : state.settings.model ? 'Model selected' : 'No model selected';
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
    <div class="flex items-center justify-between text-xs text-slate-500"><span class="font-semibold ${ai ? 'text-indigo-900' : 'text-slate-900'}">${ai ? 'ContextPulse Assistant' : 'You'}</span><span>${time}</span></div>
    ${run ? `<div class="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg border ${['uncertain', 'unresolved'].includes(run.status) ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}">${pill(run.status === 'running' && run.assistant_message_id ? 'Answer checked · registering context' : statusLabel[run.status], run.status === 'corrected' || run.status === 'consistent' ? 'green' : 'amber')}${run.provider === 'demo' ? pill('Demo · No model call', 'amber') : ''}${button('View correction and context', 'inspect', `data-run="${esc(run.id)}"`)}</div>` : ''}
    <div class="p-4 rounded-xl ${ai ? 'bg-white border-2 border-indigo-200' : 'bg-slate-100 border border-slate-300'} shadow-sm"><div class="message-body">${esc(message.content)}</div></div>
    <div class="flex items-center justify-between gap-2">${run?.validation?.context_warning ? `<p class="text-xs text-amber-800">${esc(run.ui_warning || run.validation.context_warning)}</p>` : ''}${run?.validation?.note ? `<details class="text-xs text-slate-500"><summary>Validation note</summary><p class="mt-2">${esc(run.validation.note)}</p></details>` : ''}</div>
    ${run ? usedContextHtml(run) : ''}${run?.validation?.automatically_registered?.length ? `<p class="text-xs text-emerald-700">Context ${run.validation.automatically_registered.length} automatically registered · linked to originals</p>` : ''}
  </article>`;
}
function progressLabel() {
  const active = detail.runs.find(r => r.status === 'running');
  const phase = active?.progress?.phase;
  return phase ? `${phaseLabel[phase]} · ${active.progress.completed ? 'Completed' : 'In progress'}` : 'Preparing your answer.';
}
function usedContextHtml(run) {
  const used = run.context_usage;
  if (!used) return `<p class="text-xs text-slate-500">No preserved input is available for this answer.</p>`;
  const item = (value, label) => `<div class="p-3 bg-white rounded border border-slate-200 space-y-2"><div class="flex flex-wrap items-center gap-2 text-xs">${pill(label)}${value.version ? `<span>v${value.version}</span>` : ''}${value.title ? `<strong>${esc(value.title)}</strong>` : ''}${value.topics?.length ? `<span>${esc(value.topics.map(t => '#' + t).join(' '))}</span>` : ''}</div><p class="message-body text-sm">${esc(value.content)}</p>${value.selection_reason ? `<p class="text-xs text-slate-500">${esc(value.selection_reason)}</p>` : ''}${value.source_id ? button('View source', 'source', `data-message="${esc(value.source_id)}"`) : ''}</div>`;
  return `<section class="answer-context rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-3" data-context-run="${esc(run.id)}"><div class="flex flex-wrap gap-2 items-center justify-between"><h3 class="text-sm font-semibold text-indigo-900">Context sent for this answer</h3><span class="text-xs text-slate-500">${esc(used.model)} · ${phaseLabel[used.phase]}</span></div><div class="flex flex-wrap gap-2"><span class="text-xs text-slate-600">Topics inferred from this question:</span>${used.topics.map(t => pill(`#${t}`)).join('')}${pill(`Saved context ${used.contexts.length}`)}${pill(`Conversation context ${used.decisions.length}`)}${pill(`Earlier messages ${used.history.length}`)}</div>${used.decisions.length ? `<div class="space-y-1">${used.decisions.map(d => `<p class="text-xs text-indigo-900">${esc(d.content.length > 180 ? d.content.slice(0, 180) + '…' : d.content)} · v${d.version}</p>`).join('')}</div>` : ''}${used.contexts.length ? `<div class="flex flex-wrap gap-2">${used.contexts.map(c => `<span class="text-xs text-indigo-800">${esc(c.title)} · v${c.version}</span>`).join('')}</div>` : ''}<p class="text-xs text-slate-500">Frozen when this answer was generated. Later messages and newly saved context are excluded.</p><details><summary class="text-xs text-indigo-800 cursor-pointer">View contents and sources</summary><div class="space-y-2 mt-3">${used.current_question ? item(used.current_question, 'Question for this answer · not saved context') : ''}${used.contexts.map(c => item(c, kindLabel[c.kind] || 'Reference')).join('')}${used.decisions.map(d => item(d, 'Context identified from the conversation')).join('')}${used.history.map(h => item(h, h.role === 'user' ? 'Earlier user message' : 'Earlier answer')).join('')}${!used.contexts.length && !used.decisions.length && !used.history.length ? '<p class="text-sm text-slate-500">Only the current question was sent, with no additional context.</p>' : ''}</div></details>${button('Full input and comparison', 'inspect', `data-run="${esc(run.id)}"`)}</section>`;
}
function renderChat() {
  const busy = sending || detail.runs.some(r => r.status === 'running');
  const failed = detail.runs.filter(r => r.status === 'failed');
  $('#view').innerHTML = `<div class="bg-white border-b border-slate-200 px-4 py-2 flex flex-wrap gap-3 items-center justify-between"><select id="session-select" aria-label="Conversation" class="rounded border-slate-200 text-xs max-w-xs">${project.sessions.map(s => `<option value="${s.id}" ${s.id === session.id ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select><span class="text-xs text-slate-500">Conversation and actual model-input records are saved</span></div>
    <div class="grid grid-cols-1 xl:grid-cols-12 min-h-[calc(100vh-110px)]"><section class="xl:col-span-8 border-r border-slate-200 min-w-0 flex flex-col">
    <div id="chat-stream" class="px-4 md:px-6 py-6 flex flex-col gap-6 flex-1">
    ${detail.messages.length ? detail.messages.map(messageHtml).join('') : `<div class="py-8 space-y-3"><h2 class="text-xl font-semibold">Start chatting to manage context automatically</h2><p class="text-sm text-slate-500">Context is registered from user messages and assistant responses, then selected by topic. Assistant proposals remain hypotheses.</p><div class="flex gap-2">${button('Connect a model', 'settings')}</div></div>`}
    ${failed.map(r => `<div class="p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-800">Request failed: ${esc(r.ui_error || r.error)} ${button('View failed call', 'inspect', `data-run="${r.id}"`)}</div>`).join('')}
    ${busy ? '<div id="processing-status" role="status" class="p-3 rounded-lg bg-indigo-50 text-indigo-700 text-sm">'+ esc(progressLabel()) + '</div>' : ''}</div>
    <form id="chat-form" class="p-4 md:p-6 bg-white border-t border-slate-200 space-y-3">
    <p class="text-xs text-slate-500">The agent identifies the conversation topic, finds relevant context, and uses it in the response.</p>
    <textarea id="chat-input" aria-label="Message" maxlength="4000" rows="3" class="w-full rounded-lg border-slate-200 bg-slate-50 text-sm" placeholder="Type a message." ${busy ? 'disabled' : ''}>${esc(draft)}</textarea>
    <div class="flex justify-between items-center text-xs text-slate-500"><span>${state.settings.provider === 'chatgpt' && state.auth.chatgptConnected ? 'Using ChatGPT plan · <a class="text-indigo-700 underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a><br>' : ''}⌘ / Ctrl + Enter to send · Enter for a new line <span id="char-count">${draft.length}/4000</span></span><button class="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold" ${busy ? 'disabled' : ''}>Send</button></div></form></section>
    <aside class="xl:col-span-4 p-4 md:p-6 space-y-5 bg-slate-50">${chatContextPanel()}</aside></div>`;
}
function chatContextPanel() {
  const selected = contextPreview.selected;
  return `<div class="flex justify-between items-center gap-2"><h2 class="text-sm font-semibold">Context for this conversation</h2>${button('Manage', 'contexts')}</div><p class="text-xs text-slate-500">The agent selects topics and context for each question automatically. Below are saved materials for the latest answer topic.</p>
    ${lastSelectionHtml()}${candidatePanel(true)}<section class="space-y-3"><div class="flex justify-between text-xs font-medium text-slate-600"><span>Saved context for the latest topic</span><span>${selected.length}</span></div>${selected.map(item => `<div class="rounded-lg border border-indigo-200 bg-white p-3 space-y-2"><div class="flex justify-between gap-2"><span class="text-sm font-semibold">${esc(item.title)}</span>${pill(kindLabel[item.kind], item.kind === 'hypothesis' ? 'amber' : 'slate')}</div><p class="context-snippet text-xs text-slate-600">${esc(item.content)}</p><p class="text-xs text-indigo-600">${esc(item.selection_reason)} · v${item.version}</p><div class="flex gap-2">${button('Exclude from this conversation', 'context-override', `data-context="${item.id}" data-mode="exclude"`)}${item.override !== 'auto' ? button('Reset to automatic', 'context-override', `data-context="${item.id}" data-mode="auto"`) : ''}</div></div>`).join('') || '<div class="rounded-lg border border-dashed border-slate-300 p-4 text-xs text-slate-500">Useful context is registered from the conversation and selected for subsequent questions.</div>'}</section>
    <details class="text-xs text-slate-600"><summary>Excluded context ${contextPreview.excluded.length}</summary><div class="mt-3 space-y-3">${contextPreview.excluded.map(item => `<div class="rounded-lg border border-slate-200 bg-white p-3 space-y-2"><p class="font-semibold">${esc(item.title)}</p><p class="text-slate-500">${esc(item.selection_reason)}</p>${item.status === 'active' ? button('Include in this conversation', 'context-override', `data-context="${item.id}" data-mode="include"`) + (item.override !== 'auto' ? ' ' + button('Reset to automatic', 'context-override', `data-context="${item.id}" data-mode="auto"`) : '') : ''}</div>`).join('') || 'None'}</div></details>`;
}

function visibleContexts() {
  const query = contextFilter.trim().toLowerCase();
  return project.contexts.filter(item => (contextStatus === 'all' || item.status === contextStatus) && (contextKind === 'all' || item.kind === contextKind) && (!query || [item.title, item.content, ...item.topics].join(' ').toLowerCase().includes(query)));
}
function candidatePanel(compact = false) {
  const all = project.candidates.filter(c => c.status === 'accepted');
  const items = compact ? all.slice(0, 3) : all;
  return `<section class="space-y-3"><div class="flex justify-between items-center"><h2 class="text-sm font-semibold">Automatic registration history · ${all.length}</h2>${compact ? button('View all', 'context-candidates') : ''}</div><p class="text-xs text-slate-500">Context is automatically registered from user messages and assistant replies after checking the original text. Assistant suggestions remain hypotheses.</p>${items.map(item => `<article class="rounded-xl border border-emerald-200 bg-white p-4 space-y-3"><h3 class="text-sm font-semibold">${esc(item.title)}</h3>${pill(item.kind === 'decision' ? 'Context identified from the conversation' : kindLabel[item.kind])}<blockquote class="message-body border-l-2 border-slate-300 pl-3 text-sm">${esc(item.content)}</blockquote><p class="text-xs text-slate-500">${item.scope === 'project' ? 'Project-wide' : item.topics.map(t => '#' + esc(t)).join(' ')} · ${esc(new Date(item.created_at).toLocaleString(DATE_LOCALE))}</p><div class="flex gap-2">${button('View source', 'source', `data-message="${item.source_id}"`)}${button('Extraction input and result', 'inspect', `data-run="${item.run_id}"`)}</div></article>`).join('') || '<p class="text-xs text-slate-500">No context has been registered yet. Connect a model and chat to register context automatically.</p>'}</section>`;
}
function lastSelectionHtml() {
  const last = contextPreview.last_selection;
  if (!last) return '';
  return `<section class="p-4 rounded-xl border border-indigo-200 bg-white space-y-3"><h3 class="text-sm font-semibold">Context used in the latest answer</h3><p class="text-xs text-slate-500">${esc(last.question)} · ${last.mode === 'semantic' ? 'Selected by question meaning' : last.mode === 'tag_fallback' ? 'Automatic selection failed · Using tags' : 'Tag and manual selection'}</p>${last.items.map(item => `<div class="text-xs space-y-1"><p class="font-semibold">${esc(item.title)} · v${item.version}</p><p class="text-indigo-600">${esc(item.selection_reason)}</p></div>`).join('') || '<p class="text-xs text-slate-500">No reference context used</p>'}${button('Selection and actual model input', 'inspect', `data-run="${last.run_id}"`)}</section>`;
}
function contextListHtml() {
  const items = visibleContexts();
  return items.map(item => `<article class="bg-white border ${editor?.id === item.id ? 'border-indigo-300' : 'border-slate-200'} rounded-xl p-4 space-y-3"><div class="flex flex-wrap justify-between gap-2"><button type="button" data-action="edit-context" data-context="${item.id}" class="font-semibold text-sm text-left hover:text-indigo-700">${esc(item.title)}</button><div class="flex gap-1">${pill(kindLabel[item.kind], item.kind === 'hypothesis' ? 'amber' : 'slate')}${item.registration === 'automatic' ? pill('Automatically registered', 'green') : ''}${item.status === 'archived' ? pill('Archived') : ''}</div></div><p class="context-snippet text-sm text-slate-600">${esc(item.content)}</p><div class="flex flex-wrap gap-2 text-xs text-slate-500"><span>${item.scope === 'project' ? 'Project-wide' : item.topics.map(t => `#${esc(t)}`).join(' ')}</span><span>· ${includeLabel[item.include_mode]}</span><span>· v${item.version}</span></div><div class="flex flex-wrap gap-2">${button('Edit', 'edit-context', `data-context="${item.id}"`)}${button('Version history', 'context-history', `data-context="${item.id}"`)}${item.source_id ? button('Original message', 'source', `data-message="${item.source_id}"`) : ''}${button(item.status === 'archived' ? 'Restore' : 'Archive', 'archive-context', `data-context="${item.id}" data-archived="${item.status !== 'archived'}"`)}</div></article>`).join('') || `<div class="p-6 border border-dashed border-slate-300 rounded-xl text-sm text-slate-500">${project.contexts.length ? 'No context matches your search.' : 'No context yet. It is registered automatically as you chat.'}</div>`;
}
function renderContexts() {
  const tab = contextTab;
  $('#view').innerHTML = `<div class="p-4 md:p-6 space-y-5"><div class="flex flex-wrap justify-between gap-3 items-center"><div><h1 class="text-xl font-semibold">Context manager</h1><p class="text-sm text-slate-500 mt-2">${esc(project.project.name)} — review its background, references, and context identified from the conversation.</p></div><div class="flex flex-wrap gap-2">${button('New context', 'new-context')}</div></div>
  <div class="flex gap-5 border-b border-slate-200"><button type="button" data-action="context-materials" class="pb-3 text-sm ${tab === 'materials' ? 'border-b-2 border-indigo-600 text-indigo-700 font-semibold' : 'text-slate-500'}">Background, references, hypotheses ${project.contexts.filter(c => c.status === 'active').length}</button><button type="button" data-action="context-candidates" class="pb-3 text-sm ${tab === 'candidates' ? 'border-b-2 border-indigo-600 text-indigo-700 font-semibold' : 'text-slate-500'}">Automatic registration history ${project.candidates.filter(c => c.status === 'accepted').length}</button></div>
  ${tab === 'candidates' ? candidatePanel(false) : `<div class="grid grid-cols-1 xl:grid-cols-12 gap-5"><section class="xl:col-span-7 space-y-4"><div class="flex flex-wrap gap-2"><input id="context-search" aria-label="Search context" class="flex-1 min-w-0 rounded-lg border-slate-200 text-sm" placeholder="Search title, content, and topics" value="${esc(contextFilter)}"><select id="context-kind-filter" aria-label="Context type filter" class="rounded-lg border-slate-200 text-sm"><option value="all">All types</option>${Object.entries(kindLabel).map(([key, label]) => `<option value="${key}" ${contextKind === key ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="context-status-filter" aria-label="Context status filter" class="rounded-lg border-slate-200 text-sm">${[['active', 'Active'], ['archived', 'Archived'], ['all', 'All']].map(([key, label]) => `<option value="${key}" ${contextStatus === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div id="context-list" class="space-y-3">${contextListHtml()}</div></section><aside class="xl:col-span-5"><div class="context-editor">${contextEditorHtml()}</div></aside></div>`}</div>`;
}
function contextEditorHtml() {
  if (!editor) return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><h2 class="font-semibold">Use relevant context in answers</h2><p class="text-sm text-slate-500 leading-relaxed">Manage project background, references, and hypotheses separately. With automatic management enabled, the model compares each item with the question and selects relevant context.</p><p class="text-sm text-slate-500 leading-relaxed">You can include or exclude context in chat. Each answer shows which conversation context was actually sent to the model.</p>${project.contexts.length ? '<p class="text-xs text-indigo-600">Select an item to edit its content and scope.</p>' : button('Add your first context', 'new-context')}</section>`;
  const item = editor;
  return `<section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><div class="flex items-center justify-between"><h2 class="font-semibold">${item.id ? 'Edit context' : 'New context'}</h2>${item.id ? pill(`v${item.version}`) : ''}</div><form id="context-form" class="space-y-4"><label class="block text-xs text-slate-600">Title<input name="title" required maxlength="120" class="block w-full rounded-lg border-slate-200 text-sm mt-1" placeholder="Example: Target users and their problem" value="${esc(item.title)}"></label><label class="block text-xs text-slate-600">Type<select name="kind" class="block w-full rounded-lg border-slate-200 text-sm mt-1">${Object.entries(kindLabel).map(([key, label]) => `<option value="${key}" ${item.kind === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="block text-xs text-slate-600">Content<textarea name="content" required maxlength="30000" rows="8" class="block w-full rounded-lg border-slate-200 text-sm mt-1" placeholder="Add context needed for the answer.">${esc(item.content)}</textarea></label><div class="grid grid-cols-2 gap-3"><label class="block text-xs text-slate-600">Scope<select name="scope" class="block w-full rounded-lg border-slate-200 text-sm mt-1"><option value="project" ${item.scope === 'project' ? 'selected' : ''}>Project-wide</option><option value="topic" ${item.scope === 'topic' ? 'selected' : ''}>Selected topics</option></select></label><label class="block text-xs text-slate-600">Inclusion mode<select name="include_mode" class="block w-full rounded-lg border-slate-200 text-sm mt-1">${Object.entries(includeLabel).map(([key, label]) => `<option value="${key}" ${item.include_mode === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><label class="block text-xs text-slate-600">Topics<input name="topics" class="block w-full rounded-lg border-slate-200 text-sm mt-1" placeholder="Product, Evaluation · Separate with commas" value="${esc(item.topics.join(', '))}"></label><p class="text-xs text-slate-500">Hypotheses are not confirmed facts. ‘Always include’ applies to all conversations in this project.</p>${item.source_id ? '<p class="text-xs text-indigo-600">The original message is linked. Edits are saved as separate versions.</p>' : ''}<div class="flex gap-2"><button class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium">${item.id ? 'Save new version' : 'Save context'}</button>${button('Close', 'close-editor')}</div></form></section>`;
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
  await refresh(); toast(item.version > 1 ? 'Saved a new version. Past answer inputs are preserved.' : 'Context saved. It will be selected automatically when relevant to future answers.');
}
async function contextHistory(contextId) {
  const result = await api(`/contexts/${contextId}`);
  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-2xl w-[90vw] max-h-[85vh] overflow-auto';
  dialog.innerHTML = `<h2 class="font-semibold mb-4">${esc(result.context.title)} · Version history</h2><div class="space-y-4">${result.versions.map(item => `<div class="border-l-2 border-indigo-200 pl-4 space-y-2"><div class="flex gap-2 text-xs">${pill(`v${item.version}`)}${pill(item.status === 'active' ? 'Active' : item.status === 'archived' ? 'Archived' : 'Previous version')}<span class="text-slate-500">${new Date(item.created_at).toLocaleString(DATE_LOCALE)}</span></div><p class="font-semibold text-sm">${esc(item.title)}</p><p class="message-body text-sm text-slate-600">${esc(item.content)}</p><p class="text-xs text-slate-500">${kindLabel[item.kind]} · ${includeLabel[item.include_mode]} · ${item.scope === 'project' ? 'Project-wide' : esc(item.topics.join(', '))}</p></div>`).join('')}</div><div class="mt-5">${button('Close', 'close-dialog')}</div>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
}
async function renderInspector() {
  const runId = selectedRun || detail.runs[0]?.id;
  if (!runId) { $('#view').innerHTML = `<div class="p-6"><h1 class="text-xl font-semibold">Answer records</h1><p class="mt-3 text-slate-500">No call records yet. Connect a model and ask a question, or run the correction demo.</p><div class="mt-4">${button('Correction flow demo', 'demo')}</div></div>`; return; }
  const run = await api(`/runs/${runId}`);
  if (pageName !== 'inspector') return;
  selectedRun = runId;
  $('#view').innerHTML = `${run.provider === 'demo' ? demoNotice() : ''}<div class="p-4 md:p-6 space-y-4"><div class="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap justify-between gap-3"><div class="space-y-2"><h1 class="text-lg font-semibold">Actual context sent for each answer</h1><select id="run-select" aria-label="Select answer" class="text-xs rounded border-slate-200">${detail.runs.map(r => `<option value="${r.id}" ${r.id === run.id ? 'selected' : ''}>${esc(shortId(r.id))} · ${esc(statusLabel[r.status])}</option>`).join('')}</select> ${pill(run.status === 'running' && run.assistant_message_id ? 'Answer checked · registering context' : statusLabel[run.status], run.status === 'failed' ? 'red' : 'slate')}<p class="text-xs text-slate-500">These are preserved request inputs, not a measure of model attention or influence.</p></div><div class="flex gap-2 items-start">${button('View stages', 'inspector-columns')}${button('Compare inputs', 'inspector-diff')}</div></div>
  ${run.validation?.context_warning ? `<p class="p-3 rounded bg-amber-50 text-amber-900 text-sm">${esc(run.ui_warning || run.validation.context_warning)}</p>` : ''}
  ${run.error ? `<p class="p-3 rounded bg-rose-50 text-rose-800 text-sm">${esc(run.error)}<br>Failed calls preserve the prepared request body. Receipt by the provider is not guaranteed.</p>` : ''}
  ${inspectorMode === 'diff' ? compareControls(run) + '<div id="comparison-result"></div>' : `<div class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4 gap-4">${run.snapshots.map(snapshotCard).join('')}</div>`}
  <section class="bg-white border border-slate-200 rounded-lg p-4 space-y-3"><h2 class="font-semibold">Source evidence for this answer</h2><div class="space-y-2">${run.snapshots.flatMap(s => s.blocks.filter(b => b.source_id && (b.decision_id || b.context_id))).filter((b, i, all) => all.findIndex(x => x.source_id === b.source_id && x.version === b.version) === i).map(b => `<div class="flex flex-wrap gap-2 items-center text-xs"><span>${b.context_id ? 'Reference context' : 'Context identified from the conversation'} · v${b.version} · Source ${esc(shortId(b.source_id))}</span>${button('View source', 'source', `data-message="${esc(b.source_id)}"`)}</div>`).join('') || '<p class="text-sm text-slate-500">No linked original messages</p>'}</div></section></div>`;
  if (inspectorMode === 'diff' && run.snapshots.length >= 2) await loadComparison();
}
function snapshotCard(s) {
  const usage = s.usage?.input_tokens;
  return `<article class="bg-white border border-slate-200 rounded-lg overflow-hidden min-w-0"><div class="p-4 bg-slate-50 border-b border-slate-200 space-y-2"><h2 class="font-semibold">${s.ordinal + 1}. ${phaseLabel[s.phase]}</h2><div class="text-xs text-slate-500">${esc(s.model)} · ${s.latency_ms ?? '—'} ms</div>${pill(s.call_status === 'completed' ? 'Call completed' : s.call_status === 'failed' ? 'Call failed' : 'Calling model', s.call_status === 'failed' ? 'red' : 'slate')}<p class="text-xs text-slate-500">Input ${usage != null ? `${usage} tokens` : 'Tokens not measured'} · ${new TextEncoder().encode(s.payload).length} bytes</p></div><div class="p-4 space-y-4"><section><h3 class="text-sm font-semibold text-indigo-700 mb-2">[A] Actual request input</h3>${s.blocks.map(b => `<details class="mb-2 border border-slate-200 rounded p-2 text-xs"><summary class="font-medium text-slate-700">${esc(b.key)}${b.version ? ` · v${b.version}` : ''}</summary><div class="message-body mt-2 text-slate-600">${esc(b.content)}</div></details>`).join('')}<details class="mt-2"><summary class="text-xs text-indigo-700">RAW · Full request body</summary>${raw(JSON.parse(s.payload))}</details></section><section><h3 class="text-sm font-semibold text-emerald-700 mb-2">[B] Result</h3><div class="message-body text-sm text-slate-700">${esc(s.output || s.call_error || 'Processing')}</div></section><details><summary class="text-xs text-slate-500">Call metadata</summary>${raw({ id: s.id, run_id: s.run_id, phase: s.phase, endpoint: s.endpoint, model: s.model, usage: s.usage, hash: s.hash, created_at: s.created_at, latency_ms: s.latency_ms })}</details><details><summary class="text-xs text-slate-500">Excluded answer-context candidates · Not the request body</summary>${raw(s.excluded)}</details></div></article>`;
}
function compareControls(run) {
  const options = (value) => run.snapshots.map(s => `<option value="${run.id}|${s.id}" ${s.id === value ? 'selected' : ''}>${phaseLabel[s.phase]} · ${shortId(run.id)}</option>`).join('');
  const left = compare?.left || run.snapshots.find(s => s.phase === 'generation')?.id || run.snapshots[0]?.id;
  const right = compare?.right || run.snapshots.find(s => s.phase === 'correction')?.id || run.snapshots.find(s => s.phase === 'generation')?.id || run.snapshots.at(-1)?.id;
  return `<div class="bg-white border border-slate-200 rounded-lg p-4 space-y-3"><p class="text-sm font-semibold">Select two calls to compare</p><div class="flex flex-wrap gap-2"><select id="compare-left" aria-label="Baseline call" class="text-xs rounded border-slate-200">${options(left)}</select><span>→</span><select id="compare-right" aria-label="Comparison call" class="text-xs rounded border-slate-200">${options(right)}</select>${button('Compare with the previous answer', 'compare-previous')}</div><p class="text-xs text-slate-500">Compare shared, added, removed, and changed blocks. Calls may have different input structures and purposes.</p></div>`;
}
async function loadComparison() {
  if (!$('#compare-left') || !$('#compare-right')) return;
  const [leftRun, left] = $('#compare-left').value.split('|'), [rightRun, right] = $('#compare-right').value.split('|');
  if (!left || !right) return;
  const result = await api(`/compare?${new URLSearchParams({ leftRun, rightRun, left, right })}`);
  compare = { left, right };
  $('#comparison-result').innerHTML = `<div class="bg-white border border-slate-200 rounded-lg p-4 space-y-4"><div class="flex flex-wrap gap-2">${pill(`Shared ${result.common.length}`)}${pill(`Added ${result.added.length}`, 'green')}${pill(`Removed ${result.removed.length}`, 'red')}${pill(`Changed ${result.changed.length}`, 'amber')}</div><p class="text-xs text-slate-500">Full body ${result.left_bytes} → ${result.right_bytes} bytes. ${esc(result.note)}</p>${result.added.map(b => `<details class="p-3 rounded bg-emerald-50 border border-emerald-200"><summary class="text-sm text-emerald-800">+ ${esc(b.key)}</summary><pre class="text-xs mt-2">${esc(b.content)}</pre></details>`).join('')}${result.removed.map(b => `<details class="p-3 rounded bg-rose-50 border border-rose-200"><summary class="text-sm text-rose-800">− ${esc(b.key)}</summary><pre class="text-xs mt-2">${esc(b.content)}</pre></details>`).join('')}${result.changed.map(b => `<details class="p-3 rounded bg-amber-50 border border-amber-200"><summary class="text-sm text-amber-800">Changed ${esc(b.key)}</summary><pre class="text-xs mt-2">Before:\n${esc(b.before.content)}\n\nAfter:\n${esc(b.after.content)}</pre></details>`).join('')}<details class="p-3 border border-slate-200 rounded"><summary class="text-sm">Shared blocks</summary>${raw(result.common)}</details></div>`;
}
function renderSettings() {
  const s = state.settings;
  $('#view').innerHTML = `<div class="p-4 md:p-6 space-y-5"><div class="bg-white border border-slate-200 rounded-xl p-5"><h1 class="text-xl font-semibold">Settings</h1><p class="mt-3 text-sm text-slate-600">Conversations and actual model-input records are kept in server storage. Connecting a cloud model sends selected inputs to that provider. Validation and correction use additional calls.</p></div>${oauthCardHtml()}<div class="grid grid-cols-1 xl:grid-cols-2 gap-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-4"><h2 class="font-semibold">Connect a model</h2>
  <form id="settings-form" class="space-y-3"><label class="block text-sm">Connection type<select id="provider-input" class="block mt-1 w-full rounded border-slate-200 text-sm">${[['chatgpt', 'ChatGPT OAuth'], ['openai', 'OpenAI API key'], ['ollama', 'Local model · Ollama / Gemma'], ['demo', 'Demo · No model call']].filter(([id]) => !state.capabilities || state.capabilities.providers.includes(id)).map(([id, name]) => `<option value="${id}" ${s.provider === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label id="manual-model-field" class="block text-sm ${s.provider === 'chatgpt' ? 'hidden' : ''}">Model ID<input id="model-input" class="block mt-1 w-full rounded border-slate-200 text-sm" value="${esc(s.model)}" list="model-choices" placeholder="Connect and load available models"><datalist id="model-choices">${(models.get(s.provider) || []).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</datalist></label><label class="block text-sm ${state.mode === 'hosted' ? 'hidden' : ''}">Local model URL<input id="ollama-url" class="block mt-1 w-full rounded border-slate-200 text-sm" value="${esc(s.ollamaUrl)}"></label><label class="block text-sm">OpenAI API key <span class="text-xs text-slate-500">${state.auth.apiKeySet ? 'Saved · Leave blank to keep' : 'Not configured'}</span><input id="api-key" type="password" autocomplete="off" class="block mt-1 w-full rounded border-slate-200 text-sm" placeholder="Enter only to save a new key"></label><label class="flex gap-2 items-center text-sm"><input id="auto-context" type="checkbox" ${s.autoContext ? 'checked' : ''}>Automatically register and select conversation context</label><p class="text-xs text-slate-500">A connected model makes up to two additional calls for context selection and registration. Context is registered from user messages and assistant replies. Assistant suggestions are hypotheses. Context from the current question is applied immediately; context extracted from an answer is used in later answers.</p><div class="flex gap-2"><button class="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm">Save settings</button><span id="manual-model-check" class="${s.provider === 'chatgpt' ? 'hidden' : ''}">${button('Load models and check connection', 'models')}</span></div><p id="model-list-result" class="text-xs text-slate-500"></p></form><p class="text-xs text-slate-500">Credentials stay in server-only files and are excluded from call records and exports. API keys in the public demo are encrypted at rest.</p></section>
  <div class="space-y-5"><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">Storage and export</h2><p class="text-sm text-slate-600">Storage ${(state.storage_bytes / 1024).toFixed(1)} KB · Projects ${state.projects.length}</p><div class="flex flex-wrap gap-2">${button('Download all records as JSON', 'export-json')}${button('Download SQLite database', 'export-sqlite')}</div><p class="text-xs text-slate-500">Includes original conversations; excludes credentials. Import and deletion are not available yet.</p></section><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">Validation policy</h2><p class="text-sm text-slate-600">At most one correction · One revalidation<br>Check source quotes before correction<br>Separate project scopes<br>Preserve inputs without overwriting</p><p class="text-xs text-slate-500">Insufficient evidence or invalid validation output is marked uncertain. Conflicts that remain after revalidation are marked unresolved.</p></section><section class="bg-white border border-slate-200 rounded-xl p-5 space-y-3"><h2 class="font-semibold">Correction flow demo</h2><p class="text-sm text-slate-600">A separate demo project shows a draft that conflicts with conversation context, followed by source review, correction, and revalidation.</p>${button('Create a demo project', 'demo')}<p class="text-xs text-amber-800">The demo makes no model calls. It does not establish semantic validation accuracy in ordinary chats.</p></section></div></div></div>`;
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
  dialog.innerHTML = `<h2 class="font-semibold mb-3">Original message</h2><div class="message-body text-sm">${esc(message.content)}</div><p class="text-xs text-slate-500 mt-3">${esc(message.id)} · ${new Date(message.created_at).toLocaleString(DATE_LOCALE)}</p><div class="mt-4">${button('Close', 'close-dialog')}</div>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
}
function projectDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-xl border border-slate-200 shadow-xl p-6 max-w-lg w-[90vw]';
  dialog.innerHTML = `<h2 class="font-semibold mb-4">Select project</h2><div class="space-y-2">${state.projects.map(p => `<button data-action="choose-project" data-project="${p.id}" class="block w-full text-left p-3 rounded-lg border border-slate-200 text-sm">${esc(p.name)}</button>`).join('')}</div><form id="project-form" class="mt-4 flex gap-2"><input name="name" required maxlength="100" class="rounded border-slate-200 text-sm min-w-0" placeholder="New project name"><button class="rounded bg-indigo-600 text-white px-3 py-2 text-sm">Create</button></form><div class="mt-4">${button('Close', 'close-dialog')}</div>`;
  document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
}
async function download(path, filename) {
  const response = await fetch(`/api${path}`, { headers: { 'X-ContextPulse-Token': state.csrf, 'X-ContextPulse-Locale': LOCALE } });
  if (!response.ok) throw new Error('Export failed.');
  const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveSettings() {
  state = await api('/settings', 'POST', { provider: $('#provider-input').value, model: $('#provider-input').value === 'chatgpt' ? state.settings.provider === 'chatgpt' ? state.settings.model : '' : $('#model-input').value, ollamaUrl: $('#ollama-url').value, apiKey: $('#api-key').value, autoContext: $('#auto-context').checked });
  toast('Saved model settings.'); render();
}

document.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (event.target.id === 'chat-form') return await sendMessage();
    if (event.target.id === 'oauth-model-form') {
      const model = $('#oauth-model').value;
      if (!model || (!(models.get('chatgpt') || []).some(m => m.id === model) && model !== state.settings.model)) throw new Error('Select a model available to this account.');
      state = await api('/settings', 'POST', { ...state.settings, provider: 'chatgpt', model });
      toast('Connected your ChatGPT account and selected model.'); return navigate('chat');
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
      toast(run?.status === 'running' ? 'Automatically registering context from user messages and assistant responses.' : run?.status === 'failed' ? run.error : run?.validation?.note || 'Automatic context registration is complete.'); return;
    }
    if (action === 'review-candidate') {
      target.disabled = true;
      await api(`/context-candidates/${target.dataset.candidate}/review`, 'POST', { action: target.dataset.review });
      await refresh(); toast('Context status updated.'); return;
    }
    if (action === 'new-context') return newContext();
    if (action === 'edit-context') { editor = structuredClone(project.contexts.find(c => c.id === target.dataset.context)); return renderContexts(); }
    if (action === 'close-editor') { editor = null; return renderContexts(); }
        if (action === 'context-history') return contextHistory(target.dataset.context);
    if (action === 'archive-context') {
      await api(`/contexts/${target.dataset.context}/archive`, 'POST', { archived: target.dataset.archived === 'true' });
      if (editor?.id === target.dataset.context) editor = null;
      await refresh(); toast(target.dataset.archived === 'true' ? 'Archived. Automatically excluded from future calls.' : 'Restored for future use.'); return;
    }
    if (action === 'context-override') {
      await api(`/sessions/${session.id}/context-selection`, 'POST', { context_id: target.dataset.context, mode: target.dataset.mode });
      await loadContextPreview(); renderChat(); toast('Saved context choices for this conversation.'); return;
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
      $('#model-list-result').textContent = `${result.models.length} models available. Select one and save settings.`; target.disabled = false; return;
    }
    if (action === 'export-json') return download('/export', 'contextpulse-backup.json');
    if (action === 'export-sqlite') return download('/export/sqlite', 'contextpulse.sqlite');
    if (action === 'compare-previous') {
      const current = detail.runs.findIndex(r => r.id === selectedRun), previous = detail.runs[current + 1];
      if (!previous) throw new Error('No previous answer record.');
      const old = await api(`/runs/${previous.id}`), snapshot = old.snapshots.find(s => s.phase === 'correction') || old.snapshots.find(s => s.phase === 'generation') || old.snapshots.at(-1);
      if (!snapshot) throw new Error('The previous answer has no call records.');
      $('#compare-left').insertAdjacentHTML('beforeend', `<option value="${old.id}|${snapshot.id}">Previous answer · ${phaseLabel[snapshot.phase]}</option>`);
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
  if (sessionStorage.getItem('contextpulse.oauthAttempt') && oauthAttempt.status === 'idle') { sessionStorage.removeItem('contextpulse.oauthAttempt'); toast('The login attempt ended when the app restarted. Start connecting again.'); }
  if (['connected', 'permission_required'].includes(oauthAttempt.status)) sessionStorage.removeItem('contextpulse.oauthAttempt');
  const authMessage = new URLSearchParams(location.search).get('auth') || (location.hash.includes('?auth=') ? decodeURIComponent(location.hash.split('?auth=')[1]) : '');
  if (authMessage) { toast(authMessage); history.replaceState(null, '', routePath(pageName)); }
  if (pageName === 'settings') { renderOAuthCard(); showPlanWelcome(); if (state.auth.chatgptConnected) loadChatGPTModels(); }
  if (['pending', 'processing'].includes(oauthAttempt.status)) watchOAuth();
}
init().catch(error => { $('#view').textContent = `Could not load the app: ${error.message}`; });
