// Added-to-home-screen iOS apps run without Safari chrome, which is also where the native
// swipe-down-to-refresh gesture lives — standalone mode loses it entirely. This reimplements
// it by hand, gated to standalone mode only, so a normal browser tab (which still has the
// real gesture) isn't given a second, conflicting one.

const DEAD_ZONE = 20;        // px of travel ignored before anything happens — absorbs the
                              // incidental downward jitter in an ordinary scroll or tap
const DRAG_RESISTANCE = 0.4; // post-dead-zone travel is damped, same as native rubber-banding
const ARM_DISTANCE = 80;     // damped px needed to arm — works out to ~220px of real finger
                              // travel, deliberately "long" so a normal scroll can't reach it
const MAX_REVEAL = 56;       // matches --pull-refresh height in CSS
// A screen whose content fits the viewport (no overflow at all) reports scrollTop === 0
// everywhere on it, top or bottom — that alone can't tell "at the top" from "at the bottom"
// on a page like that. So the gesture must also *start* near the visible top of the screen;
// combined with the scrollTop check below, that's what actually pins this to the top.
const START_ZONE = 140;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function initPullToRefresh() {
  if (!isStandalone()) return;

  const indicator = document.getElementById('pull-refresh');
  if (!indicator) return;

  let startX = null;
  let startY = null;
  let pulling = false;   // touch began at scrollTop 0 — still a *candidate* gesture
  let dragging = false;  // confirmed vertical pull past the dead zone — now driving the UI
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
    startX = null;
    startY = null;
    pulling = false;
    dragging = false;
    armed = false;
  }

  document.addEventListener('touchstart', e => {
    if (document.body.classList.contains('modal-open')) return;
    if (e.touches.length !== 1) return;
    const touchY = e.touches[0].clientY;
    if (touchY > START_ZONE) return;
    const screen = activeScreen();
    if (!screen || screen.scrollTop > 0) return;
    startX = e.touches[0].clientX;
    startY = touchY;
    pulling = true;
    dragging = false;
    indicator.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling || startY === null) return;
    const screen = activeScreen();
    if (!screen || screen.scrollTop > 0) { reset(); return; }

    const deltaY = e.touches[0].clientY - startY;
    const deltaX = e.touches[0].clientX - startX;

    // A swipe that's more sideways than down isn't a pull — leave it alone entirely so it
    // can't be mistaken for one (or block whatever gesture it actually is).
    if (Math.abs(deltaX) > Math.abs(deltaY)) { reset(); return; }

    if (deltaY <= DEAD_ZONE) {
      // Still inside the dead zone (or moving up, e.g. a real scroll attempt): don't touch
      // the indicator and don't preventDefault, so normal scrolling/tapping is untouched.
      setReveal(0);
      armed = false;
      indicator.classList.remove('armed');
      return;
    }

    dragging = true;
    const dragged = (deltaY - DEAD_ZONE) * DRAG_RESISTANCE;
    setReveal(Math.min(dragged, MAX_REVEAL));
    armed = dragged >= ARM_DISTANCE;
    indicator.classList.toggle('armed', armed);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    if (dragging && armed) {
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
