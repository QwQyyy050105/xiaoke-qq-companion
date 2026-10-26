import { createHash } from 'node:crypto';

const speakerPattern = /^member_[a-f0-9]{16}$/;
const clean = value => typeof value === 'string' ? value.normalize('NFKC').replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '';
const unique = (items, max) => [...new Set(items)].slice(0, max);

export function groupMemberSpeaker(groupId, memberId) {
  return `member_${createHash('sha256').update(JSON.stringify([groupId, memberId])).digest('hex').slice(0, 16)}`;
}

export function normalizeWaitPlan(value, { allowedSpeakers = [], now = Date.now(), restoring = false } = {}) {
  if (!value || !['timer', 'condition', 'indefinite'].includes(value.mode)) return null;
  const keywords = unique((Array.isArray(value.keywords) ? value.keywords : [])
    .filter(item => typeof item === 'string' && item.length <= 60).map(clean).filter(Boolean), 12);
  const allowed = new Set(allowedSpeakers);
  const speakers = unique((Array.isArray(value.speakers) ? value.speakers : [])
    .filter(item => typeof item === 'string' && speakerPattern.test(item) && allowed.has(item)), 20);
  if (value.mode !== 'indefinite' && !keywords.length && !speakers.length) return null;
  return { mode: value.mode, keywords, speakers, match: value.match === 'all' ? 'all' : 'any',
    createdAt: restoring && Number.isFinite(value.createdAt) && value.createdAt >= 0 && value.createdAt <= now ? value.createdAt : now };
}

const currentText = event => clean(String(event?.content || '').replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/(^|\n)\s*>[^\n]*/g, ' ').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/g, ' ')).toLowerCase();

export function matchWaitPlan(plan, event) {
  if (!plan || !event || event.is_self || event.from_self || event.author?.bot || /^\s*\//.test(event.content || '')) return null;
  const checks = [], text = currentText(event);
  if (plan.keywords?.length) checks.push({ kind: 'keyword', hit: plan.keywords.some(keyword => {
    const value = keyword.toLowerCase();
    return /^[a-z0-9]{1,4}$/.test(value) ? new RegExp(`\\b${value}\\b`, 'i').test(text) : text.includes(value);
  }) });
  if (plan.speakers?.length) {
    const member = event.author?.member_openid || event.author?.id;
    checks.push({ kind: 'speaker', hit: Boolean(member && event.group_openid && plan.speakers.includes(groupMemberSpeaker(event.group_openid, member))) });
  }
  if (!checks.length || !(plan.match === 'all' ? checks.every(item => item.hit) : checks.some(item => item.hit))) return null;
  return { reason: checks.filter(item => item.hit).map(item => item.kind).join('_and_'), messageId: String(event.id || '') };
}

export function waitSnapshot(plan) {
  return plan ? { mode: plan.mode, keywords: [...plan.keywords], speakers: [...plan.speakers], match: plan.match }
    : { mode: 'timer', keywords: [], speakers: [], match: 'any' };
}
