import { readFileSync } from 'node:fs';

export const english = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const entries = Object.keys(english).sort((a, b) => b.length - a.length);
const pattern = new RegExp(entries.map(escape).join('|'), 'g');

// Only use for application-owned copy. Original messages, decisions, model output,
// and historical request payloads must never be passed through this function.
export function systemText(value, locale = 'en') {
  if (locale === 'ko' || typeof value !== 'string') return value;
  return value.replace(pattern, match => english[match]);
}
export function interfaceLocale(value) { return value === 'ko' ? 'ko' : 'en'; }

// System confirmations are application messages, not user originals. Render them
// in the current UI language while retaining the stored message verbatim.
export function systemMessage(value, locale) {
  const saved = value.match(/^(?:Saved decision v(\d+)\.|Decision v(\d+) saved\.)( The previous decision is preserved as superseded\.| The earlier decision is preserved as superseded\.)?$/);
  if (saved) {
    const version = saved[1] || saved[2];
    return locale === 'ko' ? `결정 v${version}을 저장했습니다.${saved[3] ? ' 이전 결정은 대체됨 상태로 보관됩니다.' : ''}` : `Saved decision v${version}.${saved[3] ? ' The previous decision is preserved as superseded.' : ''}`;
  }
  const automatic = value.match(/^Automatically registered decision v(\d+) from the original user message\.$/);
  if (automatic && locale === 'ko') return `사용자 원문에서 결정 v${automatic[1]}을 자동 등록했습니다.`;
  const confirmed = value.match(/^Confirmed and saved decision v(\d+) from the original message\.$/);
  if (confirmed && locale === 'ko') return `원문에서 추출한 결정 v${confirmed[1]}을 확인하여 저장했습니다.`;
  return systemText(value, locale);
}
