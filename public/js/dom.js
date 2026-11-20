export const $ = id => document.getElementById(id);

// Toast at the bottom of the screen; disappears after 5 s.
let errorTimer = null;
export function showError(message) {
  clearTimeout(errorTimer);
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) errorTimer = setTimeout(() => { $('error').hidden = true; }, 5000);
}

// A player-list row: name on the left, small tags on the right.
export function listRow(name, tags, className = '') {
  const li = document.createElement('li');
  if (className) li.className = className;
  const nameEl = document.createElement('span');
  nameEl.textContent = name;
  const tagsEl = document.createElement('span');
  tagsEl.className = 'tags';
  tagsEl.textContent = tags.filter(Boolean).join(' · ');
  li.append(nameEl, tagsEl);
  return li;
}
