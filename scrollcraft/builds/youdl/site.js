/* Page-local product interaction. ScrollCraft itself stays unmodified. */
(function () {
  'use strict';
  var route = document.querySelector('.route-map');
  var captions = {
    browser: 'Start in your browser. Choose a video, then pick a format.',
    computer: 'The local helper runs yt-dlp on this computer. The browser connects to 127.0.0.1.',
    files: 'The finished video is written to your Downloads folder. It is not uploaded to youDl.'
  };
  var nodes = Array.from(document.querySelectorAll('[data-stop]'));
  var caption = document.querySelector('.route-caption');
  nodes.forEach(function (node) {
    node.addEventListener('click', function () {
      var stop = node.dataset.stop;
      route.dataset.active = stop;
      nodes.forEach(function (item) {
        var active = item === node;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      caption.textContent = captions[stop];
    });
  });

  var folioLinks = Array.from(document.querySelectorAll('[data-folio]'));
  var sections = folioLinks.map(function (link) { return document.getElementById(link.dataset.folio); });
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        folioLinks.forEach(function (link) {
          var current = link.hash === '#' + entry.target.id;
          link.classList.toggle('is-current', current);
          if (current) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-28% 0px -62% 0px' });
    sections.forEach(function (section) { observer.observe(section); });
  }

  if (window.ScrollCraft) ScrollCraft.mount(document.body);
  var download = document.querySelector('.download-link');
  download.addEventListener('click', function () {
    document.getElementById('download-message').textContent = 'Your bundle is downloading. Start with the included SETUP.md.';
  });
}());
