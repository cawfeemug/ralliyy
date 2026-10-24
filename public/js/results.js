import { api } from './api.js';
import { sortQuestions } from './live.js';
import {
  banner, copyText, el, emptyState, formatDate, formatDuration, icon, pollTotals, resultCard, showToast, spinner, svgEl,
} from './ui.js';

// Results page: /r/CODE. Public, read-only, and permanent: this is the recap
// a stranger sees long after the session ended.
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

function statTile(label, value, note) {
  return el('div', { class: 'card stat' },
    el('p', { class: 'stat__label' }, label),
    el('p', { class: 'stat__value' }, value),
    el('p', { class: 'stat__note' }, note));
}

function statTiles(stats) {
  return el('div', { class: 'stats' },
    statTile('Participants', stats.participants, 'Joined this session'),
    statTile('Participation rate',
      stats.participationRate === null ? '—' : `${stats.participationRate}%`,
      stats.participants ? `${stats.engaged} voted or asked` : 'Nobody joined'),
    statTile('Votes cast', stats.votesCast,
      stats.polls ? `Across ${plural(stats.polls, 'poll')}` : 'No polls were run'),
    statTile('Questions asked', stats.questionsAsked, `${stats.questionsVisible} publicly visible`));
}

// Bar chart of votes and questions over the session, drawn as inline SVG so
// the page needs no charting library.
const CHART = { width: 720, height: 150, gap: 6, pad: 2 };

