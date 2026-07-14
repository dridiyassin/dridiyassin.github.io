/* PlanetSVG Editor - compose icons from snapping vector shapes. All client-side. */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const CANVAS = 512;
  const SNAP_THR = 8;          // svg units
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const shapesG = $('shapes-g');
  const overlayG = $('overlay-g');
  const guideV = $('guide-v');
  const guideH = $('guide-h');

  const FILL_CYCLE = ['#5b9bff', '#ff9d5c', '#a879ff', '#4cd97b', '#ff5c7b', '#ffd45c', '#5ce0e0'];

  /* ══ shape generators ═══════════════════════════════════
     Each returns a path `d` for a shape centered on (0,0)
     inside a w×h box. p = shape-specific params.          */

  function P(rx, ry, deg) { // point on ellipse, 0° = up, clockwise
    const a = (deg - 90) * Math.PI / 180;
    return rx * Math.cos(a) + ' ' + ry * Math.sin(a);
  }

  function polyPts(rx, ry, n, rot0) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(P(rx, ry, rot0 + i * 360 / n));
    return pts;
  }

  function roundRect(rx, ry, r) {
    r = Math.max(0, Math.min(r, Math.min(rx, ry)));
    if (r < 0.5) return `M ${-rx} ${-ry} H ${rx} V ${ry} H ${-rx} Z`;
    return `M ${-rx + r} ${-ry} H ${rx - r} A ${r} ${r} 0 0 1 ${rx} ${-ry + r} V ${ry - r} A ${r} ${r} 0 0 1 ${rx - r} ${ry} H ${-rx + r} A ${r} ${r} 0 0 1 ${-rx} ${ry - r} V ${-ry + r} A ${r} ${r} 0 0 1 ${-rx + r} ${-ry} Z`;
  }

  const GEN = {
    circle: { name: 'Circle', d: (w, h) => { const rx = w / 2, ry = h / 2; return `M 0 ${-ry} A ${rx} ${ry} 0 1 1 0 ${ry} A ${rx} ${ry} 0 1 1 0 ${-ry} Z`; } },
    half: { name: 'Half circle', d: (w, h) => { const rx = w / 2, ry = h / 2; return `M ${-rx} ${ry} A ${rx} ${h} 0 0 1 ${rx} ${ry} Z`; } },
    quarter: { name: 'Quarter circle', d: (w, h) => { const rx = w / 2, ry = h / 2; return `M ${-rx} ${ry} L ${-rx} ${-ry} A ${w} ${h} 0 0 1 ${rx} ${ry} Z`; } },
    ring: {
      name: 'Ring', evenodd: true,
      params: [{ k: 't', label: 'Thickness %', min: 5, max: 95, step: 1, def: 34 }],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, k = 1 - p.t / 100, irx = rx * k, iry = ry * k;
        return `M 0 ${-ry} A ${rx} ${ry} 0 1 1 0 ${ry} A ${rx} ${ry} 0 1 1 0 ${-ry} Z ` +
               `M 0 ${-iry} A ${irx} ${iry} 0 1 0 0 ${iry} A ${irx} ${iry} 0 1 0 0 ${-iry} Z`;
      }
    },
    pie: {
      name: 'Pie',
      params: [{ k: 'a', label: 'Angle °', min: 10, max: 359, step: 1, def: 90 }],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, a = Math.min(p.a, 359.9), large = a > 180 ? 1 : 0;
        return `M 0 0 L ${P(rx, ry, -a / 2)} A ${rx} ${ry} 0 ${large} 1 ${P(rx, ry, a / 2)} Z`;
      }
    },
    arc: {
      name: 'Arc',
      params: [
        { k: 'a', label: 'Angle °', min: 10, max: 359, step: 1, def: 180 },
        { k: 't', label: 'Thickness %', min: 5, max: 95, step: 1, def: 34 }
      ],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, a = Math.min(p.a, 359.9), large = a > 180 ? 1 : 0, k = 1 - p.t / 100;
        return `M ${P(rx, ry, -a / 2)} A ${rx} ${ry} 0 ${large} 1 ${P(rx, ry, a / 2)} ` +
               `L ${P(rx * k, ry * k, a / 2)} A ${rx * k} ${ry * k} 0 ${large} 0 ${P(rx * k, ry * k, -a / 2)} Z`;
      }
    },
    rect: {
      name: 'Square',
      params: [{ k: 'r', label: 'Corner radius %', min: 0, max: 100, step: 1, def: 12 }],
      d: (w, h, p) => roundRect(w / 2, h / 2, Math.min(w, h) / 2 * p.r / 100)
    },
    rect_ring: {
      name: 'Hollow Square', evenodd: true,
      params: [
        { k: 't', label: 'Thickness %', min: 5, max: 95, step: 1, def: 30 },
        { k: 'r', label: 'Corner radius %', min: 0, max: 100, step: 1, def: 0 }
      ],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, k = 1 - p.t / 100, irx = rx * k, iry = ry * k;
        const outer = roundRect(rx, ry, Math.min(w, h) / 2 * p.r / 100);
        const inner = roundRect(irx, iry, Math.min(irx, iry) / 2 * p.r / 100);
        return `${outer} ${inner}`;
      }
    },
    custom: {
      name: 'Pen Path',
      d: (w, h, p) => {
        if (!p.pts || p.pts.length === 0) return 'M 0 0 Z';
        const getPtData = (pt) => {
          if (Array.isArray(pt)) return { x: pt[0], y: pt[1], h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } };
          return {
            x: pt.x, y: pt.y,
            h1: pt.h1 || { x: 0, y: 0 },
            h2: pt.h2 || { x: 0, y: 0 }
          };
        };
        let d = '';
        const pt0 = getPtData(p.pts[0]);
        const x0 = pt0.x * w;
        const y0 = pt0.y * h;
        d += `M ${x0} ${y0}`;
        for (let i = 1; i < p.pts.length; i++) {
          const prev = getPtData(p.pts[i - 1]);
          const curr = getPtData(p.pts[i]);
          const cp1x = (prev.x + prev.h2.x) * w;
          const cp1y = (prev.y + prev.h2.y) * h;
          const cp2x = (curr.x + curr.h1.x) * w;
          const cp2y = (curr.y + curr.h1.y) * h;
          const cx = curr.x * w;
          const cy = curr.y * h;
          d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${cx} ${cy}`;
        }
        const last = getPtData(p.pts[p.pts.length - 1]);
        const cp1x = (last.x + last.h2.x) * w;
        const cp1y = (last.y + last.h2.y) * h;
        const cp2x = (pt0.x + pt0.h1.x) * w;
        const cp2y = (pt0.y + pt0.h1.y) * h;
        const x0_end = pt0.x * w;
        const y0_end = pt0.y * h;
        d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x0_end} ${y0_end} Z`;
        return d;
      }
    },
    capsule: { name: 'Capsule', d: (w, h) => roundRect(w / 2, h / 2, Math.min(w, h) / 2) },
    triangle: { name: 'Triangle', d: (w, h) => { const rx = w / 2, ry = h / 2; return `M 0 ${-ry} L ${rx} ${ry} L ${-rx} ${ry} Z`; } },
    rtriangle: { name: 'Right triangle', d: (w, h) => { const rx = w / 2, ry = h / 2; return `M ${-rx} ${-ry} L ${rx} ${ry} L ${-rx} ${ry} Z`; } },
    diamond: { name: 'Diamond', d: (w, h) => { const rx = w / 2, ry = h / 2; return `M 0 ${-ry} L ${rx} 0 L 0 ${ry} L ${-rx} 0 Z`; } },
    pentagon: { name: 'Pentagon', d: (w, h) => 'M ' + polyPts(w / 2, h / 2, 5, 0).join(' L ') + ' Z' },
    hexagon: { name: 'Hexagon', d: (w, h) => 'M ' + polyPts(w / 2, h / 2, 6, 0).join(' L ') + ' Z' },
    star: {
      name: 'Star',
      params: [
        { k: 'n', label: 'Points', min: 3, max: 12, step: 1, def: 5 },
        { k: 'k', label: 'Inner radius %', min: 10, max: 90, step: 1, def: 45 }
      ],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, n = Math.round(p.n), k = p.k / 100, pts = [];
        for (let i = 0; i < n * 2; i++) {
          const outer = i % 2 === 0;
          pts.push(P(rx * (outer ? 1 : k), ry * (outer ? 1 : k), i * 180 / n));
        }
        return 'M ' + pts.join(' L ') + ' Z';
      }
    },
    heart: {
      name: 'Heart',
      d: (w, h) => {
        const rx = w / 2, ry = h / 2;
        return `M 0 ${-ry * 0.35} C ${-rx * 0.3} ${-ry} ${-rx} ${-ry * 0.7} ${-rx} ${-ry * 0.2} ` +
               `C ${-rx} ${ry * 0.25} ${-rx * 0.45} ${ry * 0.55} 0 ${ry} ` +
               `C ${rx * 0.45} ${ry * 0.55} ${rx} ${ry * 0.25} ${rx} ${-ry * 0.2} ` +
               `C ${rx} ${-ry * 0.7} ${rx * 0.3} ${-ry} 0 ${-ry * 0.35} Z`;
      }
    },
    drop: {
      name: 'Drop',
      d: (w, h) => {
        const rx = w / 2, ry = h / 2;
        return `M 0 ${-ry} C ${rx * 0.16} ${-ry * 0.5} ${rx} ${-ry * 0.18} ${rx} ${ry * 0.28} ` +
               `A ${rx} ${ry * 0.72} 0 1 1 ${-rx} ${ry * 0.28} C ${-rx} ${-ry * 0.18} ${-rx * 0.16} ${-ry * 0.5} 0 ${-ry} Z`;
      }
    },
    crescent: {
      name: 'Crescent',
      params: [{ k: 'k', label: 'Curve %', min: 10, max: 90, step: 1, def: 55 }],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2;
        return `M 0 ${-ry} A ${rx} ${ry} 0 1 1 0 ${ry} A ${rx * p.k / 100} ${ry} 0 1 0 0 ${-ry} Z`;
      }
    },
    cross: {
      name: 'Cross',
      params: [{ k: 't', label: 'Arm width %', min: 10, max: 90, step: 1, def: 36 }],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, a = rx * p.t / 100, b = ry * p.t / 100;
        return `M ${-a} ${-ry} H ${a} V ${-b} H ${rx} V ${b} H ${a} V ${ry} H ${-a} V ${b} H ${-rx} V ${-b} H ${-a} Z`;
      }
    },
    arrow: {
      name: 'Arrow',
      params: [{ k: 't', label: 'Shaft width %', min: 10, max: 90, step: 1, def: 36 }],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, t = ry * p.t / 100, hx = rx * 0.15;
        return `M ${-rx} ${-t} H ${hx} V ${-ry} L ${rx} 0 L ${hx} ${ry} V ${t} H ${-rx} Z`;
      }
    },
    hexagon_ring: {
      name: 'Hollow Hexagon', evenodd: true,
      params: [{ k: 't', label: 'Thickness %', min: 5, max: 95, step: 1, def: 30 }],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, k = 1 - p.t / 100;
        const outer = 'M ' + polyPts(rx, ry, 6, 0).join(' L ') + ' Z';
        const inner = 'M ' + polyPts(rx * k, ry * k, 6, 0).reverse().join(' L ') + ' Z';
        return `${outer} ${inner}`;
      }
    },
    star_ring: {
      name: 'Hollow Star', evenodd: true,
      params: [
        { k: 'n', label: 'Points', min: 3, max: 12, step: 1, def: 5 },
        { k: 'k', label: 'Inner radius %', min: 10, max: 90, step: 1, def: 45 },
        { k: 't', label: 'Thickness %', min: 5, max: 95, step: 1, def: 30 }
      ],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, n = Math.round(p.n), k = p.k / 100, t = 1 - p.t / 100;
        const outerPts = [];
        const innerPts = [];
        for (let i = 0; i < n * 2; i++) {
          const outer = i % 2 === 0;
          const rFactor = outer ? 1 : k;
          outerPts.push(P(rx * rFactor, ry * rFactor, i * 180 / n));
          innerPts.push(P(rx * rFactor * t, ry * rFactor * t, i * 180 / n));
        }
        const outer = 'M ' + outerPts.join(' L ') + ' Z';
        const inner = 'M ' + innerPts.reverse().join(' L ') + ' Z';
        return `${outer} ${inner}`;
      }
    },
    poly_ring: {
      name: 'Hollow Polygon', evenodd: true,
      params: [
        { k: 'n', label: 'Sides', min: 3, max: 12, step: 1, def: 5 },
        { k: 't', label: 'Thickness %', min: 5, max: 95, step: 1, def: 30 }
      ],
      d: (w, h, p) => {
        const rx = w / 2, ry = h / 2, n = Math.round(p.n), k = 1 - p.t / 100;
        const outer = 'M ' + polyPts(rx, ry, n, 0).join(' L ') + ' Z';
        const inner = 'M ' + polyPts(rx * k, ry * k, n, 0).reverse().join(' L ') + ' Z';
        return `${outer} ${inner}`;
      }
    }
  };
  const TYPES = Object.keys(GEN);

  const TAB_SHAPES = {
    circles: ['circle', 'half', 'quarter', 'ring', 'pie', 'arc'],
    squares: ['rect', 'rect_ring', 'capsule'],
    polygons: ['triangle', 'rtriangle', 'diamond', 'pentagon', 'hexagon', 'star', 'hexagon_ring', 'star_ring', 'poly_ring'],
    others: ['heart', 'drop', 'crescent', 'cross', 'arrow']
  };

  /* ══ state ══════════════════════════════════════════════ */

  let shapes = [];          // bottom → top
  let selIds = [];
  let idSeq = 1;
  let fillIdx = 0;
  let importSeq = 0;        // unique prefix counter for imported-SVG ids
  let pendingFile = null;   // file awaiting the non-SVG convert/abort choice
  const bg = { on: false, color: '#0d1220' };

  let activeTab = 'circles';
  let activeTool = 'select'; // 'select' or 'pen'
  let activePathPoints = [];
  let penHoverPt = null;
  let editNodeShapeId = null;

  const undoStack = [];
  const redoStack = [];
  function snapshot() { return JSON.stringify({ shapes, bg }); }
  function pushHistory() {
    const snap = snapshot();
    undoStack.push(snap);
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    try {
      localStorage.setItem('planetsvg_editor_autosave', snap);
    } catch (e) {
      console.warn('Failed to auto-save to localStorage', e);
    }
  }
  // Highest id used anywhere, including composite children — byId() recurses into
  // children, so a new shape reusing a child id would hijack selection and dragging.
  function maxShapeId(list) {
    let m = 0;
    for (const s of list) {
      m = Math.max(m, Number(s.id) || 0);
      if (s.type === 'composite' && s.p && Array.isArray(s.p.children)) m = Math.max(m, maxShapeId(s.p.children));
    }
    return m;
  }
  function restore(json) {
    const s = JSON.parse(json);
    shapes = s.shapes;
    bg.on = s.bg.on; bg.color = s.bg.color;
    idSeq = Math.max(idSeq, maxShapeId(shapes) + 1);
    selIds = selIds.filter(id => byId(id));
    $('bg-on').checked = bg.on;
    $('bg-color').value = bg.color;
    renderAll();
    try {
      localStorage.setItem('planetsvg_editor_autosave', JSON.stringify({ shapes, bg }));
    } catch (e) {
      console.warn('Failed to auto-save to localStorage', e);
    }
  }
  function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
  function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }

  const byId = (id) => {
    const findRec = (list) => {
      for (const s of list) {
        if (s.id === id) return s;
        if (s.type === 'composite' && s.p.children) {
          const found = findRec(s.p.children);
          if (found) return found;
        }
      }
      return null;
    };
    return findRec(shapes);
  };
  const selected = () => (selIds.length === 1 ? byId(selIds[0]) : null);
  const selectedShapes = () => shapes.filter(s => selIds.includes(s.id));

  function defaults(type) {
    const p = {};
    (GEN[type].params || []).forEach((d) => { p[d.k] = d.def; });
    return p;
  }

  function addShape(type) {
    pushHistory();
    const n = shapes.length;
    const s = {
      id: idSeq++, type,
      name: GEN[type].name + ' ' + idSeq,
      x: CANVAS / 2 + (n % 5) * 8 - 16, y: CANVAS / 2 + (n % 5) * 8 - 16,
      w: 192, h: 192, rot: 0, fh: 1, fv: 1,
      fill: FILL_CYCLE[fillIdx++ % FILL_CYCLE.length],
      op: 1, stroke: '#e8edf7', sw: 0,
      p: defaults(type)
    };
    shapes.push(s);
    selIds = [s.id];
    renderAll();
  }

  /* ══ rendering ══════════════════════════════════════════ */

  function shapeTransform(s) {
    let t = `translate(${round2(s.x)} ${round2(s.y)}) rotate(${round2(s.rot)})`;
    if (s.fh !== 1 || s.fv !== 1) t += ` scale(${s.fh} ${s.fv})`;
    return t;
  }
  const round2 = (v) => Math.round(v * 100) / 100;

  function renderSingleShape(s, isChildOfComposite = false) {
    if (s.type === 'composite') {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', shapeTransform(s));
      if (!isChildOfComposite) {
        g.setAttribute('class', 'shape');
        g.dataset.id = s.id;
      }

      const op = s.p.op; // 'union', 'subtract', 'intersect', 'exclude'
      const children = s.p.children;
      if (!children || children.length === 0) return g;

      if (op === 'union' || op === 'exclude') {
        for (const child of children) {
          const childEl = renderSingleShape(child, true);
          childEl.setAttribute('fill', s.fill);
          childEl.setAttribute('opacity', child.op * s.op);
          if (s.sw > 0) {
            childEl.setAttribute('stroke', s.stroke);
            childEl.setAttribute('stroke-width', s.sw);
          } else {
            childEl.removeAttribute('stroke');
            childEl.removeAttribute('stroke-width');
          }
          if (op === 'exclude') {
            childEl.setAttribute('fill-rule', 'evenodd');
          }
          g.appendChild(childEl);
        }
      } else if (op === 'subtract') {
        const base = children[0];
        const baseEl = renderSingleShape(base, true);
        baseEl.setAttribute('fill', s.fill);
        baseEl.setAttribute('opacity', base.op * s.op);
        if (s.sw > 0) {
          baseEl.setAttribute('stroke', s.stroke);
          baseEl.setAttribute('stroke-width', s.sw);
        }

        const maskId = `mask-shape-${s.id}`;
        let defs = stage.querySelector('defs');
        if (!defs) {
          defs = document.createElementNS(SVGNS, 'defs');
          stage.insertBefore(defs, stage.firstChild);
        }

        const oldMask = defs.querySelector(`#${maskId}`);
        if (oldMask) oldMask.remove();

        const mask = document.createElementNS(SVGNS, 'mask');
        mask.setAttribute('id', maskId);

        const maskBg = document.createElementNS(SVGNS, 'rect');
        maskBg.setAttribute('x', '-1000');
        maskBg.setAttribute('y', '-1000');
        maskBg.setAttribute('width', '3000');
        maskBg.setAttribute('height', '3000');
        maskBg.setAttribute('fill', 'white');
        mask.appendChild(maskBg);

        for (let i = 1; i < children.length; i++) {
          const subChild = children[i];
          const subEl = renderSingleShape(subChild, true);
          subEl.setAttribute('fill', 'black');
          subEl.removeAttribute('stroke');
          mask.appendChild(subEl);
        }
        defs.appendChild(mask);
        baseEl.setAttribute('mask', `url(#${maskId})`);
        g.appendChild(baseEl);
      } else if (op === 'intersect') {
        const base = children[0];
        const baseEl = renderSingleShape(base, true);
        baseEl.setAttribute('fill', s.fill);
        baseEl.setAttribute('opacity', base.op * s.op);
        if (s.sw > 0) {
          baseEl.setAttribute('stroke', s.stroke);
          baseEl.setAttribute('stroke-width', s.sw);
        }

        const clipId = `clip-shape-${s.id}`;
        let defs = stage.querySelector('defs');
        if (!defs) {
          defs = document.createElementNS(SVGNS, 'defs');
          stage.insertBefore(defs, stage.firstChild);
        }

        const oldClip = defs.querySelector(`#${clipId}`);
        if (oldClip) oldClip.remove();

        const clipPath = document.createElementNS(SVGNS, 'clipPath');
        clipPath.setAttribute('id', clipId);

        for (let i = 1; i < children.length; i++) {
          const clipChild = children[i];
          const clipEl = renderSingleShape(clipChild, true);
          clipPath.appendChild(clipEl);
        }
        defs.appendChild(clipPath);
        baseEl.setAttribute('clip-path', `url(#${clipId})`);
        g.appendChild(baseEl);
      }
      return g;
    } else if (s.type === 'embed') {
      // Imported SVG rendered whole: a nested <svg> scales the original viewBox
      // into an s.w × s.h box centred on the origin, then the usual transform places it.
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', shapeTransform(s));
      g.setAttribute('opacity', s.op);
      const inner = document.createElementNS(SVGNS, 'svg');
      inner.setAttribute('x', -s.w / 2);
      inner.setAttribute('y', -s.h / 2);
      inner.setAttribute('width', s.w);
      inner.setAttribute('height', s.h);
      inner.setAttribute('viewBox', s.p.vb);
      inner.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      inner.innerHTML = s.p.markup;
      g.appendChild(inner);
      if (!isChildOfComposite) { g.setAttribute('class', 'shape'); g.dataset.id = s.id; }
      return g;
    } else {
      const el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', GEN[s.type].d(s.w, s.h, s.p));
      el.setAttribute('transform', shapeTransform(s));
      el.setAttribute('fill', s.fill);
      el.setAttribute('opacity', s.op);
      if (GEN[s.type].evenodd) el.setAttribute('fill-rule', 'evenodd');
      if (s.sw > 0) { el.setAttribute('stroke', s.stroke); el.setAttribute('stroke-width', s.sw); }
      if (!isChildOfComposite) {
        el.setAttribute('class', 'shape');
        el.dataset.id = s.id;
      }
      return el;
    }
  }

  function renderShapes() {
    shapesG.textContent = '';
    for (const s of shapes) {
      shapesG.appendChild(renderSingleShape(s));
    }
    $('bg-rect').setAttribute('fill', bg.on ? bg.color : 'none');
  }

  function getCollectiveBounds() {
    if (selIds.length === 0) return null;
    let minL = Infinity, maxR = -Infinity, minT = Infinity, maxB = -Infinity;
    for (const s of selectedShapes()) {
      const { hw, hh } = rotatedHalf(s);
      minL = Math.min(minL, s.x - hw);
      maxR = Math.max(maxR, s.x + hw);
      minT = Math.min(minT, s.y - hh);
      maxB = Math.max(maxB, s.y + hh);
    }
    return { minL, maxR, minT, maxB };
  }

  function renderNodeEditHandles() {
    const s = byId(editNodeShapeId);
    if (!s || s.type !== 'custom') { editNodeShapeId = null; return; }
    
    const a = s.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    
    const getPtData = (pt) => {
      if (Array.isArray(pt)) return { x: pt[0], y: pt[1], h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } };
      return {
        x: pt.x, y: pt.y,
        h1: pt.h1 || { x: 0, y: 0 },
        h2: pt.h2 || { x: 0, y: 0 }
      };
    };

    s.p.pts.forEach((ptRaw, idx) => {
      const pt = getPtData(ptRaw);
      
      const ax = pt.x * s.w * s.fh;
      const ay = pt.y * s.h * s.fv;
      const acx = s.x + ax * cos - ay * sin;
      const acy = s.y + ax * sin + ay * cos;

      const drawHandleCircle = (hx, hy, role) => {
        if (hx === 0 && hy === 0) return;
        const hlx = (pt.x + hx) * s.w * s.fh;
        const hly = (pt.y + hy) * s.h * s.fv;
        const hcx = s.x + hlx * cos - hly * sin;
        const hcy = s.y + hlx * sin + hly * cos;

        const line = document.createElementNS(SVGNS, 'line');
        line.setAttribute('x1', acx); line.setAttribute('y1', acy);
        line.setAttribute('x2', hcx); line.setAttribute('y2', hcy);
        line.setAttribute('stroke', 'var(--dim)');
        line.setAttribute('stroke-width', '1');
        overlayG.appendChild(line);

        const circ = document.createElementNS(SVGNS, 'circle');
        circ.setAttribute('cx', hcx); circ.setAttribute('cy', hcy);
        circ.setAttribute('r', '4');
        circ.setAttribute('class', 'handle node-handle');
        circ.setAttribute('fill', 'var(--accent)');
        circ.dataset.role = role;
        circ.dataset.index = idx;
        overlayG.appendChild(circ);
      };

      drawHandleCircle(pt.h1.x, pt.h1.y, 'node-h1');
      drawHandleCircle(pt.h2.x, pt.h2.y, 'node-h2');

      const circ = document.createElementNS(SVGNS, 'circle');
      circ.setAttribute('cx', acx);
      circ.setAttribute('cy', acy);
      circ.setAttribute('r', '6');
      circ.setAttribute('class', 'handle node-handle');
      circ.dataset.role = 'node-anchor';
      circ.dataset.index = idx;
      overlayG.appendChild(circ);
    });
  }

  function renderOverlay() {
    overlayG.textContent = '';
    
    if (activeTool === 'pen') {
      if (activePathPoints.length > 0) {
        const pathEl = document.createElementNS(SVGNS, 'path');
        let d = '';
        const pt0 = activePathPoints[0];
        d += `M ${pt0.x} ${pt0.y}`;
        
        for (let i = 1; i < activePathPoints.length; i++) {
          const prev = activePathPoints[i - 1];
          const curr = activePathPoints[i];
          const cp1x = prev.x + prev.h2.x;
          const cp1y = prev.y + prev.h2.y;
          const cp2x = curr.x + curr.h1.x;
          const cp2y = curr.y + curr.h1.y;
          d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${curr.x} ${curr.y}`;
        }
        
        if (penHoverPt) {
          const last = activePathPoints[activePathPoints.length - 1];
          const cp1x = last.x + last.h2.x;
          const cp1y = last.y + last.h2.y;
          d += ` C ${cp1x} ${cp1y}, ${penHoverPt.x} ${penHoverPt.y}, ${penHoverPt.x} ${penHoverPt.y}`;
        }
        
        pathEl.setAttribute('d', d);
        pathEl.setAttribute('class', 'node-line-preview');
        overlayG.appendChild(pathEl);

        activePathPoints.forEach((pt, idx) => {
          const drawActiveHandleLine = (hx, hy) => {
            if (hx === 0 && hy === 0) return;
            const line = document.createElementNS(SVGNS, 'line');
            line.setAttribute('x1', pt.x); line.setAttribute('y1', pt.y);
            line.setAttribute('x2', pt.x + hx); line.setAttribute('y2', pt.y + hy);
            line.setAttribute('stroke', 'var(--dim)');
            line.setAttribute('stroke-width', '1');
            overlayG.appendChild(line);

            const circ = document.createElementNS(SVGNS, 'circle');
            circ.setAttribute('cx', pt.x + hx); circ.setAttribute('cy', pt.y + hy);
            circ.setAttribute('r', '4');
            circ.setAttribute('fill', 'var(--accent)');
            overlayG.appendChild(circ);
          };
          
          drawActiveHandleLine(pt.h1.x, pt.h1.y);
          drawActiveHandleLine(pt.h2.x, pt.h2.y);

          const circ = document.createElementNS(SVGNS, 'circle');
          circ.setAttribute('cx', pt.x);
          circ.setAttribute('cy', pt.y);
          circ.setAttribute('r', idx === 0 ? '7' : '5');
          circ.setAttribute('fill', idx === 0 ? 'var(--accent-2)' : 'var(--text)');
          circ.setAttribute('stroke', 'var(--accent)');
          circ.setAttribute('stroke-width', '1.5');
          overlayG.appendChild(circ);
        });
      }
      return;
    }

    if (selIds.length === 0) return;

    if (selIds.length === 1) {
      const s = selected();
      if (!s) return;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `translate(${s.x} ${s.y}) rotate(${s.rot})`);
      const hw = s.w / 2, hh = s.h / 2;
      const box = document.createElementNS(SVGNS, 'rect');
      box.setAttribute('x', -hw); box.setAttribute('y', -hh);
      box.setAttribute('width', s.w); box.setAttribute('height', s.h);
      box.setAttribute('class', 'sel-box');
      g.appendChild(box);
      const stem = document.createElementNS(SVGNS, 'line');
      stem.setAttribute('x1', 0); stem.setAttribute('y1', -hh);
      stem.setAttribute('x2', 0); stem.setAttribute('y2', -hh - 22);
      stem.setAttribute('class', 'rot-stem');
      g.appendChild(stem);
      const corners = [['nw', -hw, -hh], ['ne', hw, -hh], ['se', hw, hh], ['sw', -hw, hh]];
      for (const [role, cx, cy] of corners) {
        const r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', cx - 5); r.setAttribute('y', cy - 5);
        r.setAttribute('width', 10); r.setAttribute('height', 10);
        r.setAttribute('class', 'handle');
        r.dataset.role = role;
        g.appendChild(r);
      }
      const rot = document.createElementNS(SVGNS, 'circle');
      rot.setAttribute('cx', 0); rot.setAttribute('cy', -hh - 22); rot.setAttribute('r', 7);
      rot.setAttribute('class', 'handle rot');
      rot.dataset.role = 'rot';
      g.appendChild(rot);
      overlayG.appendChild(g);
    } else {
      // Multi-selection: draw thin dashed outlines around each shape
      for (const s of selectedShapes()) {
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('transform', `translate(${s.x} ${s.y}) rotate(${s.rot})`);
        const hw = s.w / 2, hh = s.h / 2;
        const box = document.createElementNS(SVGNS, 'rect');
        box.setAttribute('x', -hw); box.setAttribute('y', -hh);
        box.setAttribute('width', s.w); box.setAttribute('height', s.h);
        box.setAttribute('class', 'sel-box');
        box.setAttribute('stroke-width', '1');
        box.setAttribute('stroke', 'var(--accent-2)');
        g.appendChild(box);
        overlayG.appendChild(g);
      }
      // Draw collective bounding box
      const bounds = getCollectiveBounds();
      if (bounds) {
        const box = document.createElementNS(SVGNS, 'rect');
        box.setAttribute('x', bounds.minL); box.setAttribute('y', bounds.minT);
        box.setAttribute('width', bounds.maxR - bounds.minL); box.setAttribute('height', bounds.maxB - bounds.minT);
        box.setAttribute('class', 'sel-box');
        box.setAttribute('stroke', 'var(--accent)');
        box.setAttribute('stroke-dasharray', '4 4');
        overlayG.appendChild(box);
      }
    }

    if (editNodeShapeId) {
      renderNodeEditHandles();
    }
  }

  function renderAll() {
    renderShapes();
    renderOverlay();
    renderLayers();
    renderProps();
    schedulePreviews();
    try { localStorage.setItem('planetsvg_editor_autosave', snapshot()); } catch (_) {}
  }

  /* ══ layers panel ═══════════════════════════════════════ */

  function renderLayers() {
    const box = $('layers');
    box.textContent = '';
    if (!shapes.length) {
      box.innerHTML = '<div class="layers-empty">No shapes yet - click one in the palette.</div>';
      return;
    }
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      const row = document.createElement('div');
      row.className = 'lrow' + (selIds.includes(s.id) ? ' sel' : '');
      const sw = document.createElement('span');
      sw.className = 'sw'; sw.style.background = s.fill;
      const nm = document.createElement('span');
      nm.className = 'lname'; nm.textContent = s.name;
      row.append(sw, nm);
      const mk = (txt, title, dis, fn) => {
        const b = document.createElement('button');
        b.className = 'lbtn'; b.textContent = txt; b.title = title; b.disabled = dis;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
      };
      row.append(
        mk('▲', 'Bring forward', i === shapes.length - 1, () => reorder(s.id, 1)),
        mk('▼', 'Send backward', i === 0, () => reorder(s.id, -1)),
        mk('✕', 'Delete', false, () => removeShape(s.id))
      );
      row.addEventListener('click', (e) => {
        if (e.shiftKey) {
          if (selIds.includes(s.id)) {
            selIds = selIds.filter(x => x !== s.id);
          } else {
            selIds.push(s.id);
          }
        } else {
          selIds = [s.id];
        }
        renderAll();
      });
      box.appendChild(row);
    }
  }

  function reorder(id, dir) {
    const i = shapes.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shapes.length) return;
    pushHistory();
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
    renderAll();
  }

  function removeShape(id) {
    pushHistory();
    shapes = shapes.filter((s) => s.id !== id);
    selIds = selIds.filter((x) => x !== id);
    if (editNodeShapeId === id) editNodeShapeId = null;
    renderAll();
  }

  function removeSelectedShapes() {
    if (selIds.length === 0) return;
    pushHistory();
    shapes = shapes.filter((s) => !selIds.includes(s.id));
    if (editNodeShapeId && selIds.includes(editNodeShapeId)) editNodeShapeId = null;
    selIds = [];
    renderAll();
  }

  /* ══ properties panel ═══════════════════════════════════ */

  let propDebounce = null;
  function propHistoryOnce() {
    if (propDebounce) return;
    pushHistory();
    propDebounce = setTimeout(() => { propDebounce = null; }, 600);
  }

  function renderProps() {
    $('props-sec').hidden = (selIds.length === 0);
    if (selIds.length === 0) return;

    const s = selectedShapes()[0];
    if (selIds.length === 1) {
      $('single-props-head').hidden = false;
      $('multi-props-head').hidden = true;
      $('sel-name').textContent = s.name;
      $('pathfinder-sec').hidden = true;
    } else {
      $('single-props-head').hidden = true;
      $('multi-props-head').hidden = false;
      $('sel-count').textContent = selIds.length;
      $('pathfinder-sec').hidden = false;
    }

    $('p-x').value = Math.round(s.x); $('p-y').value = Math.round(s.y);
    $('p-w').value = Math.round(s.w); $('p-h').value = Math.round(s.h);
    $('p-rot').value = Math.round(s.rot);
    $('p-op').value = s.op;
    $('p-fill').value = s.fill;
    $('p-stroke').value = s.stroke;
    $('p-sw').value = s.sw;

    $('b-dist-h').disabled = (selIds.length < 3);
    $('b-dist-v').disabled = (selIds.length < 3);

    const box = $('extra-params');
    box.textContent = '';

    if (selIds.length === 1) {
      if (s.type === 'custom') {
        const btn = document.createElement('button');
        btn.className = 'btn tiny';
        btn.textContent = editNodeShapeId === s.id ? 'Exit Node Edit' : 'Edit Path Nodes';
        btn.style.width = '100%';
        btn.style.marginTop = '0.5rem';
        btn.addEventListener('click', () => {
          editNodeShapeId = (editNodeShapeId === s.id) ? null : s.id;
          renderAll();
        });
        box.appendChild(btn);
      } else if (GEN[s.type] && GEN[s.type].params) {
        for (const d of GEN[s.type].params || []) {
          const lab = document.createElement('label');
          lab.className = 'field';
          lab.textContent = d.label + ' ';
          const val = document.createElement('b');
          val.textContent = s.p[d.k];
          val.style.cssText = 'float:right;color:var(--text)';
          const inp = document.createElement('input');
          inp.type = 'range'; inp.min = d.min; inp.max = d.max; inp.step = d.step;
          inp.value = s.p[d.k];
          inp.addEventListener('input', () => {
            propHistoryOnce();
            s.p[d.k] = Number(inp.value);
            val.textContent = inp.value;
            renderShapes(); renderOverlay(); schedulePreviews();
          });
          lab.append(val, inp);
          box.appendChild(lab);
        }
      }
    }
  }

  function bindProp(id, key, isNum) {
    $(id).addEventListener('input', () => {
      if (selIds.length === 0) return;
      propHistoryOnce();
      let v = $(id).value;
      if (isNum) { v = Number(v); if (Number.isNaN(v)) return; }
      for (const s of selectedShapes()) {
        s[key] = v;
        if (key === 'w' || key === 'h') s[key] = Math.max(2, s[key]);
      }
      renderShapes(); renderOverlay(); renderLayers(); schedulePreviews();
    });
  }
  bindProp('p-x', 'x', true); bindProp('p-y', 'y', true);
  bindProp('p-w', 'w', true); bindProp('p-h', 'h', true);
  bindProp('p-rot', 'rot', true); bindProp('p-op', 'op', true);
  bindProp('p-fill', 'fill', false); bindProp('p-stroke', 'stroke', false);
  bindProp('p-sw', 'sw', true);

  function withSel(fn) {
    if (selIds.length > 0) {
      pushHistory();
      selectedShapes().forEach(fn);
      renderAll();
    }
  }
  $('b-fliph').addEventListener('click', () => withSel((s) => { s.fh *= -1; }));
  $('b-flipv').addEventListener('click', () => withSel((s) => { s.fv *= -1; }));
  $('b-centerh').addEventListener('click', () => withSel((s) => { s.x = CANVAS / 2; }));
  $('b-centerv').addEventListener('click', () => withSel((s) => { s.y = CANVAS / 2; }));
  $('b-up').addEventListener('click', () => {
    if (selIds.length === 1) reorder(selIds[0], 1);
  });
  $('b-down').addEventListener('click', () => {
    if (selIds.length === 1) reorder(selIds[0], -1);
  });
  $('b-del').addEventListener('click', removeSelectedShapes);
  $('b-dup').addEventListener('click', duplicateSel);

  function duplicateSel() {
    if (selIds.length === 0) return;
    pushHistory();
    const newIds = [];
    for (const s of selectedShapes()) {
      const c = JSON.parse(JSON.stringify(s));
      c.id = idSeq++;
      c.name = (GEN[c.type] ? GEN[c.type].name : 'Composite') + ' ' + idSeq;
      c.x += 16; c.y += 16;
      shapes.push(c);
      newIds.push(c.id);
    }
    selIds = newIds;
    renderAll();
  }

  /* ══ palette ════════════════════════════════════════════ */

  function buildPalette() {
    const pal = $('palette');
    pal.textContent = '';
    const types = TAB_SHAPES[activeTab] || [];
    for (const t of types) {
      if (!GEN[t]) continue;
      const b = document.createElement('button');
      b.className = 'shape-btn';
      b.title = GEN[t].name;
      b.setAttribute('aria-label', 'Add ' + GEN[t].name);
      const ph = t === 'capsule' ? 26 : 48; // pill-shaped preview for capsule
      b.innerHTML = `<svg viewBox="-30 -30 60 60"><path d="${GEN[t].d(48, ph, defaults(t))}"${GEN[t].evenodd ? ' fill-rule="evenodd"' : ''}/></svg>`;
      b.addEventListener('click', () => addShape(t));
      pal.appendChild(b);
    }
  }

  // Bind tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      buildPalette();
    });
  });

  buildPalette();

  /* ══ snapping ═══════════════════════════════════════════ */

  const snapGridOn = () => $('snap-grid').checked;
  const snapObjOn = () => $('snap-obj').checked;
  const gridSize = () => Number($('grid-size').value);

  function rotatedHalf(s) { // axis-aligned half extents of the rotated box
    const a = s.rot * Math.PI / 180;
    const c = Math.abs(Math.cos(a)), n = Math.abs(Math.sin(a));
    return { hw: (s.w * c + s.h * n) / 2, hh: (s.w * n + s.h * c) / 2 };
  }

  function axisTargets(axis) { // snap target lines for x ('x') or y ('y')
    const t = [0, CANVAS / 2, CANVAS];
    for (const o of shapes) {
      if (selIds.includes(o.id)) continue;
      const { hw, hh } = rotatedHalf(o);
      const c = axis === 'x' ? o.x : o.y;
      const half = axis === 'x' ? hw : hh;
      t.push(c - half, c, c + half);
    }
    return t;
  }

  function snapAxis(raw, half, axis) {
    let best = null;
    if (snapObjOn()) {
      for (const t of axisTargets(axis)) {
        for (const off of [-half, 0, half]) {
          const cand = t - off;
          const d = Math.abs(cand - raw);
          if (d <= SNAP_THR && (!best || d < best.d)) best = { v: cand, d, guide: t };
        }
      }
    }
    if (best) return best;
    if (snapGridOn()) {
      const g = gridSize();
      const opts = [
        Math.round(raw / g) * g,
        Math.round((raw - half) / g) * g + half,
        Math.round((raw + half) / g) * g - half
      ];
      let v = opts[0];
      for (const o of opts) if (Math.abs(o - raw) < Math.abs(v - raw)) v = o;
      return { v, guide: null };
    }
    return { v: raw, guide: null };
  }

  function showGuides(gx, gy) {
    guideV.setAttribute('visibility', gx === null ? 'hidden' : 'visible');
    if (gx !== null) { guideV.setAttribute('x1', gx); guideV.setAttribute('x2', gx); }
    guideH.setAttribute('visibility', gy === null ? 'hidden' : 'visible');
    if (gy !== null) { guideH.setAttribute('y1', gy); guideH.setAttribute('y2', gy); }
  }

  /* ══ pointer interaction ════════════════════════════════ */

  function svgPoint(e) {
    const pt = stage.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(stage.getScreenCTM().inverse());
  }

  let drag = null; // {mode, id, offX, offY, orig, moved}

  stage.addEventListener('pointerdown', (e) => {
    const p = svgPoint(e);
    
    if (activeTool === 'pen') {
      let snapX = p.x;
      let snapY = p.y;
      if (snapGridOn()) {
        const g = gridSize();
        snapX = Math.round(p.x / g) * g;
        snapY = Math.round(p.y / g) * g;
      }
      
      if (activePathPoints.length > 2) {
        const dist = Math.hypot(snapX - activePathPoints[0].x, snapY - activePathPoints[0].y);
        if (dist < 12) {
          finalizePenPath();
          return;
        }
      }
      
      const newPt = { x: snapX, y: snapY, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } };
      activePathPoints.push(newPt);
      penHoverPt = { x: snapX, y: snapY };
      
      // Start drag to pull handle
      drag = {
        mode: 'pen-drag',
        index: activePathPoints.length - 1,
        startX: snapX,
        startY: snapY,
        moved: false
      };
      stage.setPointerCapture(e.pointerId);
      renderAll();
      e.preventDefault();
      return;
    }
    
    const handle = e.target.closest('.handle');
    const shapeEl = e.target.closest('.shape');
    
    if (handle) {
      if (handle.dataset.role.startsWith('node-') && editNodeShapeId) {
        const s = byId(editNodeShapeId);
        const idx = Number(handle.dataset.index);
        drag = { mode: handle.dataset.role, id: s.id, nodeIndex: idx, orig: JSON.parse(JSON.stringify(s)), moved: false };
        stage.setPointerCapture(e.pointerId);
      } else if (selected()) {
        const s = selected();
        drag = { mode: handle.dataset.role, id: s.id, orig: JSON.parse(JSON.stringify(s)), moved: false };
        stage.setPointerCapture(e.pointerId);
      }
    } else if (shapeEl) {
      const id = Number(shapeEl.dataset.id);
      
      if (e.shiftKey) {
        if (selIds.includes(id)) {
          selIds = selIds.filter(x => x !== id);
        } else {
          selIds.push(id);
        }
      } else {
        if (!selIds.includes(id)) {
          selIds = [id];
        }
      }
      
      if (editNodeShapeId && editNodeShapeId !== id) {
        editNodeShapeId = null;
      }
      
      renderOverlay(); renderLayers(); renderProps();
      
      if (selIds.includes(id)) {
        const s = byId(id);
        drag = {
          mode: 'move',
          id,
          origs: selectedShapes().map(sh => ({ id: sh.id, x: sh.x, y: sh.y })),
          offX: p.x,
          offY: p.y,
          moved: false
        };
        stage.setPointerCapture(e.pointerId);
      }
    } else {
      if (!e.shiftKey) {
        selIds = [];
        editNodeShapeId = null;
      }
      renderOverlay(); renderLayers(); renderProps();
      
      drag = {
        mode: 'marquee',
        startX: p.x,
        startY: p.y,
        moved: false
      };
      stage.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    const p = svgPoint(e);
    
    if (activeTool === 'pen') {
      if (drag && drag.mode === 'pen-drag') {
        let snapX = p.x;
        let snapY = p.y;
        if (snapGridOn()) {
          const g = gridSize();
          snapX = Math.round(p.x / g) * g;
          snapY = Math.round(p.y / g) * g;
        }
        const pt = activePathPoints[drag.index];
        const dx = snapX - pt.x;
        const dy = snapY - pt.y;
        pt.h2 = { x: dx, y: dy };
        pt.h1 = { x: -dx, y: -dy };
        penHoverPt = { x: snapX, y: snapY };
        drag.moved = true;
        renderOverlay();
        return;
      }
      
      let snapX = p.x;
      let snapY = p.y;
      if (snapGridOn()) {
        const g = gridSize();
        snapX = Math.round(p.x / g) * g;
        snapY = Math.round(p.y / g) * g;
      }
      penHoverPt = { x: snapX, y: snapY };
      renderOverlay();
      return;
    }

    if (!drag) return;

    if (drag.mode === 'marquee') {
      const x = Math.min(drag.startX, p.x);
      const y = Math.min(drag.startY, p.y);
      const w = Math.abs(drag.startX - p.x);
      const h = Math.abs(drag.startY - p.y);
      
      const mq = $('marquee-rect');
      mq.setAttribute('x', x);
      mq.setAttribute('y', y);
      mq.setAttribute('width', w);
      mq.setAttribute('height', h);
      mq.setAttribute('visibility', 'visible');
      drag.moved = true;
      return;
    }

    if (drag.mode && drag.mode.startsWith('node-')) {
      const s = byId(drag.id);
      if (!s) return;
      
      let snapX = p.x;
      let snapY = p.y;
      if (snapGridOn()) {
        const g = gridSize();
        snapX = Math.round(p.x / g) * g;
        snapY = Math.round(p.y / g) * g;
      }
      
      const a = s.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      const dx = snapX - s.x;
      const dy = snapY - s.y;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      
      const unscaledX = lx / (s.w * s.fh);
      const unscaledY = ly / (s.h * s.fv);
      
      let pt = s.p.pts[drag.nodeIndex];
      if (Array.isArray(pt)) {
        pt = s.p.pts[drag.nodeIndex] = { x: pt[0], y: pt[1], h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } };
      }
      
      if (drag.mode === 'node-anchor') {
        pt.x = unscaledX;
        pt.y = unscaledY;
      } else {
        const hx = unscaledX - pt.x;
        const hy = unscaledY - pt.y;
        if (drag.mode === 'node-h1') {
          pt.h1 = { x: hx, y: hy };
          pt.h2 = { x: -hx, y: -hy };
        } else if (drag.mode === 'node-h2') {
          pt.h2 = { x: hx, y: hy };
          pt.h1 = { x: -hx, y: -hy };
        }
      }
      drag.moved = true;
      renderShapes(); renderOverlay();
      return;
    }

    const s = byId(drag.id);
    if (!s) { drag = null; return; }

    if (drag.mode === 'move') {
      const dx = p.x - drag.offX;
      const dy = p.y - drag.offY;
      const primaryOrig = drag.origs.find(o => o.id === drag.id);
      const primaryS = byId(drag.id);
      
      const { hw, hh } = rotatedHalf(primaryS);
      const rawX = primaryOrig.x + dx;
      const rawY = primaryOrig.y + dy;
      const rx = snapAxis(rawX, hw, 'x');
      const ry = snapAxis(rawY, hh, 'y');
      
      const snapDx = rx.v - primaryOrig.x;
      const snapDy = ry.v - primaryOrig.y;
      
      for (const o of drag.origs) {
        const sh = byId(o.id);
        if (sh) {
          sh.x = o.x + snapDx;
          sh.y = o.y + snapDy;
        }
      }
      drag.moved = true;
      renderShapes(); renderOverlay();
      showGuides(rx.guide, ry.guide);
    } else if (drag.mode === 'rot') {
      let ang = Math.atan2(p.y - s.y, p.x - s.x) * 180 / Math.PI + 90;
      if (!e.shiftKey) ang = Math.round(ang / 15) * 15;
      s.rot = ((ang % 360) + 360) % 360;
      drag.moved = true;
      renderShapes(); renderOverlay();
    } else { // corner resize
      const o = drag.orig;
      const a = o.rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      let lx = (p.x - o.x) * cos + (p.y - o.y) * sin;
      let ly = -(p.x - o.x) * sin + (p.y - o.y) * cos;
      const sgn = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] }[drag.mode];
      const ax = -sgn[0] * o.w / 2, ay = -sgn[1] * o.h / 2;
      if (e.shiftKey) {
        const sc = Math.max(Math.abs(lx - ax) / o.w, Math.abs(ly - ay) / o.h);
        lx = ax + Math.sign(lx - ax || sgn[0]) * o.w * sc;
        ly = ay + Math.sign(ly - ay || sgn[1]) * o.h * sc;
      } else if (snapGridOn()) {
        const g = gridSize();
        const wx = o.x + lx * cos - ly * sin, wy = o.y + lx * sin + ly * cos;
        const sx2 = Math.round(wx / g) * g, sy2 = Math.round(wy / g) * g;
        lx = (sx2 - o.x) * cos + (sy2 - o.y) * sin;
        ly = -(sx2 - o.x) * sin + (sy2 - o.y) * cos;
      }
      s.w = Math.max(4, Math.abs(lx - ax));
      s.h = Math.max(4, Math.abs(ly - ay));
      const mx = (ax + lx) / 2, my = (ay + ly) / 2;
      s.x = o.x + mx * cos - my * sin;
      s.y = o.y + mx * sin + my * cos;
      drag.moved = true;
      renderShapes(); renderOverlay();
    }
  });

  function endDrag(e) {
    if (!drag) return;
    if (drag.mode === 'pen-drag') {
      drag = null;
      return;
    }
    if (drag.mode === 'marquee') {
      const mq = $('marquee-rect');
      mq.setAttribute('visibility', 'hidden');
      if (drag.moved && e) {
        const p = svgPoint(e);
        const mL = Math.min(drag.startX, p.x), mR = Math.max(drag.startX, p.x);
        const mT = Math.min(drag.startY, p.y), mB = Math.max(drag.startY, p.y);
        
        const newSelIds = [];
        for (const s of shapes) {
          const { hw, hh } = rotatedHalf(s);
          const sL = s.x - hw, sR = s.x + hw, sT = s.y - hh, sB = s.y + hh;
          const intersects = !(sR < mL || sL > mR || sB < mT || sT > mB);
          if (intersects) {
            newSelIds.push(s.id);
          }
        }
        
        if (e.shiftKey) {
          for (const id of newSelIds) {
            if (selIds.includes(id)) {
              selIds = selIds.filter(x => x !== id);
            } else {
              selIds.push(id);
            }
          }
        } else {
          selIds = newSelIds;
        }
        renderAll();
      }
      drag = null;
      return;
    }
    
    if (drag.moved) {
      if (drag.mode === 'move') {
        const prevShapesState = shapes.map(s => {
          const orig = drag.origs.find(o => o.id === s.id);
          return orig ? Object.assign({}, s, { x: orig.x, y: orig.y }) : s;
        });
        undoStack.push(JSON.stringify({ shapes: prevShapesState, bg }));
      } else {
        undoStack.push(JSON.stringify({ shapes: shapes.map((s) => s.id === drag.id ? drag.orig : s), bg }));
      }
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
      try {
        localStorage.setItem('planetsvg_editor_autosave', snapshot());
      } catch (err) {
        console.warn('Failed to auto-save to localStorage', err);
      }
      renderProps(); schedulePreviews();
    }
    drag = null;
    showGuides(null, null);
  }

  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  /* ══ pen tool helpers ═══════════════════════════════════ */

  function updateToolbarUI() {
    $('tool-select').classList.toggle('active', activeTool === 'select');
    $('tool-pen').classList.toggle('active', activeTool === 'pen');
    if (activeTool === 'pen') {
      $('tool-info').textContent = 'Pen Mode: Click on canvas to draw path. Click first point or press Enter to close/finish.';
      stage.style.cursor = 'crosshair';
    } else {
      $('tool-info').textContent = 'Select / Drag shapes to edit. Double-click custom path to edit nodes.';
      stage.style.cursor = 'default';
    }
  }

  $('tool-select').addEventListener('click', () => {
    if (activeTool === 'pen') cancelPenPath();
    activeTool = 'select';
    updateToolbarUI();
    renderAll();
  });

  $('tool-pen').addEventListener('click', () => {
    activeTool = 'pen';
    editNodeShapeId = null;
    updateToolbarUI();
    renderAll();
  });

  function finalizePenPath() {
    if (activePathPoints.length < 3) {
      cancelPenPath();
      return;
    }
    pushHistory();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of activePathPoints) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }
    const w = Math.max(10, maxX - minX);
    const h = Math.max(10, maxY - minY);
    const cx = minX + w / 2;
    const cy = minY + h / 2;

    const pts = activePathPoints.map(pt => ({
      x: (pt.x - cx) / w,
      y: (pt.y - cy) / h,
      h1: { x: pt.h1.x / w, y: pt.h1.y / h },
      h2: { x: pt.h2.x / w, y: pt.h2.y / h }
    }));

    const s = {
      id: idSeq++,
      type: 'custom',
      name: 'Custom Path ' + idSeq,
      x: cx, y: cy, w, h, rot: 0, fh: 1, fv: 1,
      fill: FILL_CYCLE[fillIdx++ % FILL_CYCLE.length],
      op: 1, stroke: '#e8edf7', sw: 0,
      p: { pts }
    };
    shapes.push(s);
    selIds = [s.id];
    activePathPoints = [];
    penHoverPt = null;
    activeTool = 'select';
    updateToolbarUI();
    renderAll();
  }

  function cancelPenPath() {
    activePathPoints = [];
    penHoverPt = null;
    activeTool = 'select';
    updateToolbarUI();
    renderAll();
  }

  // Double click to edit node path
  stage.addEventListener('dblclick', (e) => {
    const shapeEl = e.target.closest('.shape');
    if (shapeEl) {
      const id = Number(shapeEl.dataset.id);
      const s = byId(id);
      if (s && s.type === 'custom') {
        editNodeShapeId = s.id;
        renderAll();
      }
    }
  });

  /* ══ align & pathfinder bindings ════════════════════════ */

  function alignSelection(alignment) {
    if (selIds.length === 0) return;
    pushHistory();
    
    const targets = selectedShapes();
    const bounds = getCollectiveBounds();
    
    if (selIds.length === 1) {
      const s = targets[0];
      const { hw, hh } = rotatedHalf(s);
      if (alignment === 'left') s.x = hw;
      else if (alignment === 'centerx') s.x = CANVAS / 2;
      else if (alignment === 'right') s.x = CANVAS - hw;
      else if (alignment === 'top') s.y = hh;
      else if (alignment === 'centery') s.y = CANVAS / 2;
      else if (alignment === 'bottom') s.y = CANVAS - hh;
    } else {
      const cx = (bounds.minL + bounds.maxR) / 2;
      const cy = (bounds.minT + bounds.maxB) / 2;
      
      for (const s of targets) {
        const { hw, hh } = rotatedHalf(s);
        if (alignment === 'left') s.x = bounds.minL + hw;
        else if (alignment === 'centerx') s.x = cx;
        else if (alignment === 'right') s.x = bounds.maxR - hw;
        else if (alignment === 'top') s.y = bounds.minT + hh;
        else if (alignment === 'centery') s.y = cy;
        else if (alignment === 'bottom') s.y = bounds.maxB - hh;
      }
    }
    
    renderAll();
  }

  function distributeSelection(direction) {
    if (selIds.length < 3) return;
    pushHistory();
    
    const targets = selectedShapes();
    if (direction === 'h') {
      targets.sort((a, b) => a.x - b.x);
      const minX = targets[0].x;
      const maxX = targets[targets.length - 1].x;
      const step = (maxX - minX) / (targets.length - 1);
      targets.forEach((s, idx) => {
        s.x = minX + idx * step;
      });
    } else if (direction === 'v') {
      targets.sort((a, b) => a.y - b.y);
      const minY = targets[0].y;
      const maxY = targets[targets.length - 1].y;
      const step = (maxY - minY) / (targets.length - 1);
      targets.forEach((s, idx) => {
        s.y = minY + idx * step;
      });
    }
    
    renderAll();
  }

  function applyPathfinder(op) {
    if (selIds.length < 2) return;
    if (selectedShapes().some((s) => s.type === 'embed')) {
      alert('Pathfinder operations don’t apply to imported SVG objects.');
      return;
    }
    pushHistory();
    
    const sortedSelShapes = shapes.filter(s => selIds.includes(s.id));
    
    const bounds = getCollectiveBounds();
    const w = bounds.maxR - bounds.minL;
    const h = bounds.maxB - bounds.minT;
    const cx = (bounds.minL + bounds.maxR) / 2;
    const cy = (bounds.minT + bounds.maxB) / 2;
    
    const children = JSON.parse(JSON.stringify(sortedSelShapes));
    for (const child of children) {
      child.x = child.x - cx;
      child.y = child.y - cy;
    }
    
    shapes = shapes.filter(s => !selIds.includes(s.id));
    
    const base = sortedSelShapes[0];
    const newId = idSeq++;
    const compositeShape = {
      id: newId,
      type: 'composite',
      name: `Composite (${op}) ${newId}`,
      x: cx, y: cy, w: w, h: h, rot: 0, fh: 1, fv: 1,
      fill: base.fill,
      op: base.op,
      stroke: base.stroke,
      sw: base.sw,
      p: {
        op,
        children: children
      }
    };
    
    shapes.push(compositeShape);
    selIds = [newId];
    renderAll();
  }

  $('b-align-left').addEventListener('click', () => alignSelection('left'));
  $('b-align-centerx').addEventListener('click', () => alignSelection('centerx'));
  $('b-align-right').addEventListener('click', () => alignSelection('right'));
  $('b-align-top').addEventListener('click', () => alignSelection('top'));
  $('b-align-centery').addEventListener('click', () => alignSelection('centery'));
  $('b-align-bottom').addEventListener('click', () => alignSelection('bottom'));
  $('b-dist-h').addEventListener('click', () => distributeSelection('h'));
  $('b-dist-v').addEventListener('click', () => distributeSelection('v'));

  $('b-pf-union').addEventListener('click', () => applyPathfinder('union'));
  $('b-pf-sub').addEventListener('click', () => applyPathfinder('subtract'));
  $('b-pf-intersect').addEventListener('click', () => applyPathfinder('intersect'));
  $('b-pf-exclude').addEventListener('click', () => applyPathfinder('exclude'));

  /* ══ keyboard ═══════════════════════════════════════════ */

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return; }
    
    if (e.key === 'Escape') {
      if (activeTool === 'pen') {
        cancelPenPath();
      } else if (editNodeShapeId) {
        editNodeShapeId = null;
        renderAll();
      }
      return;
    }
    
    if (e.key === 'Enter') {
      if (activeTool === 'pen') {
        finalizePenPath();
      } else if (editNodeShapeId) {
        editNodeShapeId = null;
        renderAll();
      }
      return;
    }

    if (e.key.toLowerCase() === 'v') {
      if (activeTool === 'pen') cancelPenPath();
      activeTool = 'select';
      updateToolbarUI();
      renderAll();
      return;
    }
    if (e.key.toLowerCase() === 'p') {
      activeTool = 'pen';
      editNodeShapeId = null;
      updateToolbarUI();
      renderAll();
      return;
    }

    if (selIds.length === 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelectedShapes(); return; }
    const step = e.shiftKey ? gridSize() : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) {
      e.preventDefault();
      pushHistory();
      for (const s of selectedShapes()) {
        s.x += mv[0]; s.y += mv[1];
      }
      renderShapes(); renderOverlay(); renderProps(); schedulePreviews();
    }
  });

  /* ══ canvas / grid settings ═════════════════════════════ */

  $('grid-size').addEventListener('change', updateGrid);
  $('snap-grid').addEventListener('change', updateGrid);
  function updateGrid() {
    const g = gridSize();
    const pat = document.getElementById('gridpat');
    pat.setAttribute('width', g); pat.setAttribute('height', g);
    pat.firstElementChild.setAttribute('d', `M${g} 0H0V${g}`);
    $('grid-rect').setAttribute('visibility', snapGridOn() ? 'visible' : 'hidden');
  }
  $('bg-on').addEventListener('change', () => { pushHistory(); bg.on = $('bg-on').checked; renderShapes(); schedulePreviews(); });
  $('bg-color').addEventListener('input', () => { propHistoryOnce(); bg.color = $('bg-color').value; bg.on = true; $('bg-on').checked = true; renderShapes(); schedulePreviews(); });

  /* ══ export ═════════════════════════════════════════════ */

  function buildSingleSVGString(s) {
    if (s.type === 'composite') {
      const op = s.p.op;
      const children = s.p.children;
      if (!children || children.length === 0) return '';
      
      let out = '';
      if (op === 'union' || op === 'exclude') {
        out += `<g transform="${shapeTransform(s)}">\n`;
        for (const child of children) {
          out += `  ` + buildSingleSVGString({
            ...child,
            fill: s.fill,
            op: child.op * s.op,
            stroke: s.stroke,
            sw: s.sw,
            type: child.type
          }).replace(/\n/g, '\n  ') + '\n';
        }
        out += `</g>`;
      } else if (op === 'subtract') {
        const maskId = `mask-export-${s.id}`;
        out += `<defs>\n`;
        out += `  <mask id="${maskId}">\n`;
        out += `    <rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/>\n`;
        for (let i = 1; i < children.length; i++) {
          const sub = children[i];
          out += `    ` + buildSingleSVGString({
            ...sub,
            fill: 'black',
            stroke: 'none',
            sw: 0
          }).replace(/\n/g, '\n    ') + '\n';
        }
        out += `  </mask>\n`;
        out += `</defs>\n`;
        
        out += `<g transform="${shapeTransform(s)}" mask="url(#${maskId})">\n`;
        out += `  ` + buildSingleSVGString({
          ...children[0],
          fill: s.fill,
          op: children[0].op * s.op,
          stroke: s.stroke,
          sw: s.sw
        }).replace(/\n/g, '\n  ') + '\n';
        out += `</g>`;
      } else if (op === 'intersect') {
        const clipId = `clip-export-${s.id}`;
        out += `<defs>\n`;
        out += `  <clipPath id="${clipId}">\n`;
        for (let i = 1; i < children.length; i++) {
          out += `    ` + buildSingleSVGString(children[i]).replace(/\n/g, '\n    ') + '\n';
        }
        out += `  </clipPath>\n`;
        out += `</defs>\n`;
        
        out += `<g transform="${shapeTransform(s)}" clip-path="url(#${clipId})">\n`;
        out += `  ` + buildSingleSVGString({
          ...children[0],
          fill: s.fill,
          op: children[0].op * s.op,
          stroke: s.stroke,
          sw: s.sw
        }).replace(/\n/g, '\n  ') + '\n';
        out += `</g>`;
      }
      return out;
    } else if (s.type === 'embed') {
      return `<g transform="${shapeTransform(s)}"` + (s.op !== 1 ? ` opacity="${s.op}"` : '') + '>' +
        `<svg x="${-s.w / 2}" y="${-s.h / 2}" width="${s.w}" height="${s.h}" viewBox="${s.p.vb}" preserveAspectRatio="xMidYMid meet">` +
        s.p.markup + '</svg></g>';
    } else {
      let rule = '';
      if (GEN[s.type] && GEN[s.type].evenodd) rule = ' fill-rule="evenodd"';
      
      const pathD = GEN[s.type] ? GEN[s.type].d(s.w, s.h, s.p) : '';
      return `<path d="${pathD}" transform="${shapeTransform(s)}" fill="${s.fill}"` +
        (s.op !== 1 ? ` opacity="${s.op}"` : '') +
        rule +
        (s.sw > 0 ? ` stroke="${s.stroke}" stroke-width="${s.sw}"` : '') + '/>';
    }
  }

  function buildSVG() {
    let out = `<svg xmlns="${SVGNS}" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">\n`;
    if (bg.on) out += `  <rect width="${CANVAS}" height="${CANVAS}" fill="${bg.color}"/>\n`;
    for (const s of shapes) {
      out += '  ' + buildSingleSVGString(s).replace(/\n/g, '\n  ') + '\n';
    }
    return out + '</svg>';
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function svgToCanvas(size) {
    return new Promise((ok, fail) => {
      const url = URL.createObjectURL(new Blob([buildSVG()], { type: 'image/svg+xml' }));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, 0, 0, size, size);
        URL.revokeObjectURL(url);
        ok(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('SVG rasterization failed')); };
      img.src = url;
    });
  }

  const canvasToPngBuf = (c) => new Promise((ok, fail) =>
    c.toBlob((b) => b ? b.arrayBuffer().then(ok) : fail(new Error('PNG encode failed')), 'image/png'));

  $('b-svg').addEventListener('click', () => {
    download(new Blob([buildSVG()], { type: 'image/svg+xml' }), 'icon.svg');
  });

  $('b-animate').addEventListener('click', () => {
    try {
      localStorage.setItem('planetsvg_animator_handoff', JSON.stringify({ svg: buildSVG(), at: Date.now() }));
      localStorage.setItem('planetsvg_editor_autosave', snapshot());
      location.href = '../Animator/';
    } catch (e) {
      alert('Your browser blocked local handoff. Export the SVG and open it in the Animator instead.');
    }
  });

  $('b-png').addEventListener('click', async () => {
    const size = Number($('png-size').value);
    const c = await svgToCanvas(size);
    c.toBlob((b) => download(b, `icon-${size}.png`), 'image/png');
  });

  $('b-ico').addEventListener('click', async () => {
    const sizes = [16, 32, 48, 256];
    const bufs = [];
    for (const s of sizes) bufs.push(await canvasToPngBuf(await svgToCanvas(s)));
    const total = 6 + 16 * sizes.length + bufs.reduce((a, b) => a + b.byteLength, 0);
    const out = new DataView(new ArrayBuffer(total));
    out.setUint16(0, 0, true); out.setUint16(2, 1, true); out.setUint16(4, sizes.length, true);
    let off = 6 + 16 * sizes.length;
    sizes.forEach((s, i) => {
      const e = 6 + i * 16, len = bufs[i].byteLength;
      out.setUint8(e, s === 256 ? 0 : s); out.setUint8(e + 1, s === 256 ? 0 : s);
      out.setUint8(e + 2, 0); out.setUint8(e + 3, 0);
      out.setUint16(e + 4, 1, true); out.setUint16(e + 6, 32, true);
      out.setUint32(e + 8, len, true); out.setUint32(e + 12, off, true);
      new Uint8Array(out.buffer, off, len).set(new Uint8Array(bufs[i]));
      off += len;
    });
    download(new Blob([out.buffer], { type: 'image/x-icon' }), 'favicon.ico');
  });

  /* presets */
  $('b-save').addEventListener('click', () => {
    const data = JSON.stringify({ app: 'PlanetSVG Editor', v: 1, shapes, bg }, null, 1);
    download(new Blob([data], { type: 'application/json' }), 'icon-preset.json');
  });
  $('b-load').addEventListener('click', () => $('preset-file').click());
  $('preset-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!Array.isArray(d.shapes)) throw new Error('bad file');
        pushHistory();
        shapes = d.shapes;
        bg.on = !!(d.bg && d.bg.on); bg.color = (d.bg && d.bg.color) || '#0d1220';
        $('bg-on').checked = bg.on; $('bg-color').value = bg.color;
        idSeq = maxShapeId(shapes) + 1;
        selIds = [];
        renderAll();
      } catch { alert('Not a PlanetSVG Editor preset file.'); }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  /* import SVG (or other vector files) */
  // Rewrite ids in an imported SVG so its gradients/masks/refs can't collide
  // with the editor's own ids (grid pattern, masks) or with other imports.
  function namespaceIds(root, prefix) {
    const map = {};
    root.querySelectorAll('[id]').forEach((el) => { const old = el.id; el.id = prefix + old; map[old] = prefix + old; });
    if (!Object.keys(map).length) return;
    root.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        let v = a.value;
        v = v.replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, id) => (map[id] ? `url(#${map[id]})` : m));
        if (/^#/.test(v) && (a.name === 'href' || a.localName === 'href')) { const id = v.slice(1); if (map[id]) v = '#' + map[id]; }
        if (v !== a.value) a.value = v;
      });
    });
  }

  function parseImportedSVG(text) {
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch (_) { return null; }
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
    // strip anything scriptable
    root.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((n) => n.remove());
    root.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (/^on/i.test(a.name) || (/(?:href|src)$/i.test(a.name) && /^\s*(?:javascript|data:text\/html)/i.test(a.value))) el.removeAttribute(a.name);
      });
    });
    namespaceIds(root, 'imp' + (importSeq++) + '-');

    let vb = null;
    const vbAttr = root.getAttribute('viewBox');
    if (vbAttr) { const n = vbAttr.trim().split(/[\s,]+/).map(parseFloat); if (n.length === 4 && n.every((v) => !isNaN(v)) && n[2] > 0 && n[3] > 0) vb = n; }
    if (!vb) { const w = parseFloat(root.getAttribute('width')), h = parseFloat(root.getAttribute('height')); if (w > 0 && h > 0) vb = [0, 0, w, h]; }

    const ser = new XMLSerializer();
    let children = '';
    Array.from(root.childNodes).forEach((n) => { children += ser.serializeToString(n); });
    // Preserve root-level presentation attributes (fill, style, class, font-*…) that the
    // children inherit, by wrapping them in a group — structural attrs are dropped.
    const skip = { xmlns: 1, width: 1, height: 1, viewbox: 1, id: 1, x: 1, y: 1, version: 1, preserveaspectratio: 1, baseprofile: 1, transform: 1 };
    let rootAttrs = '';
    Array.from(root.attributes).forEach((a) => {
      const ln = a.name.toLowerCase();
      if (skip[ln] || ln.indexOf('xmlns') === 0) return;
      rootAttrs += ' ' + a.name + '="' + a.value.replace(/"/g, '&quot;') + '"';
    });
    const inner = rootAttrs ? '<g' + rootAttrs + '>' + children + '</g>' : children;

    if (!vb) { // no viewBox and no width/height: measure the rendered geometry
      const tmp = document.createElementNS(SVGNS, 'svg');
      tmp.setAttribute('style', 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden');
      const g = document.createElementNS(SVGNS, 'g');
      g.innerHTML = inner;
      tmp.appendChild(g);
      document.body.appendChild(tmp);
      let bb = null;
      try { bb = g.getBBox(); } catch (_) {}
      document.body.removeChild(tmp);
      vb = (bb && bb.width > 0 && bb.height > 0) ? [bb.x, bb.y, bb.width, bb.height] : [0, 0, 100, 100];
    }
    return { inner, vb: vb.join(' '), aspect: vb[2] / vb[3] };
  }

  function importSVG(text) {
    const parsed = parseImportedSVG(text);
    if (!parsed) return false;
    pushHistory();
    const maxDim = 320;
    let w, h;
    if (parsed.aspect >= 1) { w = maxDim; h = maxDim / parsed.aspect; } else { h = maxDim; w = maxDim * parsed.aspect; }
    const s = {
      id: idSeq++, type: 'embed', name: 'SVG import ' + idSeq,
      x: CANVAS / 2, y: CANVAS / 2, w: Math.round(w), h: Math.round(h),
      rot: 0, fh: 1, fv: 1, fill: '#8891a5', op: 1, stroke: '#e8edf7', sw: 0,
      p: { markup: parsed.inner, vb: parsed.vb }
    };
    shapes.push(s);
    selIds = [s.id];
    renderAll();
    return true;
  }

  function readAndImport(f) {
    if (f.size > 4 * 1024 * 1024) { alert('That file is larger than 4 MB.'); return; }
    const r = new FileReader();
    r.onload = () => { if (!importSVG(String(r.result))) alert('Couldn’t read that as SVG. If it’s another vector format, export it to SVG first.'); };
    r.onerror = () => alert('Could not read that file.');
    r.readAsText(f);
  }

  function closeConvertModal() { $('convert-modal').hidden = true; pendingFile = null; }

  $('b-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ext === 'svg' || f.type === 'image/svg+xml') { readAndImport(f); return; }
    // Another vector format — offer a best-effort conversion or abort.
    pendingFile = f;
    const label = ext ? ext.toUpperCase() : 'non-SVG';
    $('convert-title').textContent = 'This looks like a' + (/^[AEIOU]/.test(label) ? 'n ' : ' ') + label + ' file';
    $('convert-msg').textContent = 'PlanetSVG runs entirely in your browser and can’t convert ' + label +
      ' to SVG here. You can try to read it as SVG anyway — this only works if it actually contains SVG data — or export it to SVG from your vector app first, then import that.';
    $('convert-modal').hidden = false;
  });
  $('convert-try').addEventListener('click', () => { const f = pendingFile; $('convert-modal').hidden = true; pendingFile = null; if (f) readAndImport(f); });
  $('convert-abort').addEventListener('click', closeConvertModal);
  $('convert-modal').addEventListener('click', (e) => { if (e.target === $('convert-modal')) closeConvertModal(); });

  $('b-clear').addEventListener('click', () => {
    if (!shapes.length) return;
    pushHistory();
    shapes = []; selIds = [];
    renderAll();
  });

  /* ══ live previews ══════════════════════════════════════ */

  let pvTimer = null, pvUrl = null;
  function schedulePreviews() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(() => {
      if (pvUrl) URL.revokeObjectURL(pvUrl);
      pvUrl = URL.createObjectURL(new Blob([buildSVG()], { type: 'image/svg+xml' }));
      ['pv64', 'pv32', 'pv16'].forEach((id) => { $(id).src = pvUrl; });
    }, 250);
  }

  /* ══ boot ═══════════════════════════════════════════════ */

  updateGrid();

  let loadedAutosave = false;
  try {
    const saved = localStorage.getItem('planetsvg_editor_autosave');
    if (saved) {
      restore(saved);
      loadedAutosave = true;
    }
  } catch (e) {
    console.warn('Failed to load auto-save', e);
  }

  if (!loadedAutosave) {
    if (location.hash === '#demo') { // sample composition (also used for testing)
      shapes = [
        { id: 1, type: 'ring', name: 'Ring 1', x: 256, y: 256, w: 384, h: 384, rot: 0, fh: 1, fv: 1, fill: '#5b9bff', op: 1, stroke: '#e8edf7', sw: 0, p: { t: 22 } },
        { id: 2, type: 'quarter', name: 'Quarter 2', x: 208, y: 304, w: 160, h: 160, rot: 0, fh: 1, fv: 1, fill: '#ff9d5c', op: 1, stroke: '#e8edf7', sw: 0, p: {} },
        { id: 3, type: 'star', name: 'Star 3', x: 304, y: 208, w: 128, h: 128, rot: 0, fh: 1, fv: 1, fill: '#a879ff', op: 1, stroke: '#e8edf7', sw: 0, p: { n: 5, k: 45 } }
      ];
      idSeq = 4;
      selIds = [3];
    }
    renderAll();
  }
})();
