export function buildRequest(settings, instructions, blocks) {
  const text = blocks.map(b => `[${b.key}]\n${b.content}`).join('\n\n');
  if (settings.provider === 'ollama') return { provider: 'ollama', locale: settings.locale, model: settings.model, endpoint: `${settings.ollamaUrl}/api/chat`, payload: { model: settings.model, stream: false, messages: [{ role: 'system', content: instructions }, { role: 'user', content: text }] } };
  const payload = { model: settings.model, instructions, input: [{ role: 'user', content: text }], store: false, stream: true };
  const effort = normalizeReasoningEffort(settings.model, settings.reasoningEffort);
  if (effort) payload.reasoning = { effort };
  if (supportedReasoningEfforts(settings.model).length && ['low', 'medium', 'high'].includes(settings.verbosity)) payload.text = { verbosity: settings.verbosity };
  return { provider: settings.provider, locale: settings.locale, accountClientId: settings.accountClientId, model: settings.model, endpoint: 'https://api.openai.com/v1/responses', payload };
}

export function supportedReasoningEfforts(model, advertised = null) {
  if (Array.isArray(advertised)) return advertised.filter(value => ['low', 'medium', 'high', 'xhigh'].includes(value));
  const id = String(model || '').toLowerCase();
  if (/^gpt-6(?:[.-]|$)/.test(id)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^gpt-5-pro(?:$|-)/.test(id)) return ['high'];
  if (/^gpt-5\.1-codex-max(?:$|-)/.test(id)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^gpt-5\.1(?:$|-)/.test(id)) return ['low', 'medium', 'high'];
  if (/^gpt-5(?:$|[.-])/.test(id) || /^o[1-9](?:$|[.-])/.test(id)) return ['low', 'medium', 'high'];
  return [];
}

export function normalizeReasoningEffort(model, effort, advertised = null) {
  if (!effort || effort === 'auto') return null;
  const allowed = supportedReasoningEfforts(model, advertised);
  if (allowed.includes(effort)) return effort;
  return allowed.includes('medium') ? 'medium' : allowed[0] || null;
}

export function providerError(status, body, requestId, locale = 'ko') {
  const clean = value => typeof value === 'string' ? value.replace(/Bearer\s+\S+|\bsk-[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').slice(0, 1200) : null;
  const code = clean(body?.error?.code), param = clean(body?.error?.param);
  const detail = clean(body?.detail || body?.error?.message || (typeof body?.error === 'string' ? body.error : ''));
  const reason = status === 429 ? locale === 'en' ? 'Usage limit reached. Check ChatGPT usage.' : '사용량 한도에 도달했습니다. 사용량을 확인하세요.'
    : status >= 500 ? locale === 'en' ? 'The model service is temporarily unavailable. Your connection is retained.' : '모델 서비스의 일시적인 장애입니다. 연결은 유지됩니다.'
    : locale === 'en' ? 'Check the selected account, model, and permissions.' : '선택한 계정·모델·권한을 확인하세요.';
  const message = `${locale === 'en' ? 'Model request failed' : '모델 요청 실패'} (${status}). ${reason}${code ? ` [${code}]` : ''}${detail ? ` ${detail}` : ''}${requestId ? ` (Request ID: ${clean(requestId)})` : ''}`;
  const error = new Error(message);
  error.code = code; error.requestId = clean(requestId);
  error.details = { http_status: status, code, param, detail, request_id: error.requestId, shape: body?.detail ? 'detail' : body?.error ? 'error' : 'unknown' };
  return error;
}
async function httpFailure(response, locale) {
  let body = {}; try { body = await response.json(); } catch {}
  return providerError(response.status, body, response.headers.get('x-request-id'), locale);
}

export class Provider {
  constructor(auth, fetcher = fetch) { this.auth = auth; this.fetcher = fetcher; }
  async headers(kind, clientId) {
    const token = kind === 'chatgpt' ? await this.auth.accessToken(clientId) : this.auth.value.apiKey;
    if (!token) throw new Error('설정에서 모델 인증을 연결하세요.');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }
  async models(settings) {
    if (settings.provider === 'demo') return [{ id: 'context-demo', name: '교정 흐름 시연 · 모델 호출 없음' }];
    const local = settings.provider === 'ollama';
    const response = await this.fetcher(local ? `${settings.ollamaUrl}/api/tags` : 'https://api.openai.com/v1/models', { headers: local ? {} : await this.headers(settings.provider, settings.accountClientId), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw await httpFailure(response, settings.locale);
    const data = await response.json();
    if (local) return (data.models || []).map(m => ({ id: m.name, name: m.name }));
    if (data.models) return data.models.filter(m => m.visibility === 'list').map(m => ({ id: m.slug, name: m.display_name || m.slug, ...(Array.isArray(m.supported_reasoning_efforts) ? { reasoning_efforts: m.supported_reasoning_efforts } : Array.isArray(m.reasoning_efforts) ? { reasoning_efforts: m.reasoning_efforts } : {}) }));
    return (data.data || []).map(m => ({ id: m.id, name: m.id }));
  }
  async call(request, serializedPayload) {
    const start = Date.now();
    const response = await this.fetcher(request.endpoint, { method: 'POST', headers: request.provider === 'ollama' ? { 'Content-Type': 'application/json' } : await this.headers(request.provider, request.accountClientId), body: serializedPayload, signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw await httpFailure(response, request.locale);
    if (request.provider === 'ollama') {
      const data = await response.json();
      if (data.error || data.done !== true || !data.message?.content?.trim()) throw new Error('로컬 모델 응답이 완료되지 않았습니다.');
      return { text: data.message.content, usage: { input_tokens: data.prompt_eval_count ?? null, output_tokens: data.eval_count ?? null }, latency: Date.now() - start };
    }
    let buffer = '', text = '', completed = false, usage = null;
    const decoder = new TextDecoder();
    const consume = (event) => {
      const raw = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!raw || raw === '[DONE]') return;
      const data = JSON.parse(raw);
      if (data.type === 'response.output_text.delta') text += data.delta || '';
      if (['response.failed', 'response.incomplete', 'error'].includes(data.type)) throw providerError(data.response?.error?.code?.includes('limit') ? 429 : 400, { error: data.response?.error || data.error || { code: data.code, message: data.message || data.response?.incomplete_details?.reason || data.type } }, response.headers.get('x-request-id'), request.locale);
      if (data.type === 'response.completed') {
        completed = true; usage = data.response?.usage || null;
        if (!text) text = (data.response?.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
      }
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!completed || !text.trim()) throw new Error('완료 이벤트 없는 응답입니다. 검증된 답변으로 처리하지 않았습니다.');
    return { text, usage, latency: Date.now() - start };
  }
}
