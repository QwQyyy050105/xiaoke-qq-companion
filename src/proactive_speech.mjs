// One proactive opportunity produces at most one QQ send. Only a failure before
// sending may fall back to text; an uncertain QQ result must never be replayed.
export async function deliverProactiveSpeech({ group, text, spoken, now = Date.now,
  status, settings, lastSent, synthesize, sendVoice, sendText, isCurrent = () => true,
  verifyPrepared = async () => true }) {
  if (!isCurrent()) throw Error('proactive_stale');
  let prepared;
  const state = status();
  if (settings().spontaneousStickers && state.ready && !state.paused && !state.pending
    && now() - (lastSent.get(group) || 0) > 120000) {
    try { prepared = await synthesize(spoken.text); }
    catch { /* No QQ request has occurred; plain text is still safe. */ }
  }
  if (!settings().proactiveEnabled) throw Error('proactive_disabled');
  if (!isCurrent()) throw Error('proactive_stale');
  if (prepared) {
    let verified = false;
    try { verified = await verifyPrepared(prepared) === true; }
    catch { /* No QQ request has occurred; failed verification permits text. */ }
    if (!verified) prepared = null;
  }
  if (!settings().proactiveEnabled) throw Error('proactive_disabled');
  if (!isCurrent()) throw Error('proactive_stale');
  if (prepared && settings().spontaneousStickers && status().ready && !status().paused) {
    const delivery = await sendVoice(group, prepared);
    if (!delivery?.id) throw Error('proactive_voice_unconfirmed');
    lastSent.set(group, now());
    return { delivery, actual: '[发送语音：' + spoken.text + ']' };
  }
  const actual = text || spoken.text;
  const delivery = await sendText(group, actual);
  if (!delivery?.id) throw Error('proactive_text_unconfirmed');
  return { delivery, actual };
}
