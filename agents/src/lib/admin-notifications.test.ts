import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNewSignupNotification, notifyNewSignup } from './admin-notifications.js';

test('new signup notification includes account details but never credentials or IP data', () => {
  const message = formatNewSignupNotification({
    kind: 'self-serve signup',
    id: 'alice',
    username: 'Alice',
    email: 'alice@example.com',
    targetLanguage: 'pt',
    nativeLanguage: 'en',
  });

  assert.match(message, /New LingLang user signup/);
  assert.match(message, /Alice/);
  assert.match(message, /alice@example\.com/);
  assert.match(message, /Portuguese \(pt\)/);
  assert.match(message, /English \(en\)/);
  assert.doesNotMatch(message, /password|token|127\.0\.0\.1|secret/i);
});

test('notification transport sends a signed Hermes webhook event', async () => {
  const previous = {
    url: process.env.LINGLANG_SIGNUP_WEBHOOK_URL,
    secret: process.env.LINGLANG_SIGNUP_WEBHOOK_SECRET,
    fetch: globalThis.fetch,
  };
  let request: { url: string; init: RequestInit } | undefined;

  process.env.LINGLANG_SIGNUP_WEBHOOK_URL = 'http://127.0.0.1:8644/webhooks/signup';
  process.env.LINGLANG_SIGNUP_WEBHOOK_SECRET = 'test-secret';
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response('{}', { status: 200 });
  };

  try {
    assert.equal(
      await notifyNewSignup({
        kind: 'self-serve signup',
        id: 'carol',
        username: 'Carol',
        email: 'carol@example.com',
        targetLanguage: 'pt',
        nativeLanguage: 'en',
      }),
      true,
    );
  } finally {
    if (previous.url === undefined) delete process.env.LINGLANG_SIGNUP_WEBHOOK_URL;
    else process.env.LINGLANG_SIGNUP_WEBHOOK_URL = previous.url;
    if (previous.secret === undefined) delete process.env.LINGLANG_SIGNUP_WEBHOOK_SECRET;
    else process.env.LINGLANG_SIGNUP_WEBHOOK_SECRET = previous.secret;
    globalThis.fetch = previous.fetch;
  }

  assert.ok(request);
  assert.equal(request.url, 'http://127.0.0.1:8644/webhooks/signup');
  const headers = request.init.headers as Record<string, string>;
  assert.match(headers['X-Webhook-Timestamp'], /^\d+$/);
  assert.match(headers['X-Webhook-Signature-V2'], /^[a-f0-9]{64}$/);
  assert.match(headers['X-Request-ID'], /^linglang-signup-carol-/);
  assert.match(String(request.init.body), /Carol/);
  assert.match(String(request.init.body), /linglang\.signup/);
});

test('notification formatter handles unset language selections', () => {
  const message = formatNewSignupNotification({
    kind: 'demo claim',
    id: 'demo-123',
    username: 'Bob',
    email: 'bob@example.com',
    targetLanguage: null,
    nativeLanguage: null,
  });

  assert.match(message, /demo claim/);
  assert.match(message, /Target language: unset/);
  assert.match(message, /Native language: unset/);
});
