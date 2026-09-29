import { createHmac, randomUUID } from 'node:crypto';

type SignupKind = 'admin registration' | 'self-serve signup' | 'demo claim';

export interface NewSignupNotification {
  kind: SignupKind;
  id: string;
  username: string;
  email?: string | null;
  targetLanguage?: string | null;
  nativeLanguage?: string | null;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  zh: 'Chinese',
};

function displayLanguage(code: string | null | undefined): string {
  const normalized = code?.trim().toLowerCase();
  if (!normalized) return 'unset';
  return `${LANGUAGE_NAMES[normalized] ?? normalized} (${normalized})`;
}

function displayValue(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/[\r\n\t]+/g, ' ');
  return normalized ? normalized.slice(0, 240) : 'unset';
}

export function formatNewSignupNotification(details: NewSignupNotification): string {
  return [
    `New LingLang user signup (${details.kind})`,
    `Username: ${displayValue(details.username)}`,
    `Email: ${displayValue(details.email)}`,
    `Target language: ${displayLanguage(details.targetLanguage)}`,
    `Native language: ${displayLanguage(details.nativeLanguage)}`,
    `User ID: ${displayValue(details.id)}`,
  ].join('\n');
}

/**
 * Best-effort operator alert through Hermes' authenticated webhook endpoint.
 *
 * The dashboard never talks to Matrix directly and does not need a second bot
 * credential. Hermes receives the signed event and delivers it through the
 * already-connected Matrix gateway adapter. Notification failure must never
 * make signup fail: the account has already been persisted.
 */
export async function notifyNewSignup(details: NewSignupNotification): Promise<boolean> {
  const webhookUrl = process.env.LINGLANG_SIGNUP_WEBHOOK_URL?.replace(/\/+$/, '');
  const webhookSecret = process.env.LINGLANG_SIGNUP_WEBHOOK_SECRET;

  if (!webhookUrl || !webhookSecret) {
    console.warn('[SignupNotification] Hermes webhook is not configured');
    return false;
  }

  const body = JSON.stringify({
    event_type: 'linglang.signup',
    kind: details.kind,
    id: details.id,
    username: displayValue(details.username),
    email: displayValue(details.email),
    targetLanguage: details.targetLanguage?.trim().toLowerCase() || null,
    nativeLanguage: details.nativeLanguage?.trim().toLowerCase() || null,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature-V2': signature,
        'X-Request-ID': `linglang-signup-${details.id}-${randomUUID()}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[SignupNotification] Hermes webhook returned HTTP ${response.status}`);
      return false;
    }
    console.log(`[SignupNotification] Sent ${details.kind} alert for ${details.id}`);
    return true;
  } catch (error) {
    console.warn(
      `[SignupNotification] Failed to send Hermes webhook alert: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
