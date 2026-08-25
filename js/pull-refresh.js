// Added-to-home-screen iOS apps run without Safari chrome, which is also where the native
// swipe-down-to-refresh gesture lives — standalone mode loses it entirely. This reimplements
// it by hand, gated to standalone mode only, so a normal browser tab (which still has the
// real gesture) isn't given a second, conflicting one.

const PULL_THRESHOLD = 64; // px of actual finger travel needed to arm a refresh
const MAX_REVEAL = 56;     // matches --pull-refresh height in CSS
const DRAG_RESISTANCE = 0.5;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function initPullToRefresh() {
  if (!isStandalone()) return;

  const indicator = document.getElementById('pull-refresh');
  if (!indicator) return;

  let startY = null;
  let pulling = false;
  let armed = false;

  function activeScreen() {
    return document.querySelector('.screen:not([hidden])');
  }

  function setReveal(px) {
    indicator.style.transform = `translateY(${px - MAX_REVEAL}px)`;
  }

  function reset() {
    indicator.style.transition = 'transform 0.2s ease';
    setReveal(0);
    indicator.classList.remove('armed', 'loading');
    startY = null;
    pulling = false;
    armed = false;
  }

  document.addEventListener('touchstart', e => {
    if (document.body.classList.contains('modal-open')) return;
    if (e.touches.length !== 1) return;
    const screen = activeScreen();
    if (!screen || screen.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
    indicator.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling || startY === null) return;
    const screen = activeScreen();
    if (!screen || screen.scrollTop > 0) { reset(); return; }

    const delta = e.touches[0].clientY - startY;
    if (delta <= 0) { setReveal(0); armed = false; indicator.classList.remove('armed'); return; }

    const dragged = delta * DRAG_RESISTANCE;
    setReveal(Math.min(dragged, MAX_REVEAL));
    armed = dragged >= PULL_THRESHOLD;
    indicator.classList.toggle('armed', armed);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    if (armed) {
      indicator.style.transition = 'transform 0.2s ease';
      setReveal(MAX_REVEAL);
      indicator.classList.add('loading');
      // Brief pause so the spinner is actually seen before navigation tears the page down.
      setTimeout(() => window.location.reload(), 250);
    } else {
      reset();
    }
    pulling = false;
  });

  document.addEventListener('touchcancel', reset);
}
