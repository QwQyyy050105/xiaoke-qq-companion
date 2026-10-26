const CODES = new Set(['auth', 'rate_limit', 'network', 'server', 'invalid_output', 'cancelled', 'timeout', 'unknown']);
const MACHINE_CODES = new Map([
  ...['auth', 'authentication_error', 'auth_error', 'invalid_api_key', 'unauthorized', 'token_expired'].map(code => [code, 'auth']),
  ...['rate_limit', 'rate_limit_error', 'rate_limit_exceeded', 'usage_limit_reached', 'insufficient_quota'].map(code => [code, 'rate_limit']),
  ...['network', 'network_error', 'connection_error', 'stream_disconnected', 'econnreset', 'econnrefused', 'enotfound', 'eai_again', 'epipe', 'und_err_socket'].map(code => [code, 'network']),
  ...['server', 'server_error', 'internal_error', 'internal_server_error', 'service_unavailable'].map(code => [code, 'server']),
  ...['invalid_output', 'invalid_response', 'response_validation_error'].map(code => [code, 'invalid_output']),
  ...['cancelled', 'canceled', 'aborted', 'request_cancelled', 'request_canceled'].map(code => [code, 'cancelled']),
  ...['timeout', 'request_timeout', 'etimedout', 'und_err_connect_timeout', 'und_err_headers_timeout'].map(code => [code, 'timeout'])
]);
const LOCAL_CODES = new Map([
  ['codex_aborted', 'cancelled'], ['codex_timeout', 'timeout'],
  ...['codex_invalid_chat_response', 'codex_invalid_social_response', 'codex_invalid_work_response',
    'codex_invalid_memory_capture', 'codex_invalid_channel_response', 'codex_invalid_research_response',
    'codex_invalid_visual_review'].map(code => [code, 'invalid_output'])
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function structuredCode(value) {
  if (!object(value)) return 'unknown';
  for (const key of ['code', 'type', 'error_code', 'codex_error_info']) {
    const token = value[key];
    if (typeof token === 'string' && token.length <= 80) {
      const code = MACHINE_CODES.get(token.toLowerCase());
      if (code) return code;
    }
  }
  for (const key of ['status', 'status_code', 'http_status']) {
    const status = value[key];
    if (!Number.isInteger(status)) continue;
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500 && status <= 599) return 'server';
  }
  return 'unknown';
}

// Only structured machine fields of actual error events may classify a failure.
// Error prose, stderr, provider identifiers and arbitrary payloads are never used.
export function classifyStructuredModelError(event) {
  if (!object(event) || !['error', 'turn.failed'].includes(event.type)) return 'unknown';
  for (const candidate of [event.error, event.error?.error, event]) {
    const code = structuredCode(candidate);
    if (code !== 'unknown') return code;
  }
  return 'unknown';
}

export function classifyModelFailure(error, observedCode = 'unknown') {
  // These exact messages originate in this adapter, never substring matching
  // arbitrary provider text. Unknown errors retain no message or custom code.
  const local = LOCAL_CODES.get(error?.message);
  if (local) return local;
  const machine = structuredCode(error);
  if (machine !== 'unknown') return machine;
  return CODES.has(observedCode) ? observedCode : 'unknown';
}

export function modelCallOutcome({ success = false, code = 'unknown', exitCode = null } = {}) {
  return {
    status: success === true ? 'success' : 'failure',
    code: success === true ? null : CODES.has(code) ? code : 'unknown',
    exit_code: Number.isInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 4294967295 ? exitCode : null
  };
}
