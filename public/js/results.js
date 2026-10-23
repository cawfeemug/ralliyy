import { api } from './api.js';
import { sortQuestions } from './live.js';
import {
  banner, copyText, el, emptyState, formatDate, formatDuration, icon, pollTotals, resultCard, showToast, spinner,
} from './ui.js';

// Results page: /r/CODE. Public and read-only. This is the basic version;
// M6 turns it into the full recap (stat tiles, timeline, vote shifts).
const app = document.getElementById('app');
const aside = document.getElementById('header-aside');
const code = decodeURIComponent(window.location.pathname.split('/')[2] ?? '').toUpperCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function footer() {
  return el('footer', { class: 'site-footer site-footer--ruled' }, icon('shield'), 'Anonymous. No account needed.');
}

function copyButton(extraClass) {
  return el('button', {
    class: `btn btn--secondary ${extraClass}`, type: 'button',
    onclick: async () => { if (await copyText(window.location.href)) showToast('Copied to clipboard'); },
  }, 'Copy link');
}

function pollCard(poll) {
  return el('section', { class: 'card results-poll' },
    el('p', { class: 'poll-meta__label' }, 'Single choice · Final results'),
    el('h3', { class: 'poll-question' }, poll.question),
    el('div', { class: 'poll-list' }, poll.options.map((o) => resultCard(o, { total: poll.totalVotes, bar: false }))),
    pollTotals(poll.totalVotes, ''));
}

function questionCard(q) {
  return el('article', { class: 'question' },
    el('p', { class: 'question__body results-q__body' }, q.body),
    el('p', { class: 'results-q__votes' }, plural(q.upvotes, 'vote')));
}

function renderEnded({ session, polls, questions }) {
  const visible = sortQuestions(questions);
  const end = session.endedAt;
  aside.replaceChildren(copyButton('results-copy--header'));
  app.replaceChildren(
    el('div', { class: 'results-head' },
      el('div', { class: 'results-head__top' },
        el('span', { class: 'poll-meta__label' }, 'Session recap'),
        el('span', { class: 'chip' }, 'Ended')),
      el('h1', { class: 't-display results-title' }, session.title),
      el('p', { class: 'results-meta' }, session.hostName ? `Hosted by ${session.hostName} · ${session.code}` : session.code),
      el('p', { class: 'results-meta' }, `${formatDate(session.createdAt)} · ${formatDuration(session.createdAt, end)}`),
      copyButton('btn--block results-copy--inline')),
    el('div', { class: 'results-grid' },
      el('section', { class: 'results-grid__polls', 'aria-labelledby': 'polls-title' },
        el('h2', { class: 'host-section-title', id: 'polls-title' }, 'Poll results'),
        polls.length
          ? polls.map(pollCard)
          : el('section', { class: 'card' }, emptyState('No polls', 'No polls were run in this session.'))),
      el('section', { class: 'results-grid__qa', 'aria-labelledby': 'qa-title' },
        el('h2', { class: 'host-section-title', id: 'qa-title' }, 'Top questions'),
        el('p', { class: 't-meta' }, `Most votes first · ${plural(visible.length, 'visible question')}`),
        visible.length
          ? visible.map(questionCard)
          : el('section', { class: 'card' }, emptyState('No questions', 'No questions were asked in this session.')))),
    footer());
}

function renderLive({ session, polls }) {
  const votes = polls.reduce((sum, p) => sum + p.totalVotes, 0);
  app.replaceChildren(
    el('div', { class: 'results-live' },
      banner('info', 'This session is still live. Results may change until voting ends.'),
      el('h1', { class: 't-page-title results-live__title' }, session.title),
      el('p', { class: 'results-meta' },
        `${plural(session.participantCount, 'participant')} · ${plural(votes, 'vote')} across ${plural(polls.length, 'poll')}`),
      el('a', { class: 'btn btn--primary btn--block', href: `/s/${session.code}` }, 'Join session'),
      footer()));
}

function renderNotFound() {
  app.replaceChildren(
    el('div', { class: 'results-live' },
      el('section', { class: 'card' }, emptyState('Session not found',
        'The code may be incorrect, or the host may have deleted this session and its results.', { large: true })),
      el('a', { class: 'btn btn--primary btn--block state-actions', href: '/' }, 'Back home'),
      footer()));
}

async function load() {
  app.replaceChildren(el('div', { class: 'state-centre' }, spinner(true), 'Loading session results…'));
  try {
    const res = await api('GET', `/api/sessions/${code}`);
    if (!res.ok) return renderNotFound();
    document.title = `${res.data.session.title} · Results · Ralliyy`;
    if (res.data.session.status === 'live') return renderLive(res.data);
    renderEnded(res.data);
  } catch {
    app.replaceChildren(
      banner('error', "Couldn't reach Ralliyy. Check your connection and try again."),
      el('button', { class: 'btn btn--primary btn--block state-actions', type: 'button', onclick: load }, 'Try again'));
  }
}

load();
