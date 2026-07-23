/**
 * Symmetric encryption for small secrets stored at rest (currently: users'
 * BYO Google API keys — see google-budget.ts). AES-256-GCM, key derived
 * from API_KEY_ENCRYPTION_SECRET via SHA-256 so the env var itself can be
 * any length/format.
 */
import crypto from 'node:crypto';

function deriveKey(): Buffer {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('API_KEY_ENCRYPTION_SECRET is not set — required to store/read encrypted per-user API keys.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

// Output format: base64(iv) . base64(authTag) . base64(ciphertext), joined
// by ":" — everything needed to decrypt except the key itself.
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const key = deriveKey();
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf-8');
}
