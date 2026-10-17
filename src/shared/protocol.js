/** Wire-only constants; contains no session data or platform dependencies. */
export const API_PATH = '/plugins/dsh-btw/api';
export const EVENTS_PATH = '/plugins/dsh-btw/events';
export const PLUGIN_ID = 'dsh-btw';
export const TAB_KIND = 'btw';
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_TEXT_LENGTH = 64 * 1024;
export const METHODS = Object.freeze(['create', 'send', 'state', 'stop', 'close', 'list']);

export function errorRecord(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'BTW_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function assertObject(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${name} must be an object`), { code: 'BAD_REQUEST' });
  }
  return value;
}

export function validateCall(method, rawArgs = {}) {
  if (!METHODS.includes(method)) throw Object.assign(new Error('Unknown BTW operation'), { code: 'BAD_REQUEST' });
  const args = assertObject(rawArgs);
  const required = method === 'create' ? ['parentSessionId', 'requestId', 'tabId']
    : method === 'list' ? ['parentSessionId']
    : method === 'close' && !args.sideId ? ['parentSessionId', 'tabId'] : ['parentSessionId', 'sideId'];
  if (method === 'send') required.push('requestId', 'text');
  for (const key of required) {
    if (typeof args[key] !== 'string' || !args[key].trim()) {
      throw Object.assign(new Error(`${key} is required`), { code: 'BAD_REQUEST' });
    }
    if (key !== 'text' && args[key].length > 2048) {
      throw Object.assign(new Error(`${key} is too long`), { code: 'BAD_REQUEST' });
    }
  }
  for (const key of ['text', 'question']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > MAX_TEXT_LENGTH)) {
      throw Object.assign(new Error(`${key} must be at most ${MAX_TEXT_LENGTH} characters`), { code: 'BAD_REQUEST' });
    }
  }
  return { ...args };
}
