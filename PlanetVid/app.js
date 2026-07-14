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

  const QUALITY = { // [label, x264 crf, vpx crf, webp q]
    0: ['smaller file', 30, 40, 55],
    1: ['balanced', 24, 32, 75],
    2: ['best quality', 19, 24, 90],
  };
  // kind: 'video' (full A/V), 'anim' (silent animation), 'audio' (audio only)
  const FORMATS = {
    mp4:  { ext: 'mp4',  mime: 'video/mp4',        kind: 'video' },
    webm: { ext: 'webm', mime: 'video/webm',       kind: 'video' },
    webm9:{ ext: 'webm', mime: 'video/webm',       kind: 'video' },
    mkv:  { ext: 'mkv',  mime: 'video/x-matroska', kind: 'video' },
    mov:  { ext: 'mov',  mime: 'video/quicktime',  kind: 'video' },
    gif:  { ext: 'gif',  mime: 'image/gif',        kind: 'anim' },
    webp: { ext: 'webp', mime: 'image/webp',       kind: 'anim' },
    mp3:  { ext: 'mp3',  mime: 'audio/mpeg',       kind: 'audio' },
    m4a:  { ext: 'm4a',  mime: 'audio/mp4',        kind: 'audio' },
    ogg:  { ext: 'ogg',  mime: 'audio/ogg',        kind: 'audio' },
    opus: { ext: 'opus', mime: 'audio/ogg',        kind: 'audio' },
    flac: { ext: 'flac', mime: 'audio/flac',       kind: 'audio' },
    wav:  { ext: 'wav',  mime: 'audio/wav',        kind: 'audio' },
  };

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
    const kind = FORMATS[f].kind;
    const lossless = f === 'wav' || f === 'flac';
    $('res-field').hidden = kind === 'audio';
    $('fps-field').hidden = kind === 'audio';
    $('rotate-field').hidden = kind === 'audio';
    $('q-field').hidden = kind === 'audio' || f === 'gif'; // gif quality comes from its palette
    $('abr-field').hidden = kind === 'anim' || lossless;
    $('mute-field').style.visibility = kind === 'video' ? 'visible' : 'hidden';
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
    const spec = FORMATS[fmt];
    const qi = Number($('q-range').value);
    const q = QUALITY[qi];
    const height = Number($('res-select').value);
    const fps = Number($('fps-select').value);          // 0 = keep original
    const speed = parseFloat($('speed-select').value) || 1;
    const rotate = $('rotate-select').value;            // '', 'cw', 'ccw', '180'
    const abr = $('abr-select').value + 'k';
    const start = parseFloat($('trim-start').value);
    const len = parseFloat($('trim-len').value);
    const mute = $('mute-chk').checked;

    const args = [];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', inName);
    if (len > 0) args.push('-t', String(len));

    if (spec.kind === 'audio') {
      args.push('-vn');
      if (speed !== 1) args.push('-af', 'atempo=' + speed);
      if (fmt === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', abr);
      else if (fmt === 'm4a') args.push('-c:a', 'aac', '-b:a', abr);
      else if (fmt === 'ogg') args.push('-c:a', 'libvorbis', '-b:a', abr);
      else if (fmt === 'opus') args.push('-c:a', 'libopus', '-b:a', abr);
      else if (fmt === 'flac') args.push('-c:a', 'flac');
      else args.push('-c:a', 'pcm_s16le');
      args.push(outName);
      return args;
    }

    // shared video filter chain, in processing order
    const vf = [];
    if (speed !== 1) vf.push('setpts=PTS/' + speed);
    if (rotate === 'cw') vf.push('transpose=1');
    else if (rotate === 'ccw') vf.push('transpose=2');
    else if (rotate === '180') vf.push('transpose=1', 'transpose=1');

    if (fmt === 'gif') {
      const h = height > 0 ? height : 480;
      vf.push('fps=' + (fps || 12), 'scale=-2:min(' + h + '\\,ih):flags=lanczos');
      // one-pass palette for far better colors than the default 256-color dither
      args.push('-filter_complex', vf.join(',') +
        ',split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5');
      args.push('-loop', '0', outName);
      return args;
    }

    if (height > 0) vf.push('scale=-2:min(' + height + '\\,ih)');
    if (fps > 0) vf.push('fps=' + fps);
    if (vf.length) args.push('-vf', vf.join(','));

    if (fmt === 'webp') {
      args.push('-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q[3]), '-loop', '0', '-an');
      args.push(outName);
      return args;
    }

    if (fmt === 'webm') {
      args.push('-c:v', 'libvpx', '-crf', String(q[2]), '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '5');
      if (mute) args.push('-an'); else args.push('-c:a', 'libvorbis', '-b:a', abr);
    } else if (fmt === 'webm9') {
      args.push('-c:v', 'libvpx-vp9', '-crf', String(q[2]), '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '5');
      if (mute) args.push('-an'); else args.push('-c:a', 'libopus', '-b:a', abr);
    } else { // mp4, mkv, mov — H.264 + AAC
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q[1]), '-pix_fmt', 'yuv420p');
      if (mute) args.push('-an'); else args.push('-c:a', 'aac', '-b:a', abr);
      if (fmt !== 'mkv') args.push('-movflags', '+faststart');
    }
    if (!mute && speed !== 1) args.push('-af', 'atempo=' + speed);
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
    const spec = FORMATS[fmt];
    const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, 'mp4'])[1].toLowerCase();
    const inName = 'input.' + ext;
    const outName = 'output.' + spec.ext;

    try {
      const ff = await getEngine();
      setProgress(null, 'Reading file…');
      const { fetchFile } = window.FFmpegUtil;
      await ff.writeFile(inName, await fetchFile(file));
      setProgress(0, 'Converting…');
      await ff.exec(buildArgs(inName, outName));
      const data = await ff.readFile(outName);
      if (!data || data.length < 100) throw new Error('FFmpeg produced no output.');
      const blob = new Blob([data.buffer], { type: spec.mime });
      const url = URL.createObjectURL(blob);

      previewEl.innerHTML = '';
      let el;
      if (spec.kind === 'anim') { el = document.createElement('img'); el.src = url; el.alt = 'Converted animation'; }
      else if (spec.kind === 'audio') { el = document.createElement('audio'); el.src = url; el.controls = true; }
      else { el = document.createElement('video'); el.src = url; el.controls = true; }
      previewEl.appendChild(el);

      const base = file.name.replace(/\.[a-z0-9]+$/i, '');
      const dl = $('btn-download');
      dl.href = url;
      dl.download = base + '.' + spec.ext;
      $('result-info').textContent = fmtBytes(blob.size) + ' · ' + file.name + ' → ' + base + '.' + spec.ext;
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
