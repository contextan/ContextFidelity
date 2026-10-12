import { randomBytes, randomUUID, createHash, createPublicKey, verify, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export class Auth {
  constructor(directory, origin, fetcher = fetch, encryptionKey = null) {
    this.path = join(directory, 'credentials.json');
    this.encryptionKey = encryptionKey;
    this.origin = origin;
    this.fetcher = fetcher;
    this.pending = new Map();
    this.attempts = new Map();
    this.refreshes = new Map();
    this.signingOut = new Set();
    this.value = existsSync(this.path) ? this.decode(readFileSync(this.path, 'utf8')) : { host_id: `urn:uuid:${randomUUID()}`, accounts: [], active: null, apiKey: '' };
    this.save();
  }
  decode(text) {
    const value = JSON.parse(text);
    if (!this.encryptionKey) return value;
    if (value.format !== 'aes-256-gcm-v1') throw new Error('Hosted credentials must be encrypted');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString());
  }
  save() {
    const temporary = `${this.path}.tmp`;
    let value = this.value;
    if (this.encryptionKey) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      value = { format: 'aes-256-gcm-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    }
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
  publicStatus() {
    const account = this.account();
    const hasCredentials = value => !!(value?.access_token || value?.refresh_token);
    return { accounts: this.value.accounts.map(a => ({ client_id: a.client_id, email: a.email || 'ChatGPT 계정', label: a.label, active: this.value.active === a.client_id, connected: hasCredentials(a), canForget: !hasCredentials(a), planEnabled: this.planEnabled(a), welcomePending: this.planEnabled(a) && !a.welcome_confirmed })), chatgptConnected: hasCredentials(account) && this.planEnabled(account), signedIn: hasCredentials(account), activeClientId: account?.client_id || null, apiKeySet: !!this.value.apiKey };
  }
  planEnabled(account = this.account()) { return !!account?.scope?.split(' ').includes('chatgpt.tokens.use.direct'); }
  status(browserSession) {
    const attempt = this.attempts.get(browserSession);
    if (!attempt) return { status: 'idle' };
    if (attempt.status === 'pending' && attempt.expires < Date.now()) { attempt.status = 'expired'; attempt.message = '로그인 요청이 만료됐습니다. 다시 연결하세요.'; this.pending.delete(attempt.state); }
    return { id: attempt.id, status: attempt.status, message: attempt.message, expires_at: new Date(attempt.expires).toISOString() };
  }
  cancel(browserSession) {
    const attempt = this.attempts.get(browserSession);
    if (attempt?.status === 'processing') throw new Error('인증을 확인 중입니다. 결과를 기다려주세요.');
    if (attempt?.status === 'pending') { attempt.status = 'cancelled'; attempt.message = '로그인 요청을 취소했습니다.'; this.pending.delete(attempt.state); }
    return this.status(browserSession);
  }
  acknowledge() { const account = this.account(); if (account && this.planEnabled(account)) { account.welcome_confirmed = true; this.save(); } }
  account() { return this.value.accounts.find(a => a.client_id === this.value.active); }
  select(clientId) {
    if (!this.value.accounts.some(a => a.client_id === clientId)) throw new Error('저장된 계정을 찾을 수 없습니다.');
    const account = this.value.accounts.find(a => a.client_id === clientId);
    if (!account.access_token && !account.refresh_token) throw new Error('이 계정은 다시 연결해야 합니다.');
    this.value.active = clientId; this.save();
  }
  forgetDisconnected(clientId) {
    const account = this.value.accounts.find(a => a.client_id === clientId);
    if (!account) throw new Error('저장된 연결 정보를 찾을 수 없습니다.');
    if (account.access_token || account.refresh_token) throw new Error('사용 가능한 토큰이 남아 있는 연결은 제거할 수 없습니다.');
    this.value.accounts = this.value.accounts.filter(a => a.client_id !== clientId);
    if (this.value.active === clientId) this.value.active = null;
    this.save();
  }
  async disconnect() {
    const account = this.account();
    if (!account) return { remoteRevoked: true, message: '연결된 계정이 없습니다.' };
    this.signingOut.add(account.client_id);
    let revoked = !account.refresh_token;
    try {
      await this.refreshes.get(account.client_id)?.catch(() => {});
      if (account.refresh_token) {
        const metadata = await this.fetcher('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(10_000) });
        if (!metadata.ok) throw new Error('로그아웃 설정 조회 실패');
        const endpoint = new URL((await metadata.json()).revocation_endpoint);
        if (endpoint.origin !== 'https://auth.openai.com') throw new Error('잘못된 세션 해제 주소');
        // Retry a temporary failure once, without replaying authorization or inference.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await this.fetcher(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }), signal: AbortSignal.timeout(10_000) });
            revoked = response.status === 200;
            if (revoked || response.status < 500) break;
          } catch { if (attempt === 1) break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    } catch { revoked = false; }
    finally {
      delete account.access_token; delete account.refresh_token; delete account.id_token;
      if (this.value.active === account.client_id) this.value.active = null;
      this.signingOut.delete(account.client_id); this.save();
    }
    return { remoteRevoked: revoked, message: revoked ? 'ChatGPT 세션과 이 앱의 연결을 해제했습니다.' : '이 앱의 연결은 해제했습니다. 원격 세션 해제는 확인하지 못했으니 ChatGPT 설정에서 앱 연결을 확인하세요.' };
  }
  setApiKey(key) { this.value.apiKey = key; this.save(); }
  begin(browserSession, clientId = null, consent = false, locale = 'en') {
    for (const [key, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(key);
    const account = clientId ? this.value.accounts.find(a => a.client_id === clientId) : null;
    if (clientId && !account) throw new Error('등록된 계정을 찾을 수 없습니다.');
    if (this.attempts.get(browserSession)?.status === 'processing') throw new Error('인증을 확인 중입니다. 결과를 기다려주세요.');
    this.cancel(browserSession);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const redirect = `${this.origin}/auth/callback`;
    const attempt = { id: randomUUID(), locale, state, status: 'pending', message: '공식 로그인 창에서 인증과 권한 승인을 완료하세요.', verifier, nonce, redirect, browserSession, account, expires: Date.now() + 600_000 };
    this.pending.set(state, attempt); this.attempts.set(browserSession, attempt);
    const params = new URLSearchParams({ client_id: account?.client_id || 'dynamic_agent_client', ext_agent_host_id: this.value.host_id, response_type: 'code', redirect_uri: redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: 'https://api.openai.com/v1', state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (account) { if (account.id_token) params.set('id_token_hint', account.id_token); if (account.email) params.set('login_hint', account.email); }
    else params.set('agent_name_hint', 'ContextFidelity');
    if (consent) params.set('prompt', 'consent');
    attempt.authorizationUrl = `https://auth.openai.com/api/accounts/authorize?${params}`;
    return attempt.authorizationUrl;
  }
  resume(browserSession) {
    const attempt = this.attempts.get(browserSession);
    if (this.status(browserSession).status !== 'pending') throw new Error('로그인 요청이 만료됐습니다. 다시 연결하세요.');
    return attempt.authorizationUrl;
  }
  async tokenRequest(body) {
    const response = await this.fetcher('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
    const data = await response.json();
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code;
      const error = new Error(`인증 토큰 교환 실패 (${response.status}). 다시 로그인하세요.`);
      error.code = code; throw error;
    }
    return data;
  }
  async validateIdToken(token, clientId, nonce) {
    const parts = token?.split('.') || [];
    if (parts.length !== 3) throw new Error('ID 토큰 형식이 올바르지 않습니다.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (header.alg !== 'RS256') throw new Error('지원하지 않는 ID 토큰 서명입니다.');
    const response = await this.fetcher('https://auth.openai.com/.well-known/jwks.json', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('ID 토큰 서명 키를 확인할 수 없습니다.');
    const keys = await response.json();
    const jwk = keys.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('ID 토큰 서명이 유효하지 않습니다.');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== 'https://auth.openai.com' || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() || (claims.nbf && claims.nbf * 1000 > Date.now() + 30_000) || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID 토큰의 계정·대상·유효기간·nonce 검증에 실패했습니다.');
    return claims;
  }
  async callback(query, browserSession) {
    const state = query.get('state');
    const attempt = this.pending.get(state);
    if (!attempt || attempt.expires < Date.now()) throw new Error('로그인 요청이 만료됐거나 브라우저가 일치하지 않습니다. 다시 시작하세요.');
    this.pending.delete(state);
    attempt.status = 'processing'; attempt.message = '계정과 승인한 권한을 확인하고 있습니다.';
    try {
    if (query.has('error')) throw new Error('로그인이 취소되었거나 권한이 승인되지 않았습니다.');
    const clientId = query.get('client_id') || attempt.account?.client_id;
    if (!clientId || clientId === 'dynamic_agent_client' || (attempt.account && clientId !== attempt.account.client_id) || !query.get('code')) throw new Error('등록된 클라이언트 정보를 확인할 수 없습니다.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: query.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.redirect, resource: 'https://api.openai.com/v1' });
    const claims = await this.validateIdToken(tokens.id_token, clientId, attempt.nonce);
    if (attempt.account && claims.sub !== attempt.account.sub) throw new Error('선택한 계정과 로그인한 계정이 다릅니다.');
    if (!tokens.access_token) throw new Error('계정 접근 토큰이 누락됐습니다. 다시 연결하세요.');
    const previous = this.value.accounts.find(a => a.client_id === clientId);
    if (previous && previous.sub !== claims.sub) throw new Error('저장된 등록과 로그인한 계정이 다릅니다.');
    const account = { client_id: clientId, sub: claims.sub, email: claims.email, label: `${claims.email || 'ChatGPT'} · ${clientId.slice(-6)}`, access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token, scope: tokens.scope || '', expires: Date.now() + (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600) * 1000, welcome_confirmed: previous?.welcome_confirmed || false };
    this.value.accounts = this.value.accounts.filter(a => a.client_id !== clientId).concat(account);
    this.value.active = clientId;
    this.save();
    attempt.status = this.planEnabled(account) ? 'connected' : 'permission_required';
    attempt.message = this.planEnabled(account) ? 'ChatGPT 연결이 완료됐습니다. 채팅 입력창에서 모델을 선택하세요.' : '로그인은 완료됐지만 ChatGPT 플랜 사용 권한이 없습니다. 권한을 승인하거나 다른 연결 방식을 선택하세요.';
    return this.status(attempt.browserSession);
    } catch (error) { attempt.status = query.has('error') ? 'cancelled' : 'failed'; attempt.message = error.message; throw error; }
  }
  async accessToken(clientId = this.value.active) {
    const account = this.value.accounts.find(a => a.client_id === clientId);
    if (!account) throw new Error('설정에서 Continue with ChatGPT로 연결하세요.');
    if (!this.planEnabled(account)) throw new Error('ChatGPT 플랜 사용 권한을 승인하세요.');
    if (this.signingOut.has(account.client_id)) throw new Error('이 계정을 다시 연결하세요.');
    if (!account.access_token && !account.refresh_token) throw new Error('이 계정을 다시 연결하세요.');
    if (!account.access_token || !Number.isFinite(account.expires) || account.expires < Date.now() + 60_000) {
      // A single rotating refresh token must not be used by concurrent requests.
      if (!this.refreshes.has(account.client_id)) this.refreshes.set(account.client_id, (async () => {
        if (!account.refresh_token) throw new Error('인증이 만료됐습니다. 다시 로그인하세요.');
        const previousRefresh = account.refresh_token;
        try {
        const tokens = await this.tokenRequest({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource: 'https://api.openai.com/v1' });
        if (!tokens.access_token) throw new Error('접근 토큰을 갱신하지 못했습니다. 다시 연결하세요.');
        if (account.refresh_token !== previousRefresh) throw new Error('갱신 중 계정 연결이 변경되었습니다.');
        account.access_token = tokens.access_token;
        if (tokens.refresh_token) account.refresh_token = tokens.refresh_token;
        if (tokens.scope) account.scope = tokens.scope;
        account.expires = Date.now() + (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600) * 1000;
        this.save();
        if (!this.planEnabled(account)) throw new Error('플랜 사용 권한이 만료됐습니다. 다시 연결하세요.');
        } catch (error) {
          if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) { delete account.access_token; delete account.refresh_token; delete account.id_token; this.save(); }
          throw error;
        }
      })().finally(() => { this.refreshes.delete(account.client_id); }));
      await this.refreshes.get(account.client_id);
    }
    return account.access_token;
  }
}
