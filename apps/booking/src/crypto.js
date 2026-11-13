const encoder = new TextEncoder();

export function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) throw new Error('Invalid encoded value');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), c => c.charCodeAt(0));
}
export function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) throw new Error('Invalid token size');
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function sha256(value) {
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
export async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [left, right] = await Promise.all([a, b].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(left, right);
  // The portable fallback always compares the complete fixed-size digests.
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
async function encryptionKey(value) {
  let bytes;
  try { bytes = decode(value); } catch { throw new Error('Invalid token encryption key'); }
  if (bytes.length !== 32) throw new Error('Invalid token encryption key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function associatedData(hostId) {
  if (typeof hostId !== 'string' || !hostId) throw new Error('Missing encryption binding');
  return encoder.encode(`email-booking:v1:${hostId}`);
}
export async function encryptTokens(tokens, keyBase64, hostId) {
  const key = await encryptionKey(keyBase64), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(hostId) }, key, encoder.encode(JSON.stringify(tokens)));
  return `v1.${base64url(iv)}.${base64url(ciphertext)}`;
}
export async function decryptTokens(envelope, keyBase64, hostId) {
  const key = await encryptionKey(keyBase64);
  try {
    const parts = typeof envelope === 'string' ? envelope.split('.') : [];
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error();
    const iv = decode(parts[1]);
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: associatedData(hostId) }, key, decode(parts[2]));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch { throw new Error('Unable to decrypt stored credentials'); }
}
