const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_BODY_BYTES = 100_000;
const controls = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();
const messageKeys = ['idempotencyKey', 'to', 'subject', 'text', 'html'];

export class NotificationError extends Error {
  constructor(status, code, retryable = false, deliveryUnknown = false) {
    super(`Notification request failed (${code})`);
    this.name = 'NotificationError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.deliveryUnknown = deliveryUnknown;
  }
}

function mailbox(value) {
  if (typeof value !== 'string' || value.length > 254 || controls.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0].length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0]) &&
    parts[1].includes('.') && parts[1].split('.').every(label =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function sender(value) {
  if (typeof value !== 'string' || value.length > 400 || controls.test(value)) return false;
  if (mailbox(value)) return true;
  const match = /^([^<> ,;"\\][^<>,;"\\]{0,99}) <([^<>]+)>$/.exec(value);
  return Boolean(match && match[1].trim() === match[1] && mailbox(match[2]));
}

export function notificationProvider(env) {
  const provider = env?.NOTIFICATION_PROVIDER ?? 'resend';
  return ['resend', 'cloudflare'].includes(provider) ? provider : null;
}

// Optional provider/from arguments check an already-frozen job, independently of
// today's provider selection/sender. Never fall back to another provider.
export function notificationConfigured(env, provider = notificationProvider(env), from = env?.MAIL_FROM) {
  if (!sender(from)) return false;
  if (provider === 'cloudflare') return typeof env?.EMAIL?.send === 'function';
  return provider === 'resend' && typeof env?.RESEND_API_KEY === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(env.RESEND_API_KEY);
}

function validateMessage(message, envelope = false) {
  const allowed = envelope ? [...messageKeys, 'provider', 'from'] : messageKeys;
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      Object.keys(message).some(key => !allowed.includes(key))) throw new NotificationError(400, 'invalid_message');
  const { idempotencyKey, to, subject, text, html } = message;
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_./:-]{1,256}$/.test(idempotencyKey) ||
      !mailbox(to) || typeof subject !== 'string' || !subject.trim() ||
      encoder.encode(subject).length > 512 || controls.test(subject) ||
      (text !== undefined && typeof text !== 'string') ||
      (html !== undefined && typeof html !== 'string') || !(text?.trim() || html?.trim()) ||
      (envelope && (!['resend', 'cloudflare'].includes(message.provider) || !sender(message.from)))) {
    throw new NotificationError(400, 'invalid_message');
  }
}

function providerBody(message, provider, from) {
  const named = /^(.+) <([^<>]+)>$/.exec(from);
  const fromAddress = provider === 'cloudflare' && named ? { email: named[2], name: named[1] } : from;
  const body = JSON.stringify({ from: fromAddress, to: provider === 'resend' ? [message.to] : message.to,
    subject: message.subject, ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}) });
  if (encoder.encode(body).length > MAX_BODY_BYTES) throw new NotificationError(400, 'message_too_large');
  return body;
}

/** Persist this exact envelope encrypted before the first provider call. */
export function prepareNotification(env, message) {
  validateMessage(message);
  const provider = notificationProvider(env), from = env?.MAIL_FROM;
  if (!notificationConfigured(env, provider, from)) throw new NotificationError(503, 'not_configured');
  providerBody(message, provider, from);
  return { provider, from, idempotencyKey: message.idempotencyKey, to: message.to, subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}) };
}

async function boundedJSON(response) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } finally { reader.releaseLock(); }
}

const cloudflareRejected = new Set(['E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS', 'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED',
  'E_ACCOUNT_SUSPENDED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY']);

/**
 * Send trusted server-rendered mail only, without internal retries. Bare legacy
 * payloads ALWAYS use Resend; new jobs must persist prepareNotification's envelope.
 * Resend keys last24h. Cloudflare's documented send(builder)->{messageId} has no
 * idempotency guarantee. Unknown outcomes MUST park, including worker crashes:
 * the ledger must durably mark in-flight before calling and never replay such a
 * Cloudflare job after a crash. A timeout cannot cancel an opaque binding call.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export async function sendNotification(env, message, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const envelope = message != null && Object.hasOwn(message, 'provider');
  const provider = envelope ? message.provider : 'resend', from = envelope ? message.from : env?.MAIL_FROM;
  // Keep historical configuration-first behavior for legacy callers.
  if (!notificationConfigured(env, provider, from)) throw new NotificationError(503, 'not_configured');
  validateMessage(message, envelope);
  const body = providerBody(message, provider, from);
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NotificationError(0, 'timeout', provider === 'resend', true));
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TIMEOUT_MS) : TIMEOUT_MS);
  });
  const operation = async () => {
    if (provider === 'cloudflare') {
      let result;
      try { result = await env.EMAIL.send(JSON.parse(body)); }
      catch (error) {
        if (['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED'].includes(error?.code)) {
          throw new NotificationError(429, 'temporarily_unavailable', true);
        }
        if (cloudflareRejected.has(error?.code)) throw new NotificationError(400, 'request_failed');
        // Internal/delivery/network failures are not a proof of non-acceptance.
        throw new NotificationError(502, 'delivery_unknown', false, true);
      }
      if (typeof result?.messageId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(result.messageId)) {
        throw new NotificationError(502, 'invalid_response', false, true);
      }
      return { id: result.messageId };
    }
    let response;
    try {
      response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': message.idempotencyKey }, body });
    } catch { throw new NotificationError(0, 'network_error', true, true); }
    let data;
    try { data = await boundedJSON(response); } catch { /* Never expose provider response bodies. */ }
    if (!response.ok) {
      const concurrent = response.status === 409 && data?.name === 'concurrent_idempotent_requests';
      const retryable = concurrent || response.status === 408 || response.status === 429 || response.status >= 500;
      const code = concurrent ? 'concurrent_request' : response.status === 409 ? 'idempotency_conflict' :
        response.status === 401 || response.status === 403 ? 'unauthorized' : retryable ? 'temporarily_unavailable' : 'request_failed';
      throw new NotificationError(response.status, code, retryable);
    }
    if (typeof data?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) {
      throw new NotificationError(502, 'invalid_response', true, true);
    }
    return { id: data.id };
  };
  try { return await Promise.race([operation(), timeout]); }
  finally { clearTimeout(timer); }
}
