const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const usernamePattern = /^[a-z0-9_-]{1,32}$/;
export const passwordPattern = /^[A-Za-z0-9_-]{22}$/;
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function base64(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(value);
}

export function unbase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function base64url(bytes) {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unbase64url(value) {
  return unbase64(value.replaceAll("-", "+").replaceAll("_", "/"));
}

export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hash(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function verifyPassword(pepper, username, password, verifier) {
  const key = await crypto.subtle.importKey(
    "raw", unbase64url(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, unbase64url(verifier), encoder.encode(`${username}\0${password}`));
}

export async function encryptRecords(key, month, records) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`carrot-v1:${month}`) },
    key,
    encoder.encode(JSON.stringify(records)),
  );
  return { v: 1, nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) };
}

export async function decryptRecords(key, month, envelope) {
  if (envelope.v !== 1 || typeof envelope.nonce !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Invalid encryption envelope");
  }
  const nonce = unbase64(envelope.nonce);
  if (nonce.length !== 12) throw new Error("Invalid nonce");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`carrot-v1:${month}`) },
    key,
    unbase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}