function activityChart({ bucketMinutes, buckets }) {
  const peak = Math.max(1, ...buckets.map((b) => b.votes + b.questions));
  const slot = CHART.width / buckets.length;
  const barWidth = Math.max(3, Math.min(18, (slot - CHART.gap) / 2));
  const scale = (n) => (n / peak) * (CHART.height - CHART.pad);

  const bars = buckets.flatMap((bucket, i) => {
    const centre = i * slot + slot / 2;
    return [
      { x: centre - barWidth - 1, value: bucket.votes, kind: 'votes' },
      { x: centre + 1, value: bucket.questions, kind: 'questions' },
    ].map(({ x, value, kind }) => svgEl('rect', {
      class: `chart__bar chart__bar--${kind}`,
      x: x.toFixed(1),
      // SVG y grows downwards, so a bar starts where it ends and runs to the floor.
      y: (CHART.height - scale(value)).toFixed(1),
      width: barWidth.toFixed(1),
      height: Math.max(value > 0 ? 2 : 0, scale(value)).toFixed(1),
      rx: 2,
    }));
  });

  const totals = buckets.reduce((sum, b) => ({ votes: sum.votes + b.votes, questions: sum.questions + b.questions }),
    { votes: 0, questions: 0 });

  return el('div', { class: 'chart' },
    svgEl('svg', {
      class: 'chart__svg',
      viewBox: `0 0 ${CHART.width} ${CHART.height}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `Activity over the session: ${plural(totals.votes, 'vote')} and `
        + `${plural(totals.questions, 'question')} across ${plural(buckets.length, 'bar')} `
        + `of ${plural(bucketMinutes, 'minute')} each.`,
    }, bars),
    el('ol', { class: 'chart__axis', 'aria-hidden': 'true' },
      buckets.map((b) => el('li', {}, b.minute + bucketMinutes))));
}

function activityCard(timeline, stats) {
  const quiet = stats.voteActions === 0 && stats.questionsAsked === 0;
  const each = timeline.bucketMinutes === 1 ? '' : ` · each bar covers ${plural(timeline.bucketMinutes, 'minute')}`;
  return el('section', { class: 'card activity', 'aria-labelledby': 'activity-title' },
    el('h2', { class: 'card__title', id: 'activity-title' }, 'Session activity'),
    el('p', { class: 'card__subtitle' }, `Votes and questions over time${each}.`),
    quiet
      ? emptyState('Nothing happened yet', 'No votes were cast and no questions were asked.')
      : [
        el('ul', { class: 'legend' },
          el('li', { class: 'legend__item legend__item--votes' }, 'Votes'),
          el('li', { class: 'legend__item legend__item--questions' }, 'Questions')),
        activityChart(timeline),
        el('p', { class: 't-meta chart__caption' }, 'Minutes since the session started'),
      ]);
}

// "1 of 12 voters changed their mind · most moved Tea to Coffee"
function shiftNote({ voters, changedVoters, topMove }) {
  if (!voters) return null;
  if (!changedVoters) return el('p', { class: 't-meta poll-shift' }, 'Nobody changed their vote.');
  const text = `${changedVoters} of ${plural(voters, 'voter')} changed their mind`;
  const move = topMove?.fromLabel && topMove?.toLabel
    ? ` · most moved ${topMove.fromLabel} to ${topMove.toLabel}`
    : '';
  return el('p', { class: 't-meta poll-shift' }, text + move);
}

function pollCard(poll) {
  return el('section', { class: 'card results-poll' },
    el('p', { class: 'poll-meta__label' }, 'Single choice · Final results'),
    el('h3', { class: 'poll-question' }, poll.question),
    el('div', { class: 'poll-list' }, poll.options.map((o) => resultCard(o, { total: poll.totalVotes, bar: false }))),
    pollTotals(poll.totalVotes, ''),
    shiftNote(poll.shifts));
}

function questionCard(q) {
  return el('article', { class: 'question' },
    el('p', { class: 'question__body results-q__body' }, q.body),
    el('p', { class: 'results-q__votes' }, plural(q.upvotes, 'vote')));
}

function renderRecap({ session, stats, timeline, polls, questions }) {
  const visible = sortQuestions(questions);
  aside.replaceChildren(copyButton('results-copy--header'));
  app.replaceChildren(
    el('div', { class: 'results-head' },
      el('div', { class: 'results-head__top' },
        el('span', { class: 'poll-meta__label' }, 'Session recap'),
        el('span', { class: 'chip' }, 'Ended')),
      el('h1', { class: 't-display results-title' }, session.title),
      el('p', { class: 'results-meta' }, session.hostName ? `Hosted by ${session.hostName} · ${session.code}` : session.code),
      el('p', { class: 'results-meta' }, `${formatDate(session.createdAt)} · ${formatDuration(session.createdAt, session.endedAt)}`),
      copyButton('btn--block results-copy--inline')),
    statTiles(stats),
    activityCard(timeline, stats),
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

function renderLive({ session, stats }) {
  app.replaceChildren(
    el('div', { class: 'results-live' },
      banner('info', 'This session is still live. Results may change until voting ends.'),
      el('h1', { class: 't-page-title results-live__title' }, session.title),
      el('p', { class: 'results-meta' },
        `${plural(session.participantCount, 'participant')} · ${plural(stats.votesCast, 'vote')} across ${plural(stats.polls, 'poll')}`),
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

function renderLoading() {
  aside.replaceChildren();
  app.replaceChildren(
    el('div', { class: 'state-centre' }, spinner(true), 'Loading session recap…'),
    el('div', { class: 'stats stats--loading', 'aria-hidden': 'true' },
      [0, 1, 2, 3].map(() => el('div', { class: 'card stat stat--skeleton' }))));
}

async function load() {
  renderLoading();
  try {
    const res = await api('GET', `/api/sessions/${code}/recap`);
    if (!res.ok) return renderNotFound();
    document.title = `${res.data.session.title} · Recap · Ralliyy`;
    if (res.data.session.status === 'live') return renderLive(res.data);
    renderRecap(res.data);
  } catch {
    app.replaceChildren(
      banner('error', "Couldn't reach Ralliyy. Check your connection and try again."),
      el('button', { class: 'btn btn--primary btn--block state-actions', type: 'button', onclick: load }, 'Try again'));
  }
}

load();
