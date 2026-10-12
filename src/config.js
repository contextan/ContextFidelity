import { join } from 'node:path';
export function serverConfig(env, root) {
  const mode = env.CONTEXTFIDELITY_MODE || env.CONTEXTPULSE_MODE || 'local';
  if (!['local', 'hosted'].includes(mode)) throw new Error('CONTEXTFIDELITY_MODE must be local or hosted');
  const port = Number(env.PORT || env.CONTEXTFIDELITY_PORT || env.CONTEXTPULSE_PORT || 8899);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
  const publicOrigin = env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const url = new URL(publicOrigin);
  if (url.origin !== publicOrigin || url.username || url.password) throw new Error('PUBLIC_ORIGIN must contain only an origin, without a trailing slash');
  if (mode === 'hosted' && url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Hosted PUBLIC_ORIGIN requires HTTPS, except loopback testing');
  return { mode, port, publicOrigin, directory: env.CONTEXTFIDELITY_DATA_DIR || env.CONTEXTPULSE_DATA_DIR || join(root, mode === 'hosted' ? 'web-data' : 'data'), host: mode === 'hosted' ? '0.0.0.0' : '127.0.0.1' };
}

export function supportsLoopbackChatGptOAuth(origin) {
  const url = new URL(origin);
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}
