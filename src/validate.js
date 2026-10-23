import { CODE_ALPHABET, CODE_LENGTH } from './auth.js';

export const LIMITS = {
  title: 80,
  hostName: 40,
  pollQuestion: 200,
  optionLabel: 80,
  minOptions: 2,
  maxOptions: 6,
  participantsPerSession: 50,
};

// Thrown for bad input; the error handler turns it into a 400 response.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Returns the normalised code, or null if it can't be a valid code.
export function parseCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

// Trims a text field and checks its length. Returns null for an empty
// optional field.
export function cleanText(value, { field, max, required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, 'invalid_input', `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_input', `${field} must be text`);
  }
  const text = value.trim();
  if (text.length === 0) {
    if (required) throw new HttpError(400, 'invalid_input', `${field} is required`);
    return null;
  }
  // Counted in characters, matching the database's char_length checks.
  if ([...text].length > max) {
    throw new HttpError(400, 'invalid_input', `${field} must be at most ${max} characters`);
  }
  return text;
}

// The participant ID is a random UUID the browser keeps in localStorage.
export function participantIdFrom(req) {
  const id = req.get('x-participant-id');
  if (!id || !UUID_PATTERN.test(id)) {
    throw new HttpError(400, 'invalid_participant', 'X-Participant-Id must be a UUID');
  }
  return id.toLowerCase();
}
