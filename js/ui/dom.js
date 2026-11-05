// Small DOM helpers (no framework).

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div', {class: 'x', onclick: fn}, child, 'text') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer = 0;
export function toast(message, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const openSheets = [];
export function openSheet(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('open')) return;
  el.classList.add('open');
  openSheets.push(id);
  el.dispatchEvent(new Event('sheetopen'));
}

export function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  const i = openSheets.lastIndexOf(id);
  if (i >= 0) openSheets.splice(i, 1);
  el.dispatchEvent(new Event('sheetclose'));
}

export function isSheetOpen(id) {
  return document.getElementById(id)?.classList.contains('open') || false;
}

export function wireSheetCloseButtons() {
  for (const btn of document.querySelectorAll('.sheet [data-close]')) {
    btn.addEventListener('click', () => closeSheet(btn.closest('.sheet').id));
  }
}

/** Banner with optional action button. Returns a function that hides it. */
export function banner(text, { action, onAction, warn = false } = {}) {
  const el = $('#banner');
  $('#bannerText').textContent = text;
  const btn = $('#bannerAction');
  btn.hidden = !action;
  btn.textContent = action || '';
  btn.onclick = action ? () => { hide(); onAction?.(); } : null;
  el.classList.toggle('warn', warn);
  el.hidden = false;
  function hide() { el.hidden = true; }
  $('#bannerClose').onclick = hide;
  return hide;
}

export function hideBanner() {
  const el = $('#banner');
  if (el) el.hidden = true;
}
