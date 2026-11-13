import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendNotification, notificationConfigured, NotificationError } from '../src/notifications.js';

const env = { RESEND_API_KEY: 're_test_key', MAIL_FROM: 'Booking <booking@example.com>' };
const message = { idempotencyKey: 'booking/123/reminder/guest', to: 'guest+booking@example.com', subject: 'Booking reminder', text: 'Your booking starts soon.' };
const json = (data, status = 200) => Response.json(data, { status });
const fail = (status, retryable, code) => error => {
  assert(error instanceof NotificationError);
  assert.equal(error.status, status); assert.equal(error.retryable, retryable);
  if (code) assert.equal(error.code, code);
  assert(!error.message.includes('private')); return true;
};

test('configured means safe key and single sender address are supplied', () => {
  assert(notificationConfigured(env));
  assert(notificationConfigured({ ...env, MAIL_FROM: 'booking@example.com' }));
  for (const value of [undefined, {}, { ...env, RESEND_API_KEY: '' }, { ...env, RESEND_API_KEY: 'key\r\nprivate' },
    { ...env, MAIL_FROM: 'Booking <booking@example.com>\r\nBcc:private@example.com' },
    { ...env, MAIL_FROM: 'a@example.com,b@example.com' }]) assert(!notificationConfigured(value));
});

test('sends one JSON request with stable idempotency, trusted body, and bounded abort signal', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return json({ id: 'provider-123' }); };
  const content = { ...message, text: 'Guest "name"\nBcc: text@example.com <script>', html: '<p>Guest &lt;name&gt;</p>' };
  assert.deepEqual(await sendNotification(env, content, { fetchImpl }), { id: 'provider-123' });
  await sendNotification(env, content, { fetchImpl });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body, requests[1].init.body);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual'); assert(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { Authorization: 'Bearer re_test_key', 'Content-Type': 'application/json', 'Idempotency-Key': message.idempotencyKey });
    assert.deepEqual(JSON.parse(init.body), { from: env.MAIL_FROM, to: [message.to], subject: message.subject, text: content.text, html: content.html });
  }
});

test('invalid and unsafe headers, recipient lists, payloads and extension fields fail before fetch', async () => {
  const invalid = [null, [], { ...message, to: 'Guest <guest@example.com>' }, { ...message, to: ['guest@example.com'] },
    ...['a@example.com,b@example.com', 'a@example.com\r\nBcc:private@example.com', '.a@example.com', 'a..b@example.com', 'a@-example.com', 'a@example..com'].map(to => ({ ...message, to })),
    ...['private\r\nBcc:foo@example.com', 'private\u0000', '😀'.repeat(129), ''].map(subject => ({ ...message, subject })),
    ...['', 'a'.repeat(257), 'private\r\nheader', 'has space'].map(idempotencyKey => ({ ...message, idempotencyKey })),
    { ...message, text: '' }, { ...message, text: 10 }, { ...message, html: {} },
    { ...message, headers: { Bcc: 'private@example.com' } }, { ...message, attachments: [{ path: 'file:///private/file' }] },
    { ...message, from: 'private@example.com' }];
  let calls = 0;
  for (const value of invalid) await assert.rejects(sendNotification(env, value, { fetchImpl: async () => { calls++; } }), fail(400, false, 'invalid_message'));
  await assert.rejects(sendNotification(env, { ...message, text: '😀'.repeat(30_000) }, { fetchImpl: async () => { calls++; } }), fail(400, false, 'message_too_large'));
  await assert.rejects(sendNotification({}, message, { fetchImpl: async () => { calls++; } }), fail(503, false, 'not_configured'));
  assert.equal(calls, 0);
});

test('provider errors are sanitized and retry only transient failures or same-key concurrency', async () => {
  for (const [status, name, retryable, code] of [
    [400, 'validation_error', false, 'request_failed'], [401, 'validation_error', false, 'unauthorized'],
    [403, 'validation_error', false, 'unauthorized'], [408, 'timeout', true, 'temporarily_unavailable'],
    [409, 'invalid_idempotent_request', false, 'idempotency_conflict'],
    [409, 'concurrent_idempotent_requests', true, 'concurrent_request'],
    [429, 'rate_limit_exceeded', true, 'temporarily_unavailable'], [503, 'private', true, 'temporarily_unavailable'],
  ]) {
    let calls = 0;
    await assert.rejects(sendNotification(env, message, { fetchImpl: async () => { calls++; return json({ name, message: 'private key guest and provider details' }, status); } }), fail(status, retryable, code));
    assert.equal(calls, 1);
  }
});

