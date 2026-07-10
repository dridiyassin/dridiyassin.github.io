(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { source: '', svg: null, selected: null, elements: [], tracks: [], playing: false, started: 0, raf: 0, total: 0 };
  var DRAWABLE = 'path,rect,circle,ellipse,line,polyline,polygon,g,text,use';
  var demo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420" width="640" height="420"><rect width="640" height="420" rx="34" fill="#141b19"/><circle cx="320" cy="190" r="104" fill="none" stroke="#5cb692" stroke-width="10"/><path d="M245 205 C270 105 370 105 395 205 C370 290 270 290 245 205Z" fill="#5cb692" opacity=".22"/><path d="M268 206 L304 242 L378 164" fill="none" stroke="#f0efec" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><text x="320" y="350" fill="#f0efec" font-family="system-ui,sans-serif" font-size="36" text-anchor="middle">Make it move</text></svg>';

  function persist() {
    if (!state.source) return;
    try { localStorage.setItem('planetsvg_animator_autosave', JSON.stringify({ source: state.source, tracks: state.tracks, at: Date.now() })); }
    catch (_) {}
  }

  function setStatus(msg, ok) { $('status').textContent = msg; $('status').className = 'status' + (ok ? ' ok' : ''); }
  function safeName(el) { return el.id ? '#' + el.id : '<' + el.tagName.toLowerCase() + '>'; }
  function sanitize(svg) {
    svg.querySelectorAll('script,foreignObject,iframe,object,embed').forEach(function (n) { n.remove(); });
    svg.querySelectorAll('*').forEach(function (el) {
      Array.from(el.attributes).forEach(function (a) {
        if (/^on/i.test(a.name) || (/(?:href|src)$/i.test(a.name) && /^\s*(?:javascript|data:text\/html)/i.test(a.value))) el.removeAttribute(a.name);
      });
    });
  }
  function loadSource(text, restoredTracks) {
    if (text.length > 2097152) return setStatus('That SVG is larger than 2 MB.', false);
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return setStatus('This file is not valid SVG.', false);
    sanitize(svg); svg.removeAttribute('style'); svg.classList.add('fastsvg-root');
    state.source = new XMLSerializer().serializeToString(svg); state.tracks = Array.isArray(restoredTracks) ? restoredTracks : []; state.selected = null;
    mount(svg); persist(); setStatus('SVG loaded. Select an element to animate.', true);
  }
  function mount(svg) {
    $('stage').innerHTML = ''; state.svg = document.importNode(svg, true); $('stage').appendChild(state.svg); $('empty').hidden = true;
    state.elements = Array.from(state.svg.querySelectorAll(DRAWABLE)).filter(function (el) { return !el.closest('defs,clipPath,mask,pattern'); });
    state.elements.forEach(function (el, i) { el.setAttribute('data-fastsvg-id', 'el-' + i); });
    state.svg.addEventListener('click', function (e) { var el = e.target.closest('[data-fastsvg-id]'); if (el) { e.stopPropagation(); select(el.getAttribute('data-fastsvg-id')); } });
    renderElements(); renderTracks(); updateCSS(); $('b-export').disabled = false; $('b-css').disabled = false;
  }
  function renderElements() {
    var box = $('elements'); box.innerHTML = ''; $('element-count').textContent = state.elements.length ? state.elements.length + ' found' : '';
    if (!state.elements.length) { box.innerHTML = '<div class="empty-list">No drawable elements found.</div>'; return; }
    state.elements.forEach(function (el, i) { var b = document.createElement('button'); b.className = 'element-btn'; b.dataset.id = 'el-' + i; b.innerHTML = '<code>' + String(i + 1).padStart(2, '0') + '</code><span></span>'; b.querySelector('span').textContent = safeName(el); b.onclick = function () { select(b.dataset.id); }; box.appendChild(b); });
  }
  function select(id) {
    state.selected = id; state.elements.forEach(function (e) { e.classList.toggle('fastsvg-selected', e.getAttribute('data-fastsvg-id') === id); });
    document.querySelectorAll('.element-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.id === id); });
    var el = state.elements.find(function (e) { return e.getAttribute('data-fastsvg-id') === id; });
    $('selected-name').textContent = safeName(el); $('editor').setAttribute('aria-disabled', 'false');
    if (!/^(path|line|polyline|polygon|circle|ellipse|rect)$/i.test(el.tagName) && $('effect').value === 'draw') $('effect').value = 'fade';
  }
  function addTrack() {
    if (!state.selected) return;
    var duration = Math.max(.1, parseFloat($('duration').value) || 1), delay = Math.max(0, parseFloat($('delay').value) || 0);
    state.tracks.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2), target: state.selected, effect: $('effect').value, duration: duration, delay: delay, easing: $('easing').value, iterations: $('iterations').value });
    renderTracks(); updateCSS(); persist(); restart(); setStatus('Animation added.', true);
  }
  function effectLabel(s) { return ({ draw:'Draw path', fade:'Fade in', 'slide-up':'Slide up', 'slide-right':'Slide right', scale:'Scale in', rotate:'Rotate in', pulse:'Pulse' })[s] || s; }
  function renderTracks() {
    var box = $('tracks'); box.innerHTML = ''; $('track-count').textContent = state.tracks.length;
    if (!state.tracks.length) { box.innerHTML = '<div class="empty-list">No animations yet.</div>'; }
    state.tracks.forEach(function (t) { var item = document.createElement('div'); item.className = 'track'; item.innerHTML = '<b></b><span></span><button title="Remove animation">×</button>'; item.querySelector('b').textContent = effectLabel(t.effect) + ' · ' + t.target; item.querySelector('span').textContent = t.delay.toFixed(1) + 's delay · ' + t.duration.toFixed(1) + 's · ' + (t.iterations === 'infinite' ? 'loops' : t.iterations + '×'); item.querySelector('button').onclick = function () { state.tracks = state.tracks.filter(function (x) { return x.id !== t.id; }); renderTracks(); updateCSS(); persist(); }; box.appendChild(item); });
  }
  function keyframes(t, el) {
    if (t.effect === 'draw') { var len = 1000; try { len = Math.ceil(el.getTotalLength()); } catch (_) {} return { rules: 'from{stroke-dashoffset:' + len + '}to{stroke-dashoffset:0}', setup: 'stroke-dasharray:' + len + ';stroke-dashoffset:' + len + ';' }; }
    if (t.effect === 'fade') return { rules: 'from{opacity:0}to{opacity:1}', setup: '' };
    if (t.effect === 'slide-up') return { rules: 'from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}', setup: '' };
    if (t.effect === 'slide-right') return { rules: 'from{opacity:0;transform:translateX(-40px)}to{opacity:1;transform:translateX(0)}', setup: '' };
    if (t.effect === 'scale') return { rules: 'from{opacity:0;transform:scale(.2)}to{opacity:1;transform:scale(1)}', setup: '' };
    if (t.effect === 'rotate') return { rules: 'from{opacity:0;transform:rotate(-120deg) scale(.5)}to{opacity:1;transform:rotate(0) scale(1)}', setup: '' };
    return { rules: '0%,100%{transform:scale(1)}50%{transform:scale(1.12)}', setup: '' };
  }
  function buildCSS(exportMode) {
    var rules = [], assignments = [];
    state.tracks.forEach(function (t, i) { var el = state.elements.find(function (x) { return x.getAttribute('data-fastsvg-id') === t.target; }); if (!el) return; var k = keyframes(t, el), name = 'fastsvg-' + i; rules.push('@keyframes ' + name + '{' + k.rules + '}'); assignments.push('[data-fastsvg-id="' + t.target + '"]{' + k.setup + 'transform-box:fill-box;transform-origin:center;animation:' + name + ' ' + t.duration + 's ' + t.easing + ' ' + t.delay + 's ' + t.iterations + ' both' + (exportMode && !$('autoplay').checked ? ';animation-play-state:paused' : '') + '}'); });
    return rules.join('\n') + '\n' + assignments.join('\n');
  }
  function updateCSS() {
    if (!state.svg) return; var old = state.svg.querySelector('#fastsvg-styles'); if (old) old.remove();
    var style = document.createElementNS('http://www.w3.org/2000/svg', 'style'); style.id = 'fastsvg-styles'; style.textContent = buildCSS(false); state.svg.insertBefore(style, state.svg.firstChild);
    state.total = state.tracks.reduce(function (m, t) { return t.iterations === 'infinite' ? Math.max(m, t.delay + t.duration) : Math.max(m, t.delay + t.duration * Number(t.iterations)); }, 0);
    $('duration-label').textContent = 'Timeline: ' + state.total.toFixed(2) + 's'; $('scrubber').max = Math.max(state.total, .01); $('scrubber').value = 0;
  }
  function restart() { if (!state.svg) return; cancelAnimationFrame(state.raf); state.svg.querySelectorAll('[data-fastsvg-id]').forEach(function (e) { e.style.animation = 'none'; void e.getBoundingClientRect(); e.style.animation = ''; }); state.started = performance.now(); state.playing = true; $('b-play').textContent = '❚❚ Pause'; tick(); }
  function tick() { if (!state.playing) return; var elapsed = (performance.now() - state.started) / 1000, total = state.total || 1; $('scrubber').value = Math.min(elapsed, total); $('time-label').textContent = Math.min(elapsed, total).toFixed(2) + 's'; if (elapsed >= total) { if ($('loop').checked && state.tracks.length) return restart(); state.playing = false; $('b-play').textContent = '▶ Play'; return; } state.raf = requestAnimationFrame(tick); }
  function togglePlay() { if (!state.svg) return; if (state.playing) { state.playing = false; cancelAnimationFrame(state.raf); state.svg.querySelectorAll('[data-fastsvg-id]').forEach(function (e) { e.style.animationPlayState = 'paused'; }); $('b-play').textContent = '▶ Play'; } else { state.svg.querySelectorAll('[data-fastsvg-id]').forEach(function (e) { e.style.animationPlayState = 'running'; }); state.started = performance.now() - Number($('scrubber').value) * 1000; state.playing = true; $('b-play').textContent = '❚❚ Pause'; tick(); } }
  function scrub() { if (!state.svg) return; state.playing = false; cancelAnimationFrame(state.raf); var v = Number($('scrubber').value); $('time-label').textContent = v.toFixed(2) + 's'; state.tracks.forEach(function (t, i) { var el = state.svg.querySelector('[data-fastsvg-id="' + t.target + '"]'); if (el) { var k = keyframes(t, el); el.style.animation = 'fastsvg-' + i + ' ' + t.duration + 's ' + t.easing + ' ' + (-v + t.delay) + 's ' + t.iterations + ' both paused'; if (k.setup) el.style.cssText += k.setup; } }); $('b-play').textContent = '▶ Play'; }
  function exportSVG() { if (!state.svg) return; var clone = state.svg.cloneNode(true), style = clone.querySelector('#fastsvg-styles'); if (style) style.textContent = buildCSS(true); clone.querySelectorAll('.fastsvg-selected').forEach(function (e) { e.classList.remove('fastsvg-selected'); }); clone.querySelectorAll('[data-fastsvg-id]').forEach(function (e) { e.removeAttribute('style'); }); clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); var blob = new Blob([new XMLSerializer().serializeToString(clone)], { type:'image/svg+xml' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'animated.svg'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); setStatus('Animated SVG exported.', true); }
  function copyCSS() { navigator.clipboard.writeText(buildCSS(true)).then(function () { setStatus('Animation CSS copied.', true); }, function () { setStatus('Could not access the clipboard.', false); }); }
  function clearAll() { state = { source:'', svg:null, selected:null, elements:[], tracks:[], playing:false, started:0, raf:0, total:0 }; try { localStorage.removeItem('planetsvg_animator_autosave'); } catch (_) {} $('stage').innerHTML = ''; $('empty').hidden = false; $('editor').setAttribute('aria-disabled', 'true'); $('selected-name').textContent = 'select an element'; $('b-export').disabled = true; $('b-css').disabled = true; renderElements(); renderTracks(); setStatus('Import an SVG to begin.'); }
  function readFile(file) { if (!file) return; if (file.size > 2097152) return setStatus('That SVG is larger than 2 MB.'); var reader = new FileReader(); reader.onload = function () { loadSource(String(reader.result)); }; reader.onerror = function () { setStatus('Could not read that file.'); }; reader.readAsText(file); }

  $('svg-file').onchange = function (e) { readFile(e.target.files[0]); e.target.value = ''; }; $('b-demo').onclick = function () { loadSource(demo); }; $('b-clear').onclick = clearAll; $('b-add').onclick = addTrack; $('b-play').onclick = togglePlay; $('b-restart').onclick = restart; $('scrubber').oninput = scrub; $('b-export').onclick = exportSVG; $('b-css').onclick = copyCSS;
  ['dragenter','dragover'].forEach(function (n) { $('drop-zone').addEventListener(n, function (e) { e.preventDefault(); $('drop-zone').classList.add('over'); }); }); ['dragleave','drop'].forEach(function (n) { $('drop-zone').addEventListener(n, function (e) { e.preventDefault(); $('drop-zone').classList.remove('over'); }); }); $('drop-zone').addEventListener('drop', function (e) { readFile(e.dataTransfer.files[0]); });
  var restored = false;
  try {
    var handoff = localStorage.getItem('planetsvg_animator_handoff');
    if (handoff) {
      var handed = JSON.parse(handoff); localStorage.removeItem('planetsvg_animator_handoff');
      if (handed && handed.svg) { loadSource(handed.svg); setStatus('Design opened from the Editor. Select an element to animate.', true); restored = true; }
    }
    if (!restored) {
      var saved = JSON.parse(localStorage.getItem('planetsvg_animator_autosave') || 'null');
      if (saved && saved.source) { loadSource(saved.source, saved.tracks); setStatus('Your local animation draft was restored.', true); restored = true; }
    }
  } catch (_) {}
  if (!restored) { renderElements(); renderTracks(); }
})();
