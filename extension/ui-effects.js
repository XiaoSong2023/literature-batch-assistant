// Presentation-only behaviour for the dashboard. Nothing here touches queue state.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Section tabs with a sliding indicator, scroll-spy and a stuck-state style. */
export function initNavigation() {
  const nav = document.querySelector('.feature-nav');
  const tabs = [...nav.querySelectorAll('.nav-tab')];
  const indicator = nav.querySelector('.nav-indicator');
  const sections = tabs.map(tab => document.getElementById(tab.dataset.section));
  const backdrop = document.querySelector('.backdrop');
  let current = null, frame = 0;

  function place(tab) {
    if (!tab) { indicator.classList.remove('is-ready'); return; }
    indicator.style.setProperty('--x', `${tab.offsetLeft}px`);
    indicator.style.setProperty('--w', `${tab.offsetWidth}px`);
    indicator.style.top = `${tab.offsetTop}px`;
    indicator.style.height = `${tab.offsetHeight}px`;
    indicator.classList.add('is-ready');
  }
  function select(tab) {
    if (tab === current) return;
    current = tab;
    for (const item of tabs) {
      if (item === tab) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
    place(tab);
  }
  function update() {
    frame = 0;
    const line = innerHeight * .34;
    let active = tabs[0];
    sections.forEach((section, index) => { if (section.getBoundingClientRect().top <= line) active = tabs[index]; });
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) active = tabs.at(-1);
    select(active);
    nav.classList.toggle('is-stuck', nav.getBoundingClientRect().top <= 10.5 && scrollY > 0);
    if (!reduceMotion.matches) backdrop?.style.setProperty('--scroll', Math.round(Math.min(scrollY, 1600)));
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      document.getElementById(tab.dataset.section).scrollIntoView({behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start'});
      document.getElementById(tab.dataset.heading)?.focus({preventScroll: true});
      select(tab);
    });
  }
  addEventListener('scroll', schedule, {passive: true});
  addEventListener('resize', () => { const tab = current; current = null; select(tab); schedule(); });
  document.fonts?.ready.then(() => { const tab = current; current = null; select(tab); });
  update();
}

/** A soft highlight that follows the pointer across `.spot` elements. */
export function initSpotlight() {
  document.addEventListener('pointermove', event => {
    const target = event.target.closest?.('.spot');
    if (!target) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${event.clientX - box.left}px`);
    target.style.setProperty('--my', `${event.clientY - box.top}px`);
  }, {passive: true});
}

/** Drag-and-drop styling and a readable list of the chosen files. */
export function initDropZone(zone, input, list) {
  const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
  function refresh() {
    const files = [...input.files];
    list.replaceChildren(...files.map(file => {
      const item = document.createElement('li');
      const meta = document.createElement('b');
      meta.textContent = size(file.size);
      item.append(file.name, ' ', meta);
      item.title = file.name;
      return item;
    }));
    zone.classList.toggle('has-files', files.length > 0);
  }
  for (const type of ['dragenter', 'dragover']) input.addEventListener(type, () => zone.classList.add('is-dragging'));
  for (const type of ['dragleave', 'dragend', 'drop']) input.addEventListener(type, () => zone.classList.remove('is-dragging'));
  input.addEventListener('change', refresh);
  refresh();
  return {refresh};
}

/** A styled replacement for window.confirm. Resolves true only for the confirm button. */
export function confirmAction({title, message, confirmLabel = '确认', danger = false}) {
  const dialog = document.getElementById('confirmDialog');
  if (typeof dialog?.showModal !== 'function') return Promise.resolve(window.confirm(message));
  if (dialog.open) return Promise.resolve(false);
  dialog.querySelector('#confirmTitle').textContent = title;
  dialog.querySelector('#confirmBody').textContent = message;
  const ok = dialog.querySelector('#confirmOk');
  ok.textContent = confirmLabel;
  dialog.classList.toggle('danger', danger);
  dialog.returnValue = '';
  dialog.showModal();
  // A destructive action starts on Cancel so Enter never deletes by accident.
  (danger ? dialog.querySelector('#confirmCancel') : ok).focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once: true}));
}
