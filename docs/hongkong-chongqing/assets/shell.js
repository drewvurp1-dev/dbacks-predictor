/* Shared shell behaviour: the slide-in sidebar nav.
   Progressive enhancement — with no JS, the hub page still links every day,
   and every day page keeps its bottom prev/next/overview bar. */
(function () {
  var body = document.body;
  var drawer = document.getElementById('drawer');
  var scrim = document.getElementById('scrim');
  var toggle = document.getElementById('navToggle');
  if (!drawer || !scrim || !toggle) return;

  function open() {
    drawer.classList.add('open');
    scrim.classList.add('open');
    body.classList.add('no-scroll');
    toggle.setAttribute('aria-expanded', 'true');
  }
  function close() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    body.classList.remove('no-scroll');
    toggle.setAttribute('aria-expanded', 'false');
  }
  toggle.addEventListener('click', function () {
    drawer.classList.contains('open') ? close() : open();
  });
  scrim.addEventListener('click', close);
  drawer.addEventListener('click', function (e) {
    if (e.target.closest('a')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  // mark the current page in the nav
  var here = (location.pathname.split('/').pop() || 'index.html');
  var links = drawer.querySelectorAll('nav a');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href') || '';
    if (href === here || (here === '' && href === 'index.html')) {
      links[i].setAttribute('aria-current', 'page');
    }
  }
})();
