/* PlanetVid - in-browser video converter powered by ffmpeg.wasm (single-thread core). */
(function () {
  'use strict';

  const CDN_FFMPEG = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd';
  const CDN_UTIL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd';
  const CDN_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

  const $ = (id) => document.getElementById(id);
  const drop = $('drop');
  const fileInput = $('file-input');
  const btnConvert = $('btn-convert');
  const progPanel = $('progress-panel');
  const progFill = $('prog-fill');
  const progLabel = $('prog-label');
  const progPct = $('prog-pct');
  const logEl = $('log');
  const resultEl = $('result');
  const previewEl = $('preview');

  const QUALITY = { // [label, x264 crf, vpx crf]
    0: ['smaller file', 30, 40],
    1: ['balanced', 24, 32],
    2: ['best quality', 19, 24],
  };
  const MIME = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', mp3: 'audio/mpeg', wav: 'audio/wav' };

  let file = null;
  let ffmpeg = null;
  let busy = false;

  /* ── file selection ──────────────────────────────────── */

  function setFile(f) {
    if (!f) return;
    file = f;
    $('file-name').textContent = f.name + ' (' + fmtBytes(f.size) + ')';
    $('drop-inner').hidden = true;
    $('file-info').hidden = false;
    btnConvert.disabled = false;
    resultEl.hidden = true;
  }

  drop.addEventListener('click', () => { if (!busy) fileInput.click(); });
  $('btn-change').addEventListener('click', (e) => { e.stopPropagation(); if (!busy) fileInput.click(); });
  fileInput.addEventListener('change', (e) => setFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (!busy) setFile(e.dataTransfer.files[0]);
  });

  /* ── options UI ──────────────────────────────────────── */

  $('q-range').addEventListener('input', () => {
    $('q-val').textContent = QUALITY[$('q-range').value][0];
  });
  $('fmt-select').addEventListener('change', () => {
    const f = $('fmt-select').value;
    const isAudio = f === 'mp3' || f === 'wav';
    $('res-field').hidden = isAudio;
    $('q-field').hidden = f === 'gif' || f === 'wav';
    $('fps-field').hidden = f !== 'gif';
    $('mute-field').style.visibility = (isAudio || f === 'gif') ? 'hidden' : 'visible';
  });

  /* ── engine loading ──────────────────────────────────── */

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => fail(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function getEngine() {
    if (ffmpeg) return ffmpeg;
    setProgress(null, 'Downloading conversion engine (one time, ~30 MB)…');
    await loadScript(CDN_FFMPEG + '/ffmpeg.js');
    await loadScript(CDN_UTIL + '/index.js');
    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => {
      logEl.textContent += message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });
    inst.on('progress', ({ progress }) => {
      if (progress > 0 && progress <= 1) setProgress(progress, 'Converting…');
    });
    await inst.load({
      coreURL: await toBlobURL(CDN_CORE + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(CDN_CORE + '/ffmpeg-core.wasm', 'application/wasm'),
      classWorkerURL: await toBlobURL(CDN_FFMPEG + '/814.ffmpeg.js', 'text/javascript'),
    });
    ffmpeg = inst;
    return ffmpeg;
  }

  /* ── conversion ──────────────────────────────────────── */

  function buildArgs(inName, outName) {
    const fmt = $('fmt-select').value;
    const q = QUALITY[$('q-range').value];
    const height = Number($('res-select').value);
    const start = parseFloat($('trim-start').value);
    const len = parseFloat($('trim-len').value);
    const mute = $('mute-chk').checked;

    const args = [];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', inName);
    if (len > 0) args.push('-t', String(len));

    const scale = height > 0 ? 'scale=-2:min(' + height + '\\,ih)' : null;

    if (fmt === 'mp4') {
      if (scale) args.push('-vf', scale);
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q[1]), '-pix_fmt', 'yuv420p');
      if (mute) args.push('-an'); else args.push('-c:a', 'aac', '-b:a', '128k');
      args.push('-movflags', '+faststart');
    } else if (fmt === 'webm') {
      if (scale) args.push('-vf', scale);
      args.push('-c:v', 'libvpx', '-crf', String(q[2]), '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '5');
      if (mute) args.push('-an'); else args.push('-c:a', 'libvorbis', '-b:a', '128k');
    } else if (fmt === 'gif') {
      const fps = $('fps-select').value;
      const h = height > 0 ? height : 480;
      args.push('-vf', 'fps=' + fps + ',scale=-2:min(' + h + '\\,ih):flags=lanczos', '-loop', '0');
    } else if (fmt === 'mp3') {
      args.push('-vn', '-c:a', 'libmp3lame', '-q:a', String([6, 4, 2][$('q-range').value]));
    } else if (fmt === 'wav') {
      args.push('-vn', '-c:a', 'pcm_s16le');
    }
    args.push(outName);
    return args;
  }

  function setProgress(ratio, label) {
    progPanel.hidden = false;
    progLabel.textContent = label;
    if (ratio === null) {
      progFill.classList.add('indet');
      progPct.textContent = '';
    } else {
      progFill.classList.remove('indet');
      progFill.style.width = Math.round(ratio * 100) + '%';
      progPct.textContent = Math.round(ratio * 100) + '%';
    }
  }

  function showError(err) {
    setProgress(0, 'Failed');
    progLabel.textContent = '✗ Conversion failed';
    let note = progPanel.querySelector('.error-note');
    if (!note) {
      note = document.createElement('p');
      note.className = 'error-note';
      progPanel.insertBefore(note, progPanel.querySelector('.log-wrap'));
    }
    note.textContent = (err && err.message ? err.message : String(err)) +
      '\nTry a shorter clip or a different output format - details are in the FFmpeg log below.';
  }

  btnConvert.addEventListener('click', async () => {
    if (!file || busy) return;
    busy = true;
    btnConvert.disabled = true;
    resultEl.hidden = true;
    logEl.textContent = '';
    const note = progPanel.querySelector('.error-note');
    if (note) note.remove();

    const fmt = $('fmt-select').value;
    const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, 'mp4'])[1].toLowerCase();
    const inName = 'input.' + ext;
    const outName = 'output.' + fmt;

    try {
      const ff = await getEngine();
      setProgress(null, 'Reading file…');
      const { fetchFile } = window.FFmpegUtil;
      await ff.writeFile(inName, await fetchFile(file));
      setProgress(0, 'Converting…');
      await ff.exec(buildArgs(inName, outName));
      const data = await ff.readFile(outName);
      if (!data || data.length < 100) throw new Error('FFmpeg produced no output.');
      const blob = new Blob([data.buffer], { type: MIME[fmt] });
      const url = URL.createObjectURL(blob);

      previewEl.innerHTML = '';
      let el;
      if (fmt === 'gif') { el = document.createElement('img'); el.src = url; el.alt = 'Converted GIF'; }
      else if (fmt === 'mp3' || fmt === 'wav') { el = document.createElement('audio'); el.src = url; el.controls = true; }
      else { el = document.createElement('video'); el.src = url; el.controls = true; }
      previewEl.appendChild(el);

      const base = file.name.replace(/\.[a-z0-9]+$/i, '');
      const dl = $('btn-download');
      dl.href = url;
      dl.download = base + '.' + fmt;
      $('result-info').textContent = fmtBytes(blob.size) + ' · ' + file.name + ' → ' + base + '.' + fmt;
      setProgress(1, 'Finished');
      resultEl.hidden = false;
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // free filesystem memory
      try { await ff.deleteFile(inName); await ff.deleteFile(outName); } catch (_) {}
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      busy = false;
      btnConvert.disabled = !file;
    }
  });

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
})();
