import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Provider } from './provider.js';
import { archiveTransientAssistantHypotheses } from './context-ai.js';

const fail = (message, status = 429) => Object.assign(new Error(message), { status });
export class WorkspaceManager {
  constructor(directory, origin, fetcher, { maxCached = 64, maxWorkspaces = 500 } = {}) {
    this.directory = join(directory, 'visitors');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'workspace.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid workspace encryption key');
    this.origin = origin; this.fetcher = fetcher;
    this.maxCached = maxCached; this.maxWorkspaces = maxWorkspaces;
    this.cache = new Map(); this.created = [];
  }
  sign(value) { return createHmac('sha256', this.key).update('visitor-cookie:' + value).digest('base64url'); }
  verify(cookie) {
    if (typeof cookie !== 'string') return null;
    const [id, expiry, signature] = cookie.split('.');
    if (!/^[a-f0-9]{48}$/.test(id || '') || !/^\d{13}$/.test(expiry || '') || Number(expiry) < Date.now()) return null;
    const expected = this.sign(`${id}.${expiry}`);
    if (signature?.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    return existsSync(join(this.directory, id, 'contextfidelity.sqlite')) || existsSync(join(this.directory, id, 'contextpulse.sqlite')) ? id : null;
  }
  resolve(cookie) {
    let id = this.verify(cookie), issued = null;
    if (!id) {
      this.created = this.created.filter(t => t > Date.now() - 60_000);
      if (this.created.length >= 20 || readdirSync(this.directory).length >= this.maxWorkspaces) throw fail('Demo workspace capacity reached. Please try again later.');
      id = randomBytes(24).toString('hex');
      const value = `${id}.${Date.now() + 30 * 86400_000}`;
      issued = `${value}.${this.sign(value)}`;
      this.created.push(Date.now());
    }
    let runtime = this.cache.get(id);
    if (!runtime) {
      if (this.cache.size >= this.maxCached) {
        const idle = [...this.cache].find(([, r]) => !r.busy.size && !r.backgroundTasks.size && !r.inflight);
        if (!idle) throw fail('Demo is busy. Please try again shortly.');
        idle[1].store.close(); this.cache.delete(idle[0]);
      }
      const directory = join(this.directory, id), fresh = !existsSync(join(directory, 'contextfidelity.sqlite')) && !existsSync(join(directory, 'contextpulse.sqlite'));
      const store = new Store(directory);
      for (const project of store.projects()) archiveTransientAssistantHypotheses(store, project.id);
      if (fresh) store.saveSettings({ provider: 'chatgpt', model: '', autoContext: true, ollamaUrl: 'http://127.0.0.1:11434' });
      else if (store.settings().provider !== 'chatgpt' || store.settings().model === 'context-demo') store.saveSettings({ ...store.settings(), provider: 'chatgpt', model: '' });
      const encryptionKey = createHmac('sha256', this.key).update('visitor-credentials:' + id).digest();
      const auth = new Auth(directory, this.origin, this.fetcher, encryptionKey);
      runtime = { store, auth, provider: new Provider(auth, this.fetcher), csrf: randomBytes(32).toString('hex'), busy: new Set(), backgroundTasks: new Set(), inflight: 0, requests: [] };
      this.cache.set(id, runtime);
    }
    // LRU without evicting in-flight model requests.
    this.cache.delete(id); this.cache.set(id, runtime);
    runtime.requests = runtime.requests.filter(t => t > Date.now() - 60_000);
    if (runtime.requests.length >= 240) throw fail('Too many requests. Please try again in a minute.');
    runtime.requests.push(Date.now());
    return { runtime, issued, id };
  }
  busyCount() { return [...this.cache.values()].reduce((sum, r) => sum + r.busy.size + r.backgroundTasks.size, 0); }
  close() { for (const r of this.cache.values()) r.store.close(); this.cache.clear(); }
}
