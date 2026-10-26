const warmingPhases = new Set(['starting', 'importing', 'loading_model', 'warming_model', 'warming']);

// A snapshot describes dynamic synthesis only. The approved voice catalog is
// independent and remains usable while the GPU model is paused or unavailable.
export function speechCapability(value = {}) {
  const state = value && typeof value === 'object' ? value : {};
  const paused = state.paused === true || state.phase === 'paused';
  const ready = !paused && state.ready === true;
  const phase = paused ? 'paused' : ready ? 'ready' : warmingPhases.has(state.phase) ? 'warming' : 'unavailable';
  return { available: ready, ready, paused, phase, max_chars: 120 };
}

// Read the control file again instead of waiting for the polling timer. This
// function must never call warm/applyResourceControl or otherwise load the GPU.
export function readSpeechCapability(engine) {
  try {
    const control = typeof engine?.readControl === 'function' ? engine.readControl() : undefined;
    const hasSharedReader = typeof engine?.readSharedStatus === 'function';
    const shared = hasSharedReader ? engine.readSharedStatus() : undefined;
    const state = engine?.status?.() || {};
    const sharedBlocked = hasSharedReader && (shared?.inferenceAllowed !== true || shared?.generationImplemented !== true || shared?.paused !== false);
    return speechCapability({ ...state, paused: state.paused === true || sharedBlocked || (control !== undefined && control?.paused !== false) });
  } catch { return speechCapability(); }
}

export function replySpeechFallback({ content, text, requested, state, deliveryFailed = false }) {
  const body = String((requested ? text || content : content || text) || '').trim();
  if (!requested) return { content: body, replaceMessages: false };
  // The model may already have explained this explicit voice request naturally.
  // Keep that answer instead of adding a second capability announcement.
  if (/(?:语音|声音).{0,14}(?:还没|还在准备|暂时.{0,4}(?:不|用不了)|没(?:能|有)?(?:生成|恢复)|发不了|不能发|用不了)|先(?:用)?文字/.test(body)) {
    return { content: body, replaceMessages: true };
  }
  const notice = deliveryFailed ? '这次语音没发出去，先用文字回你。'
    : state?.phase === 'paused' ? '新语音这会儿还没恢复，先用文字回你。'
    : state?.phase === 'warming' ? '声音还在准备，先用文字陪你聊。'
      : state?.phase === 'ready' ? '这句语音没生成好，先用文字说。'
        : '这会儿新语音暂时用不了，先用文字回你。';
  return { content: body ? `${notice}\n${body}` : notice, replaceMessages: true };
}

export async function prepareReplySpeech({ content, text, requested = false, hasMedia = false, status, synthesize }) {
  const unchanged = { content: String(content || text || ''), prepared: null, replaceMessages: false };
  if (!text || hasMedia) return unchanged;
  const current = () => {
    try { return speechCapability(status()); } catch { return speechCapability(); }
  };
  const before = current();
  if (!before.available) return { ...unchanged, ...replySpeechFallback({ content, text, requested, state: before }) };
  let prepared;
  try { prepared = await synthesize(text); }
  catch { return { ...unchanged, ...replySpeechFallback({ content, text, requested, state: current() }) }; }
  const after = current();
  if (!after.available) return { ...unchanged, ...replySpeechFallback({ content, text, requested, state: after }) };
  return { ...unchanged, prepared };
}

// Once /messages may have been called, no text replay is safe. Only the
// transport's explicit pre-send failure/cancellation can choose a text fallback.
export async function deliverReplyVoice({ sendVoice, onCancelled }) {
  try {
    const delivery = await sendVoice();
    if (!delivery?.id) throw Error('qq_voice_delivery_unconfirmed');
    return { delivery, cancelled: false };
  } catch (error) {
    if (error?.messageNotSent === true) {
      return { delivery: null, cancelled: true, fallback: onCancelled(error) };
    }
    throw Object.assign(error instanceof Error ? error : Error('qq_voice_delivery_unconfirmed'), { deliveryUncertain: true });
  }
}
