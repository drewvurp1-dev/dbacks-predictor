/* Shared shell behaviour:
   1. the slide-in sidebar nav
   2. light scrollytelling — reveal-on-scroll, cover-hero fade, app-bar melt

   Progressive enhancement — with no JS, the hub still links every day, every
   day page keeps its bottom prev/next bar, and all content is visible. */
(function () {
  var body = document.body;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. sidebar drawer ──────────────────────────────────────────── */
  (function () {
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
    drawer.addEventListener('click', function (e) { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    var here = (location.pathname.split('/').pop() || 'index.html');
    var links = drawer.querySelectorAll('nav a');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (href === here || (here === '' && href === 'index.html')) {
        links[i].setAttribute('aria-current', 'page');
      }
    }
  })();

  /* ── 2. reveal content as it scrolls into view ──────────────────── */
  (function () {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (reduce || !('IntersectionObserver' in window)) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('in');
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    els.forEach(function (el) { io.observe(el); });
  })();

  /* ── 3. cover hero: fade the plate on scroll, melt the app bar ──── */
  (function () {
    var hero = document.querySelector('.hero--full');
    if (!hero) return;

    // app bar starts transparent while the hero fills the screen
    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        body.classList.toggle('at-hero', entries[0].isIntersecting && entries[0].intersectionRatio > 0.55);
      }, { threshold: [0, 0.55, 1] });
      obs.observe(hero);
    }
    body.classList.add('at-hero');

    if (reduce) return;
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var p = Math.min(1, Math.max(0, window.scrollY / (hero.offsetHeight || 1)));
        hero.style.setProperty('--hero-scroll', p.toFixed(3));
        ticking = false;
      });
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  })();
})();
