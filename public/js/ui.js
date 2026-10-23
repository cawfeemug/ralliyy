// Shared UI helpers. User-provided text only ever goes in through
// textContent (via el()), never innerHTML, so it can't inject markup.

// el('p', { class: 'x' }, 'text', child) -> <p class="x">text<child/></p>
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Static icon markup written by us, not by users, so innerHTML is safe here.
const ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warning: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  shield: '<path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M6 19v-5M12 19V7M18 19v-9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  up: '<path d="m7 14 5-5 5 5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
};

export function icon(name) {
  const template = document.createElement('template');
  template.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return template.content.firstChild;
}

// kind: 'info' | 'warning' | 'error' | 'success'
export function banner(kind, ...content) {
  return el('div', { class: `banner banner--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'success' ? 'check' : kind), el('div', { class: 'banner__text' }, ...content));
}

// A banner with a close button.
export function dismissibleBanner(kind, text, onClose) {
  const node = banner(kind, text);
  node.append(el('button', { class: 'banner__close', type: 'button', 'aria-label': 'Dismiss', onclick: onClose }, icon('close')));
  return node;
}

export function spinner(large = false) {
  return el('span', { class: large ? 'spinner spinner--large' : 'spinner', 'aria-hidden': 'true' });
}

export function emptyState(title, text, { large = false } = {}) {
  return el('div', { class: large ? 'empty empty--large' : 'empty' },
    el('div', { class: 'empty__icon' }, icon('chart')),
    el(large ? 'h1' : 'h3', { class: 'empty__title' }, title),
    el('p', { class: 'empty__text' }, text));
}

// Shows a busy state on a button and blocks repeat clicks until done.
export function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.replaceChildren(spinner(), busyLabel);
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.replaceChildren(button.dataset.label ?? '');
  }
}

let toastTimer;
export function showToast(message) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const toast = el('div', { class: 'toast', role: 'status' },
    icon('check'),
    el('span', { class: 'toast__text' }, message),
    el('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss', onclick: () => toast.remove() }, icon('close')));
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 3000);
}

// The Clipboard API only works on HTTPS or localhost. Over plain HTTP (for
// example a phone testing against a laptop's IP) fall back to the old
// select-and-copy method.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { readonly: true });
    // Set through the style object, not a style attribute, so a strict
    // Content Security Policy still allows it.
    Object.assign(area.style, { position: 'fixed', opacity: '0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// Shows a live "12 / 80" counter for a text field.
export function bindCounter(input, counter) {
  const update = () => { counter.textContent = `${[...input.value].length} / ${input.maxLength}`; };
  input.addEventListener('input', update);
  update();
}

// ---------- Poll pieces shared by the participant and host pages ----------

export const percent = (votes, total) => (total > 0 ? Math.round((votes / total) * 100) : 0);
export const pollNumber = (n) => String(n).padStart(2, '0');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One option's result. Pass onclick to make it a button (changing a vote).
export function resultCard(option, { total, mine = false, bar = true, onclick, disabled = false }) {
  const pct = percent(option.votes, total);
  const votes = mine
    ? el('span', { class: 'result__votes' }, icon('check'), `Your vote · ${plural(option.votes, 'vote')}`)
    : el('span', { class: 'result__votes' }, plural(option.votes, 'vote'));
  const children = [
    el('div', { class: 'result__label' }, option.label),
    el('div', { class: 'result__row' }, votes, el('span', { class: 'result__pct' }, `${pct}%`)),
  ];
  if (bar) {
    const fill = el('div', { class: 'result__fill' });
    fill.style.width = `${pct}%`; // CSSOM, so a strict CSP still allows it
    children.push(el('div', { class: 'result__bar', 'aria-hidden': 'true' }, fill));
  }
  const cls = mine ? 'result result--mine' : 'result';
  return onclick
    ? el('button', { class: cls, type: 'button', onclick, disabled, 'aria-pressed': mine ? 'true' : 'false' }, ...children)
    : el('div', { class: cls }, ...children);
}

export function pollTotals(total, right) {
  return el('div', { class: 'poll-totals' },
    el('span', { class: 'poll-totals__count' }, plural(total, 'total vote')),
    el('span', { class: 't-meta' }, right));
}

// "Just now", "5 min ago", "2 h ago". now is passed in so a whole list uses
// the same clock.
export function timeAgo(iso, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// ---------- Question pieces shared by the participant and host pages ----------

// The upvote count in a pill. Pass onclick to make it a button.
export function upvotePill(question, { onclick, disabled = false } = {}) {
  const children = [icon('up'), el('span', {}, String(question.upvotes))];
  if (!onclick) {
    return el('span', { class: 'upvote', 'aria-label': plural(question.upvotes, 'upvote') }, ...children);
  }
  return el('button', {
    class: question.upvoted ? 'upvote upvote--on' : 'upvote', type: 'button', onclick, disabled,
    'aria-pressed': question.upvoted ? 'true' : 'false',
    'aria-label': `${question.upvoted ? 'Remove upvote' : 'Upvote'} · ${plural(question.upvotes, 'upvote')}`,
  }, ...children);
}
