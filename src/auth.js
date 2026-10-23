import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// 31 characters: A-Z and 2-9 without 0, O, 1, I and L, which are easy to
// misread on a projector or type wrongly on a phone.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

// randomInt uses the OS's secure random source, so codes can't be predicted.
export function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// 32 random bytes is 256 bits: impossible to guess. base64url keeps it safe
// to put in a URL.
export function generateHostToken() {
  return randomBytes(32).toString('base64url');
}

// Only the hash is stored, so a leaked database does not hand out host links.
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

// Compares in constant time, so the response time leaks nothing about how
// many bytes of a guessed token were right.
export function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || token.length === 0 || !storedHash) return false;
  const candidate = hashToken(token);
  return candidate.length === storedHash.length && timingSafeEqual(candidate, storedHash);
}

// Reads "Authorization: Bearer <token>"; returns null when absent.
export function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}