test('network failures and unknown successful responses remain retryable with the original key', async () => {
  await assert.rejects(sendNotification(env, message, { fetchImpl: async () => { throw new Error('private key'); } }), fail(0, true, 'network_error'));
  for (const response of [json({}), json({ id: 'private\r\nheader' }), new Response('private not JSON'), json({ id: 'a'.repeat(20_000) })]) {
    await assert.rejects(sendNotification(env, message, { fetchImpl: async () => response }), fail(502, true, 'invalid_response'));
  }
});

test('timeout covers both unresponsive fetch and response body even when mock ignores abort', async () => {
  let signal;
  await assert.rejects(sendNotification(env, message, { timeoutMs: 5, fetchImpl: async (_url, init) => {
    signal = init.signal; return new Promise(() => {});
  } }), fail(0, true, 'timeout'));
  assert(signal.aborted);
  await assert.rejects(sendNotification(env, message, { timeoutMs: 5, fetchImpl: async () =>
    new Response(new ReadableStream({ start() {} })) }), fail(0, true, 'timeout'));
});

const cfEnv = () => ({ NOTIFICATION_PROVIDER: 'cloudflare', MAIL_FROM: 'Booking <booking@example.com>',
  EMAIL: { send: async () => ({ messageId: '<cloudflare-123@example.com>' }) } });

test('Cloudflare requires explicit provider, valid sender and a native send binding without fallback', async () => {
  const { notificationProvider, prepareNotification } = await import('../src/notifications.js');
  assert.equal(notificationProvider({}), 'resend');
  assert.equal(notificationProvider(cfEnv()), 'cloudflare');
  assert(notificationConfigured(cfEnv()));
  assert(!notificationConfigured({ ...cfEnv(), EMAIL: undefined, RESEND_API_KEY: env.RESEND_API_KEY }));
  for (const changes of [{ NOTIFICATION_PROVIDER: '' }, { NOTIFICATION_PROVIDER: 'private' },
    { EMAIL: { send: 'private' } }, { MAIL_FROM: 'private\r\nBcc:guest@example.com' }]) {
    assert(!notificationConfigured({ ...cfEnv(), ...changes }));
    assert.throws(() => prepareNotification({ ...cfEnv(), ...changes }, message), fail(503, false, 'not_configured'));
  }
});

test('frozen Cloudflare envelope preserves exact binding payload and sender after configuration changes', async () => {
  const { prepareNotification } = await import('../src/notifications.js');
  const requests = []; const original = cfEnv();
  original.EMAIL.send = async payload => { requests.push(JSON.stringify(payload)); payload.subject = 'mutated by binding'; return { messageId: '<cloudflare-123@example.com>' }; };
  const input = { ...message, html: '<p>Guest &lt;name&gt;</p>' };
  const payload = prepareNotification(original, input);
  assert.deepEqual(payload, { provider: 'cloudflare', from: original.MAIL_FROM, ...input });
  input.subject = 'changed after freezing';
  const changed = { ...original, NOTIFICATION_PROVIDER: 'resend', MAIL_FROM: 'Other <other@example.org>' };
  let fetched = false;
  for (const current of [original, changed]) {
    assert.deepEqual(await sendNotification(current, payload, { fetchImpl: async () => { fetched = true; } }), { id: '<cloudflare-123@example.com>' });
  }
  assert.equal(fetched, false); assert.equal(requests[0], requests[1]);
  assert.deepEqual(JSON.parse(requests[0]), { from: { email: 'booking@example.com', name: 'Booking' },
    to: message.to, subject: message.subject, text: message.text, html: payload.html });
  assert(!requests[0].includes('idempotencyKey')); assert(!requests[0].includes('headers'));
  assert.equal(payload.subject, message.subject);
});

