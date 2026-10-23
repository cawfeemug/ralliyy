import { api } from './api.js';
import { getParticipantId } from './participant.js';
import { banner, bindCounter, copyText, el, setBusy, showToast } from './ui.js';

const $ = (id) => document.getElementById(id);

// ---------- Create a session ----------

const createForm = $('create-form');
const titleInput = $('title');
const createBtn = $('create-btn');
const createNote = $('create-note');
const createFeedback = $('create-feedback');

bindCounter(titleInput, $('title-counter'));
bindCounter($('host-name'), $('host-counter'));

function setTitleError(message) {
  $('title-field').classList.toggle('field--error', Boolean(message));
  $('title-hint').hidden = !message;
  $('title-hint').textContent = message ?? '';
  titleInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

titleInput.addEventListener('input', () => setTitleError(null));

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  createFeedback.replaceChildren();
  const title = titleInput.value.trim();
  if (!title) {
    setTitleError('Enter a session title.');
    titleInput.focus();
    return;
  }

  setBusy(createBtn, true, 'Creating…');
  createNote.textContent = 'Creating your session. Please wait before submitting again.';
  try {
    const res = await api('POST', '/api/sessions', {
      body: { title, hostName: $('host-name').value.trim() || undefined },
    });
    if (res.ok) {
      openHostLinkModal(res.data);
      return;
    }
    createFeedback.replaceChildren(banner('error',
      res.status === 400 ? 'Check the session title and host name, then try again.' : 'Something went wrong. Please try again.'));
  } catch {
    createFeedback.replaceChildren(banner('error', "Couldn't reach Ralliyy. Check your connection and try again."));
  } finally {
    // Leave the button busy while the modal is open so it can't be resubmitted.
    if (!document.querySelector('.modal')) {
      setBusy(createBtn, false);
      createNote.textContent = "You'll get a private host link and a code to share.";
    }
  }
});

// The host link holds the secret token, and it is shown only once, so the
// host must save it before moving on.
function openHostLinkModal({ code, hostUrl }) {
  const copyBtn = el('button', { class: 'btn btn--secondary btn--block', type: 'button' }, 'Copy');
  copyBtn.addEventListener('click', async () => {
    if (await copyText(hostUrl)) showToast('Copied to clipboard');
  });

  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
    el('h2', { class: 'modal__title', id: 'modal-title' }, 'Save your host link'),
    el('p', { class: 'modal__body' },
      'This private link is the only way to control your session. If you lose it, you lose access to hosting. Keep it somewhere safe.'),
    el('div', { class: 'field home-modal__field' },
      el('span', { class: 'field__label home-modal__label' }, 'Private host URL · Read-only'),
      el('div', { class: 'readonly-value' }, hostUrl),
      el('p', { class: 'field__hint' }, "Don't share this link with participants. Share the code below instead.")),
    copyBtn,
    el('p', { class: 'home-modal__code-label t-meta' }, 'Participant join code'),
    el('p', { class: 'code-display' }, code),
    el('a', { class: 'btn btn--primary btn--block home-modal__continue', href: hostUrl }, 'Continue to host'));

  document.body.append(el('div', { class: 'modal-backdrop' }, modal));
  copyBtn.focus();
}

// ---------- Join a session ----------

const joinForm = $('join-form');
const codeInput = $('code');
const joinBtn = $('join-btn');
const joinNote = $('join-note');
const joinFeedback = $('join-feedback');
const CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/;

function showJoinFeedback(kind, ...content) {
  $('code-field').classList.toggle('field--error', kind === 'error');
  codeInput.setAttribute('aria-invalid', kind === 'error' ? 'true' : 'false');
  joinNote.hidden = Boolean(kind);
  joinFeedback.replaceChildren(kind ? banner(kind, ...content) : '');
}

codeInput.addEventListener('input', () => {
  // Uppercase as they type and drop spaces, keeping the caret in place.
  const pos = codeInput.selectionStart;
  codeInput.value = codeInput.value.toUpperCase().replace(/\s+/g, '');
  codeInput.setSelectionRange(pos, pos);
  showJoinFeedback(null);
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    showJoinFeedback('error', 'Enter all 6 characters of the code from your host.');
    codeInput.focus();
    return;
  }
  if (!CODE_PATTERN.test(code)) {
    // Contains a character no code uses (like 0 or O), so it can't exist.
    showJoinFeedback('error', 'Code not found. Check the 6-character code with your host and try again.');
    return;
  }

  setBusy(joinBtn, true, 'Joining…');
  try {
    const res = await api('POST', `/api/sessions/${code}/join`, { participantId: getParticipantId() });
    if (res.ok) {
      window.location.href = `/s/${code}`;
      return;
    }
    if (res.status === 404) {
      showJoinFeedback('error', 'Code not found. Check the 6-character code with your host and try again.');
    } else if (res.status === 409) {
      showJoinFeedback('warning', 'Session full. All 50 places are taken. Ask your host when a place is available.');
    } else if (res.status === 410) {
      showJoinFeedback('info',
        el('p', {}, 'This session has ended. Voting is closed, but you can still view the results.'),
        el('a', { class: 'banner__link', href: `/r/${code}` }, 'See results →'));
    } else {
      showJoinFeedback('error', 'Something went wrong. Please try again.');
    }
  } catch {
    showJoinFeedback('error', "Couldn't reach Ralliyy. Check your connection and try again.");
  }
  setBusy(joinBtn, false);
});
