import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

// Browsers only load what these directives allow, so an injected script or
// stylesheet from anywhere else is refused. Everything Ralliyy needs is on
// our own origin except the Inter font from Google.
export function securityHeaders({ baseUrl = process.env.BASE_URL, production = process.env.NODE_ENV === 'production' } = {}) {
  // CSP 'self' covers same-origin WebSockets in current browsers, but Safari
  // before 15 ignored that, so name the socket origin explicitly when we know it.
  const socketOrigin = wsOrigin(baseUrl);

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // The pages load ES modules from /js; no inline scripts anywhere.
        'script-src': ["'self'"],
        // Our stylesheet plus the Google Fonts stylesheet.
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        // The QR code is an <img> served by our own API.
        'img-src': ["'self'", 'data:'],
        // REST calls and the Socket.IO connection, both same-origin.
        'connect-src': socketOrigin ? ["'self'", socketOrigin] : ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        // Nobody may put Ralliyy in an iframe (clickjacking).
        'frame-ancestors': ["'none'"],
        // Only in production: locally the site is plain http on localhost.
        ...(production ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    // Lets the QR image and fonts load normally; the default blocks them.
    crossOriginEmbedderPolicy: false,
    // A join link opened from another site should still reach us.
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Only tell browsers to stay on https once we are actually on https.
    strictTransportSecurity: production ? { maxAge: 15552000, includeSubDomains: true } : false,
    // Send the full URL to ourselves, only the origin to other sites.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Same answer as frame-ancestors above, for browsers reading this header.
    xFrameOptions: { action: 'deny' },
  });
}

// https://ralliyy.onrender.com -> wss://ralliyy.onrender.com
function wsOrigin(baseUrl) {
  if (!baseUrl) return null;
  try {
    const { protocol, host } = new URL(baseUrl);
    return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
  } catch {
    return null;
  }
}

// Everyone in a lecture hall shares one public IP, so per-IP limits must fit
// a whole room. Per-participant limits do the fine-grained work: the id is a
// random value the browser stores, so it is a courtesy limit, not a defence.
// ipKeyGenerator normalises IPv6 addresses into a /56 block.
const byParticipant = (req) => req.get('X-Participant-Id') || ipKeyGenerator(req.ip);

function limiter({ windowMs, max, keyGenerator, message }) {
  return rateLimit({
    windowMs,
    limit: max,
    keyGenerator,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Matches the error shape every other route returns.
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message } });
    },
  });
}

// Fresh counters per call, so one test's requests never limit another's.
export function createLimiters() {
  return {
    // A ceiling for the whole API. 50 participants polling and voting stay
    // far below this; a script hammering the server does not.
    api: limiter({
      windowMs: 10 * 60 * 1000,
      max: 1000,
      message: 'Too many requests. Please wait a moment and try again.',
    }),
    // Creating sessions is the most expensive thing an anonymous caller can do.
    createSession: limiter({
      windowMs: 60 * 60 * 1000,
      max: 20,
      message: 'Too many sessions created from this network. Please try again later.',
    }),
    vote: limiter({
      windowMs: 60 * 1000,
      max: 30,
      keyGenerator: byParticipant,
      message: 'Too many votes. Please wait a moment.',
    }),
    question: limiter({
      windowMs: 60 * 1000,
      max: 5,
      keyGenerator: byParticipant,
      message: 'Too many questions. Please wait a moment before asking again.',
    }),
    upvote: limiter({
      windowMs: 60 * 1000,
      max: 60,
      keyGenerator: byParticipant,
      message: 'Too many upvotes. Please wait a moment.',
    }),
  };
}
