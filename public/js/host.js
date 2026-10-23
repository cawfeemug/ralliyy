import { api } from './api.js';
import { banner, copyText, el, emptyState, icon, showToast, spinner } from './ui.js';

// Host page: /host/CODE#token. The token sits after the # so browsers never
// send it to the server in the URL or in Referer headers; only our own API
// calls send it, in the Authorization header.
const app = document.getElementById('app');
const code = decodeURIComponent(window.location.pathname.split('/')[2] ?? '').toUpperCase();
const hostToken = window.location.hash.slice(1);

const state = {
  view: 'loading', // loading | ready | notfound | error
  session: null,
};

function setState(patch) {
  Object.assign(state, patch);
  render();
}

async function load() {
  setState({ view: 'loading' });
  try {
    const res = await api('GET', `/api/sessions/${code}`, { hostToken });
    // A wrong or missing token looks the same as a missing session, so a
    // broken link reveals nothing about whether the session exists.
    if (!res.ok || !res.data.isHost) return setState({ view: 'notfound' });
    document.title = `Host · ${res.data.session.title} · Ralliyy`;
    setState({ view: 'ready', session: res.data.session });
  } catch {
    setState({ view: 'error' });
  }
}

function shareCard(session) {
  return el('section', { class: 'card share', 'aria-label': 'Join this session' },
    el('h2', { class: 'share__heading' }, 'Join this session'),
    el('p', { class: 'share__code' }, session.code),
    el('div', { class: 'share__qr' },
      el('img', { src: `/api/sessions/${session.code}/qr.svg`, alt: `QR code linking to ${session.joinUrl}`, width: 160, height: 160 })),
    el('p', { class: 'share__url t-meta' }, session.joinUrl.replace(/^https?:\/\//, '')),
    el('button', {
      class: 'btn btn--secondary btn--block', type: 'button',
      onclick: async () => { if (await copyText(session.joinUrl)) showToast('Copied to clipboard'); },
    }, 'Copy link'));
}

function render() {
  const { view, session } = state;

  if (view === 'loading') {
    return app.replaceChildren(el('div', { class: 'state-centre' }, spinner(true), 'Loading your session…'));
  }

  if (view === 'notfound' || view === 'error') {
    return app.replaceChildren(el('div', { class: 'column notfound' },
      view === 'error'
        ? banner('error', "Couldn't reach Ralliyy. Check your connection and try again.")
        : el('section', { class: 'card' }, emptyState('Session not found',
          'The code may be incorrect, the session may have been deleted, or the private host link may be broken. Check the link or code with your host.',
          { large: true })),
      view === 'error'
        ? el('button', { class: 'btn btn--primary btn--block state-actions', type: 'button', onclick: load }, 'Try again')
        : el('a', { class: 'btn btn--primary btn--block state-actions', href: '/' }, 'Back home')));
  }

  document.getElementById('host-label').textContent = session.hostName ? `Host · ${session.hostName}` : 'Host';

  app.replaceChildren(
    el('div', { class: 'host-top' },
      el('div', {},
        el('h1', { class: 't-page-title' }, session.title),
        el('div', { class: 'host-top__meta' },
          el('span', { class: 'badge' }, session.status === 'live' ? 'LIVE' : 'ENDED'),
          el('span', {}, `${session.participantCount} / ${session.participantLimit} participants`)))),
    el('div', { class: 'host-grid' },
      el('div', { class: 'host-grid__polls' },
        el('h2', { class: 'host-section-title' }, 'Polls'),
        el('section', { class: 'card' },
          emptyState('No polls yet', 'Create your first poll to hear from the room. Results will appear here when voting starts.')),
        el('h2', { class: 'host-section-title' }, 'Previous polls'),
        el('section', { class: 'card' },
          emptyState('No previous polls', 'Closed polls and their final results will stay here throughout the session.'))),
      el('div', { class: 'host-grid__share' }, shareCard(session)),
      el('div', { class: 'host-grid__qa' },
        el('h2', { class: 'host-section-title' }, 'Q&A'),
        el('p', { class: 't-meta' }, 'Sorted by most votes · 0 questions'),
        el('section', { class: 'card' },
          emptyState('No questions yet', 'Questions from participants will appear here. You can hide them from participants.')))),
    el('footer', { class: 'host-bottom t-meta' },
      el('span', {}, icon('shield'), ' Keep your private host link safe.')));
}

load();
