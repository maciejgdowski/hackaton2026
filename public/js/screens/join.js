// Join screen: name, then either "Create lobby" (zone radius + max players) or "Join" (4-letter code).
// A shared link ?code=ABCD opens the Join panel with the code filled in.
import { api, session } from '../api.js';
import { $, showError } from '../dom.js';
import { getLocation, rememberFix, startTracking } from '../location.js';

const NAME_KEY = 'oos-name';
const form = $('join-form');
const onlyLetters = value => value.toUpperCase().replace(/[^A-Z]/g, '');

// After joining from a shared link, a reload shouldn't open the Join panel again (keeps ?debug etc.).
function dropCodeFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code')) return;
  url.searchParams.delete('code');
  history.replaceState(null, '', url);
}

function setMode(mode) { // '' | 'create' | 'join'
  form.dataset.mode = mode;
  showError('');
  $('choose').hidden = mode !== '';
  $('create-opts').hidden = mode !== 'create';
  $('join-opts').hidden = mode !== 'join';
  if (mode === 'join') $('code').focus();
}

// Segmented buttons (radius, players): one pressed at a time.
function initChoice(group) {
  group.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    for (const option of group.children) option.setAttribute('aria-pressed', option === button);
  });
}
const chosen = group => Number(group.querySelector('[aria-pressed="true"]').dataset.value);

async function submit(event, onJoined) {
  event.preventDefault();
  showError('');
  const mode = form.dataset.mode;
  if (!mode) return; // Enter on the name field: wait for Create / Join
  if (mode === 'join' && $('code').value.length !== 4) return showError('Enter the 4-letter lobby code.');

  const name = $('name').value;
  const button = mode === 'create' ? $('do-create') : $('do-join');
  button.disabled = true;

  // Ask for the position right away so the map can start flying in while we join.
  const firstFix = getLocation().then(rememberFix).catch(() => {});
  try {
    const joined = mode === 'create'
      ? await api('create', { name, radius: chosen($('opt-radius')), maxPlayers: chosen($('opt-max')) })
      : await api('join', { name, code: $('code').value });
    session.start(joined.token);
    localStorage.setItem(NAME_KEY, name.trim());
    dropCodeFromUrl();
    setMode('');
    await onJoined();
    firstFix.then(startTracking).catch(() => {});
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

export function initJoin({ onJoined }) {
  initChoice($('opt-radius'));
  initChoice($('opt-max'));

  $('go-create').onclick = () => { if (form.reportValidity()) setMode('create'); };
  $('go-join').onclick = () => { if (form.reportValidity()) setMode('join'); };
  for (const back of form.querySelectorAll('.back')) back.onclick = () => setMode('');
  $('code').addEventListener('input', () => { $('code').value = onlyLetters($('code').value); });
  form.addEventListener('submit', event => submit(event, onJoined));

  $('name').value = localStorage.getItem(NAME_KEY) || '';
  const sharedCode = new URLSearchParams(location.search).get('code');
  if (sharedCode) {
    $('code').value = onlyLetters(sharedCode).slice(0, 4);
    setMode('join');
  }
}