test('Resend envelope and legacy encrypted payloads remain Resend across a provider switch', async () => {
  const { prepareNotification } = await import('../src/notifications.js');
  const payload = prepareNotification(env, message); const bodies = [];
  const changed = { ...cfEnv(), RESEND_API_KEY: env.RESEND_API_KEY, MAIL_FROM: 'Changed <changed@example.org>' };
  let sent = false; changed.EMAIL.send = async () => { sent = true; };
  const fetchImpl = async (url, init) => { assert.equal(url, 'https://api.resend.com/emails'); bodies.push(JSON.parse(init.body)); return json({ id: 'resend-123' }); };
  await sendNotification(changed, payload, { fetchImpl });
  assert.equal(bodies[0].from, env.MAIL_FROM);
  await sendNotification(changed, message, { fetchImpl });
  assert.equal(bodies[1].from, changed.MAIL_FROM); assert.equal(sent, false);
  await assert.rejects(sendNotification(cfEnv(), payload, { fetchImpl }), fail(503, false, 'not_configured'));
});

test('Cloudflare validates all trusted envelope fields and size before calling the binding', async () => {
  const { prepareNotification } = await import('../src/notifications.js');
  let calls = 0; const current = cfEnv(); current.EMAIL.send = async () => { calls++; };
  const payload = prepareNotification(current, message);
  for (const value of [{ ...payload, to: 'a@example.com,b@example.com' },
    { ...payload, subject: 'private\r\nBcc:guest@example.com' }, { ...payload, headers: { Bcc: 'private@example.com' } },
    { ...payload, text: '' }, { ...payload, attachments: [] }]) {
    await assert.rejects(sendNotification(current, value), fail(400, false, 'invalid_message'));
  }
  await assert.rejects(sendNotification(current, { ...payload, text: '😀'.repeat(30_000) }), fail(400, false, 'message_too_large'));
  assert.throws(() => prepareNotification(current, { ...message, provider: 'resend' }), fail(400, false, 'invalid_message'));
  assert.equal(calls, 0);
});

test('Cloudflare only retries explicit quota rejections; unknown outcomes require review with sanitized errors', async () => {
  const { prepareNotification } = await import('../src/notifications.js');
  for (const [providerCode, retryable, unknown, status, code] of [
    ['E_RATE_LIMIT_EXCEEDED', true, false, 429, 'temporarily_unavailable'],
    ['E_DAILY_LIMIT_EXCEEDED', true, false, 429, 'temporarily_unavailable'],
    ['E_SENDER_NOT_VERIFIED', false, false, 400, 'request_failed'],
    ['E_RECIPIENT_SUPPRESSED', false, false, 400, 'request_failed'],
    ['E_VALIDATION_ERROR', false, false, 400, 'request_failed'],
    ['E_INTERNAL_SERVER_ERROR', false, true, 502, 'delivery_unknown'],
    ['E_DELIVERY_FAILED', false, true, 502, 'delivery_unknown'],
    ['private key and recipient', false, true, 502, 'delivery_unknown'],
    [undefined, false, true, 502, 'delivery_unknown'],
  ]) {
    let calls = 0; const current = cfEnv();
    current.EMAIL.send = async () => { calls++; throw Object.assign(new Error('private key and recipient'), { code: providerCode }); };
    await assert.rejects(sendNotification(current, prepareNotification(current, message)), error => {
      fail(status, retryable, code)(error); assert.equal(error.deliveryUnknown, unknown);
      assert(!JSON.stringify(error).includes('private')); return true;
    });
    assert.equal(calls, 1);
  }
});

test('Cloudflare malformed successes and opaque timeouts park even if a send later succeeds', async () => {
  const { prepareNotification } = await import('../src/notifications.js');
  for (const result of [undefined, {}, { messageId: '' }, { messageId: 'private\r\nheader' }, { messageId: 'a'.repeat(257) }]) {
    const current = cfEnv(); current.EMAIL.send = async () => result;
    await assert.rejects(sendNotification(current, prepareNotification(current, message)), error => {
      fail(502, false, 'invalid_response')(error); assert.equal(error.deliveryUnknown, true); return true;
    });
  }
  const current = cfEnv(); let finish, calls = 0;
  current.EMAIL.send = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  await assert.rejects(sendNotification(current, prepareNotification(current, message), { timeoutMs: 5 }), error => {
    fail(0, false, 'timeout')(error); assert.equal(error.deliveryUnknown, true); return true;
  });
  finish({ messageId: 'late-accepted' }); await Promise.resolve();
  assert.equal(calls, 1, 'adapter never retries an opaque binding operation');
});
