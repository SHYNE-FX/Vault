// crypto.js — AES-256-GCM + PBKDF2 helpers. No plaintext ever touches storage.

const PBKDF2_ITER = 210000;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(password, saltB64, extractable = false) {
  const salt = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16)).buffer;
  const enc = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
  return { key, saltB64: saltB64 || bufToB64(salt) };
}

async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: bufToB64(iv), data: bufToB64(cipher) };
}

async function decryptJSON(key, payload) {
  const iv = new Uint8Array(b64ToBuf(payload.iv));
  const cipher = b64ToBuf(payload.data);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function generateWrappingKey() {
  // Non-extractable AES key kept in IndexedDB. Used to wrap the master password
  // for biometric quick-unlock. Gated by a WebAuthn user-verification assertion.
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapString(key, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(str));
  return { iv: bufToB64(iv), data: bufToB64(cipher) };
}
async function unwrapString(key, payload) {
  const iv = new Uint8Array(b64ToBuf(payload.iv));
  const cipher = b64ToBuf(payload.data);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

const VaultCrypto = { deriveKey, encryptJSON, decryptJSON, generateWrappingKey, wrapString, unwrapString, bufToB64, b64ToBuf };
