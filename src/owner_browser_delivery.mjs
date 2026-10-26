// Use the originating QQ message's delivery queue and sequence budget. A
// timeout or ambiguous receipt is never retried with a fresh message counter.
export function ownerBrowserNotifier({ serialize, current, nextSequence, rollbackSequence,
  remaining, sendText, record }) {
  return async (_event, result, { isCurrent, guard }) => {
    if (typeof guard !== 'function' || typeof isCurrent !== 'function') throw Error('owner_browser_guard_required');
    const text = String(result?.reply || result?.summary || '').trim();
    if (!text || [...text].length > 1800) throw Error('owner_browser_notice_invalid');
    return serialize(async () => {
      if (!current() || !guard() || !await isCurrent() || !current() || !guard() || remaining() < 1)
        throw Object.assign(Error('owner_browser_notice_stale'), { messageNotSent: true });
      const deliveryGuard = () => current() && guard();
      const sequence = nextSequence();
      let receipt;
      try { receipt = await sendText(text, sequence, deliveryGuard); }
      catch (error) { if (error.messageNotSent === true) rollbackSequence(); throw error; }
      if (!receipt?.id && !receipt?.body?.id) throw Error('owner_browser_notice_unconfirmed');
      if (deliveryGuard()) await record(text, receipt, deliveryGuard);
      return receipt;
    });
  };
}
