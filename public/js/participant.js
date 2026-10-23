// Each browser gets one random participant ID, kept in localStorage so the
// same person is recognised when they reload or come back. Clearing site
// data gives a new ID; that bypass is a known, accepted limit.
const KEY = 'ralliyy.participantId';

function randomUuid() {
  // crypto.randomUUID needs HTTPS or localhost; getRandomValues works on
  // plain HTTP too, which matters when testing from a phone on the LAN.
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let memoryId;
export function getParticipantId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = randomUuid();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Storage blocked (some private modes): keep an ID for this page only.
    memoryId ??= randomUuid();
    return memoryId;
  }
}
