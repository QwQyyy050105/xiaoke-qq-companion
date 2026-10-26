// Low-priority public-term research. Group transcripts and identities never
// cross the model boundary; internet evidence never confirms local meanings.
export class VocabularyResearch {
  constructor({ learning, generate, getAuthorization, enabled = () => true, isBusy = () => false, now = Date.now, log = () => {} }) {
    Object.assign(this, { learning, generate, getAuthorization, enabled, isBusy, now, log });
    this.authorizations=new Map();this.pending = new Map(); this.last = new Map(); this.running = null; this.stopped = false;
  }
  observe(event) {
    if (!event?.group_openid || !this.enabled()) return;
    if (this.pending.size >= 16 && !this.pending.has(event.group_openid)){const oldest=this.pending.keys().next().value;this.pending.delete(oldest);this.authorizations.delete(oldest);}
    this.pending.set(event.group_openid, this.now());
    if(this.getAuthorization)this.authorizations.set(event.group_openid,this.getAuthorization(event));
  }
  async tick() {
    if (this.stopped || this.running || !this.enabled() || this.isBusy()) return false;
    let group, ticket;
    for (const [candidateGroup, at] of this.pending) {
      if (this.now() - at < 30000) continue;
      const candidateTicket = this.learning.prepareResearch(candidateGroup, { limit: 3 });
      if (!candidateTicket) { this.pending.delete(candidateGroup);this.authorizations.delete(candidateGroup); continue; }
      const previous = this.last.get(candidateGroup);
      if (previous?.revisionKey === candidateTicket.revisionKey && this.now() - previous.at < 600000) {
        this.learning.releaseResearch(candidateTicket.token); continue;
      }
      group = candidateGroup; ticket = candidateTicket; break;
    }
    if (!ticket) return false;
    this.pending.delete(group);
    const authorization=this.authorizations.get(group);this.authorizations.delete(group);
    const controller = new AbortController(); this.running = { group, controller };
    this.last.set(group, { at: this.now(), revisionKey: ticket.revisionKey });
    const isCurrent = () => !controller.signal.aborted && !this.stopped && this.enabled();
    try {
      const result = await this.generate({ mode: 'vocabulary_research', structured: true,
        ...(authorization?{runtimeAuthorization:authorization}:{}),
        candidates: ticket.context.candidates.map(({ id, term }) => ({ id, term })), signal: controller.signal });
      if (!isCurrent()) return false;
      if (!Array.isArray(result?.actions)) throw Error('vocabulary_research_invalid_result');
      // URLs in a model's prose remain unverified until independently checked.
      const committed = await this.learning.applyModelActions({ group_openid: group }, result.actions,
        { researchToken: ticket.token, verifiedSources: [], researchCompleted: true, isCurrent });
      if (!committed.researchCurrent) return false;
      this.log(committed.applied > 0 ? '公开词语研究已保存，群内词义仍以成员明确说明或本机审核为准。'
        : '这轮公开词语研究暂无可采纳结果，同一版本短期内不重复查询。'); return true;
    } catch { this.log('公开词语研究暂未完成。'); return false; }
    finally { this.learning.releaseResearch(ticket.token); this.running = null; }
  }
  clearPending(){this.pending.clear();this.authorizations.clear();this.last.clear();this.running?.controller.abort();}
  forget(group) { this.authorizations.delete(group);this.pending.delete(group); this.last.delete(group); if (this.running?.group === group) this.running.controller.abort(); }
  start() { this.stopped = false; this.timer = setInterval(() => void this.tick().catch(() => {}), 30000); this.timer.unref(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.running?.controller.abort(); }
}
