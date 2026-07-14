/* PlanetForge — OBJ import, smart UV unwrap, layered texture painting and a
   software material preview. 100% local, no dependencies, no uploads. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = sel => [...document.querySelectorAll(sel)];
  let TEX = 1024; // user-selectable texture side in px

  /* ---------------- helpers ---------------- */
  function mkCanvas() { const c = document.createElement('canvas'); c.width = c.height = TEX; return c; }

  // Size a canvas's backing store to its CSS box × devicePixelRatio.
  // `cap` limits the longest backing side (software rasterizers get slow).
  function fit(canvas, cap) {
    const r = canvas.getBoundingClientRect();
    let d = window.devicePixelRatio || 1;
    if (cap) d = Math.min(d, cap / Math.max(r.width, r.height, 1));
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { ctx: canvas.getContext('2d'), w, h, d };
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ---------------- state ---------------- */
  const state = {
    mode: 'uv', tool: 'brush',
    mesh: null, meshName: '', normals: [],
    islands: [], faceMap: [], selected: -1,
    grid: true,
    orbit: { x: -0.35, y: 0.65 }, zoom: 1,
    layers: [], active: 0, undo: [], paintingMask: false,
    painting: false, lastPt: null,
    sphereRot: 0,
    drag: null,
    texturePreview: null, texturePreviewName: '',
    geometryVersion: 0, gpu: null,
    dirty: false,
  };
  const BUILTIN_MATERIALS={
    iron:{color:'#667078',roughness:.58,metallic:.92,height:.5},gold:{color:'#d4a72c',roughness:.24,metallic:1,height:.5},
    copper:{color:'#b66a3c',roughness:.3,metallic:.96,height:.5},rust:{color:'#8a3f1f',roughness:.88,metallic:.12,height:.68},
    steel:{color:'#a9b4bd',roughness:.34,metallic:.95,height:.5},paintedMetal:{color:'#355f8a',roughness:.42,metallic:.7,height:.52},
    rubber:{color:'#25282a',roughness:.82,metallic:0,height:.48},wood:{color:'#815331',roughness:.72,metallic:0,height:.62},
    stone:{color:'#77736b',roughness:.9,metallic:0,height:.7},plastic:{color:'#b43d48',roughness:.38,metallic:0,height:.5}
  };
  let customMaterials={};

  /* ---------------- geometry ---------------- */
  function faceNormal(mesh, f) {
    const a = mesh.v[f[0]], b = mesh.v[f[1]], c = mesh.v[f[2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }
  function computeNormals() { state.normals = state.mesh.f.map(f => faceNormal(state.mesh, f)); }

  function rotateVec(v) {
    const o = state.orbit, cy = Math.cos(o.y), sy = Math.sin(o.y), cx = Math.cos(o.x), sx = Math.sin(o.x);
    const X = v[0] * cy - v[2] * sy, Z0 = v[0] * sy + v[2] * cy;
    return [X, v[1] * cx - Z0 * sx, v[1] * sx + Z0 * cx];
  }
  function project(p, w, h) {
    const [X, Y, Z] = rotateVec(p);
    const s = Math.min(w, h) * 0.24 * state.zoom / (2.7 + Z * 0.12);
    return [w / 2 + X * s, h / 2 - Y * s, Z];
  }

  function normalizeMesh(mesh) {
    const v=mesh.v;
    const min=[0,1,2].map(j=>Math.min(...v.map(p=>p[j]))),max=[0,1,2].map(j=>Math.max(...v.map(p=>p[j])));
    const ctr=min.map((n,j)=>(n+max[j])/2),s=2/(Math.max(...max.map((n,j)=>n-min[j]))||1);
    mesh.v=v.map(p=>p.map((n,j)=>(n-ctr[j])*s)); return mesh;
  }

  function parseOBJ(text) {
    const v = [], vt=[], f = [], ft=[];
    for (const raw of text.split(/\r?\n/)) {
      const p = raw.trim().split(/\s+/);
      if (p[0] === 'v' && p.length >= 4) v.push([+p[1], +p[2], +p[3]]);
      else if(p[0]==='vt'&&p.length>=3)vt.push([+p[1],1-(+p[2])]);
      else if (p[0] === 'f' && p.length >= 4) {
        const ids = [], tids=[];
        for (let i = 1; i < p.length; i++) {
          const q=p[i].split('/'),n=parseInt(q[0],10),ti=parseInt(q[1],10);
          if (n) ids.push(n < 0 ? v.length + n : n - 1);
          tids.push(ti?(ti<0?vt.length+ti:ti-1):-1);
        }
        for (let i = 1; i < ids.length - 1; i++){f.push([ids[0],ids[i],ids[i+1]]);ft.push([tids[0],tids[i],tids[i+1]]);}
      }
    }
    const faces = f.filter(t => t.every(i => i >= 0 && i < v.length));
    if (v.length < 3 || !faces.length) throw new Error('No usable polygon geometry found in this OBJ');
    // normalize into a centered 2-unit box so orbit/zoom always frame it
    return normalizeMesh({v,f:faces,vt,ft});
  }

  function applyImportedUV(mesh){
    if(!mesh.vt?.length||!mesh.ft?.length)return false;
    state.islands=[];state.faceMap=[];
    mesh.f.forEach((face,fi)=>{const ids=mesh.ft[fi];if(!ids||ids.some(i=>!mesh.vt[i]))return;const pts=ids.map(i=>mesh.vt[i].slice());const isl={faces:[fi],pts,x:0,y:0,w:1,h:1};state.islands.push(isl);state.faceMap[fi]={isl,k:0};});
    state.geometryVersion++;return state.islands.length===mesh.f.length;
  }

  async function parseGLTF(file, companions){
    let json,bin=null;
    if(/\.glb$/i.test(file.name)){
      const ab=await file.arrayBuffer(),dv=new DataView(ab);if(dv.getUint32(0,true)!==0x46546c67)throw Error('Invalid GLB header');let o=12;
      while(o<ab.byteLength){const len=dv.getUint32(o,true),type=dv.getUint32(o+4,true),chunk=ab.slice(o+8,o+8+len);if(type===0x4e4f534a)json=JSON.parse(new TextDecoder().decode(chunk));else if(type===0x004e4942)bin=chunk;o+=8+len;}
    }else json=JSON.parse(await file.text());
    const buffers=[];
    for(let i=0;i<(json.buffers||[]).length;i++){const uri=json.buffers[i].uri;if(!uri){buffers.push(bin);continue;}if(uri.startsWith('data:')){const raw=atob(uri.slice(uri.indexOf(',')+1)),a=new Uint8Array(raw.length);for(let j=0;j<raw.length;j++)a[j]=raw.charCodeAt(j);buffers.push(a.buffer);}else{const match=companions.find(f=>f.name===decodeURIComponent(uri).split('/').pop());if(!match)throw Error(`Select companion buffer “${uri}” together with the glTF`);buffers.push(await match.arrayBuffer());}}
    const comps={5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array},width={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
    const read=ai=>{const a=json.accessors[ai],bv=json.bufferViews[a.bufferView],C=comps[a.componentType],n=width[a.type],stride=bv.byteStride||C.BYTES_PER_ELEMENT*n,base=(bv.byteOffset||0)+(a.byteOffset||0),dv=new DataView(buffers[bv.buffer]);const getter={5120:'getInt8',5121:'getUint8',5122:'getInt16',5123:'getUint16',5125:'getUint32',5126:'getFloat32'}[a.componentType],out=[];for(let i=0;i<a.count;i++){const row=[];for(let k=0;k<n;k++)row.push(dv[getter](base+i*stride+k*C.BYTES_PER_ELEMENT,true));out.push(n===1?row[0]:row);}return out;};
    const v=[],vt=[],f=[],ft=[];
    for(const mesh of json.meshes||[])for(const p of mesh.primitives||[]){if((p.mode??4)!==4||p.attributes.POSITION===undefined)continue;const pos=read(p.attributes.POSITION),uv=p.attributes.TEXCOORD_0!==undefined?read(p.attributes.TEXCOORD_0):null,idx=p.indices!==undefined?read(p.indices):pos.map((_,i)=>i),vo=v.length,to=vt.length;v.push(...pos.map(x=>x.slice(0,3)));if(uv)vt.push(...uv.map(x=>[x[0],1-x[1]]));for(let i=0;i+2<idx.length;i+=3){f.push([vo+idx[i],vo+idx[i+1],vo+idx[i+2]]);ft.push(uv?[to+idx[i],to+idx[i+1],to+idx[i+2]]:[-1,-1,-1]);}}
    if(!f.length)throw Error('No triangle mesh found in this glTF/GLB');return normalizeMesh({v,f,vt,ft});
  }

  async function parseFBX(file){
    const loaderURL=new URL('./vendor/three/addons/loaders/FBXLoader.js',document.baseURI).href;
    const {FBXLoader}=await import(loaderURL);
    const root=new FBXLoader().parse(await file.arrayBuffer(),'');root.updateMatrixWorld(true);
    const v=[],vt=[],f=[],ft=[];
    root.traverse(obj=>{if(!obj.isMesh||!obj.geometry?.attributes?.position)return;const g=obj.geometry.clone();g.applyMatrix4(obj.matrixWorld);const p=g.attributes.position,u=g.attributes.uv,idx=g.index?Array.from(g.index.array):Array.from({length:p.count},(_,i)=>i),vo=v.length,to=vt.length;for(let i=0;i<p.count;i++)v.push([p.getX(i),p.getY(i),p.getZ(i)]);if(u)for(let i=0;i<u.count;i++)vt.push([u.getX(i),1-u.getY(i)]);for(let i=0;i+2<idx.length;i+=3){f.push([vo+idx[i],vo+idx[i+1],vo+idx[i+2]]);ft.push(u?[to+idx[i],to+idx[i+1],to+idx[i+2]]:[-1,-1,-1]);}});
    if(!f.length)throw Error('Three.js found no usable mesh geometry in this FBX');return normalizeMesh({v,f,vt,ft});
  }

  function demoMesh() {
    return {
      v: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      f: [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]],
    };
  }

  /* ---------------- unwrap & pack ---------------- */
  // Islands keep their true relative 3D size until packing, so texel
  // density stays consistent across the mesh.
  function unwrap() {
    const mesh = state.mesh, faces = mesh.f, normals = state.normals;
    const method = $('unwrapMethod').value;
    const angleLimit = Math.cos(+$('seamAngle').value * Math.PI / 180);
    const axisOf = n => {
      const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
      const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
      return i * 2 + (n[i] < 0 ? 1 : 0);
    };

    const edges = new Map();
    faces.forEach((f, fi) => {
      for (let j = 0; j < 3; j++) {
        const a = f[j], b = f[(j + 1) % 3], key = a < b ? a + '_' + b : b + '_' + a;
        const list = edges.get(key) || [];
        list.push(fi);
        edges.set(key, list);
      }
    });
    const adj = faces.map(() => []);
    edges.forEach(list => {
      if (list.length !== 2) return;
      const [p, q] = list;
      const join = method === 'projection'
        ? axisOf(normals[p]) === axisOf(normals[q])
        : normals[p][0] * normals[q][0] + normals[p][1] * normals[q][1] + normals[p][2] * normals[q][2] >= angleLimit;
      if (join) { adj[p].push(q); adj[q].push(p); }
    });

    const seen = new Uint8Array(faces.length), islands = [];
    for (let start = 0; start < faces.length; start++) {
      if (seen[start]) continue;
      const comp = [], stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        comp.push(i);
        for (const nb of adj[i]) if (!seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
      const av = [0, 0, 0];
      comp.forEach(i => { av[0] += normals[i][0]; av[1] += normals[i][1]; av[2] += normals[i][2]; });
      const ax = [Math.abs(av[0]), Math.abs(av[1]), Math.abs(av[2])];
      const drop = ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2;
      const flip = av[drop] < 0 ? -1 : 1; // avoid mirrored texture on back faces
      const pts = [];
      comp.forEach(fi => faces[fi].forEach(vi => {
        const p = mesh.v[vi];
        if (drop === 0) pts.push([p[2] * flip, -p[1]]);
        else if (drop === 1) pts.push([p[0], p[2] * flip]);
        else pts.push([-p[0] * flip, -p[1]]);
      }));
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
      pts.forEach(p => {
        minU = Math.min(minU, p[0]); maxU = Math.max(maxU, p[0]);
        minV = Math.min(minV, p[1]); maxV = Math.max(maxV, p[1]);
      });
      islands.push({
        faces: comp,
        pts: pts.map(p => [p[0] - minU, p[1] - minV]),
        x: 0, y: 0, w: (maxU - minU) || 1e-6, h: (maxV - minV) || 1e-6,
      });
    }

    if ($('orient').checked) islands.forEach(isl => {
      if (isl.h > isl.w * 1.02) {
        isl.pts = isl.pts.map(([u, v]) => [isl.h - v, u]);
        const t = isl.w; isl.w = isl.h; isl.h = t;
      }
    });

    packIslands(islands, +$('padding').value, $('preserve').checked);

    state.islands = islands;
    state.geometryVersion++;
    state.selected = -1;
    state.faceMap = [];
    islands.forEach(isl => isl.faces.forEach((fi, k) => { state.faceMap[fi] = { isl, k }; }));
    updateIslandButtons();
    updateStatus();
    drawUV();
    drawModel();
    toast(`Unwrapped ${islands.length} UV island${islands.length === 1 ? '' : 's'}`);
  }

  // Shelf packing in world units, two passes so the padding slider maps to
  // real texture pixels, then everything is scaled uniformly into 0–1 UV.
  function packIslands(islands, padPx, preserveOrder) {
    if (!islands.length) return;
    const order = [...islands];
    if (!preserveOrder) order.sort((a, b) => b.h - a.h);
    let gap = 0, side = 1;
    for (let pass = 0; pass < 2; pass++) {
      const total = order.reduce((s, i) => s + (i.w + gap) * (i.h + gap), 0);
      const target = Math.max(Math.sqrt(total) * 1.08, Math.max(...order.map(i => i.w)) + gap * 2);
      let x = gap, y = gap, rowH = 0, maxX = 0;
      for (const it of order) {
        if (x + it.w + gap > target && x > gap) { x = gap; y += rowH + gap; rowH = 0; }
        it.x = x; it.y = y;
        x += it.w + gap;
        rowH = Math.max(rowH, it.h);
        maxX = Math.max(maxX, x);
      }
      side = Math.max(maxX, y + rowH + gap);
      if (pass === 0) gap = padPx / TEX * side;
    }
    const s = 1 / side;
    islands.forEach(it => {
      it.x *= s; it.y *= s; it.w *= s; it.h *= s;
      it.pts = it.pts.map(p => [p[0] * s, p[1] * s]);
    });
  }

  /* ---------------- UV editor ---------------- */
  let uvView = null; // {ox,oy,size,d} of the 0-1 square inside the canvas

  function drawUV() {
    const { ctx, w, h, d } = fit($('uvCanvas'));
    ctx.clearRect(0, 0, w, h);
    const pad = 26 * d, size = Math.min(w, h) - pad * 2;
    const ox = (w - size) / 2, oy = (h - size) / 2;
    uvView = { ox, oy, size, d };
    if (state.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        const p = i * size / 10;
        ctx.beginPath(); ctx.moveTo(ox + p, oy); ctx.lineTo(ox + p, oy + size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ox, oy + p); ctx.lineTo(ox + size, oy + p); ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, size, size);
    const fills = ['rgba(143,177,217,.16)', 'rgba(201,178,133,.16)', 'rgba(185,143,217,.16)', 'rgba(143,217,207,.16)', 'rgba(217,143,156,.16)'];
    state.islands.forEach((isl, ii) => {
      ctx.beginPath();
      for (let k = 0; k < isl.faces.length; k++) {
        for (let c = 0; c < 3; c++) {
          const p = isl.pts[k * 3 + c];
          const X = ox + (isl.x + p[0]) * size, Y = oy + (isl.y + p[1]) * size;
          c ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
        }
        ctx.closePath();
      }
      const sel = ii === state.selected;
      ctx.fillStyle = sel ? 'rgba(92,182,146,.30)' : fills[ii % fills.length];
      ctx.fill();
      ctx.strokeStyle = sel ? '#5cb692' : 'rgba(255,255,255,.30)';
      ctx.lineWidth = (sel ? 1.8 : 1) * d;
      ctx.stroke();
    });
  }

  function selectedIsland() { return state.islands[state.selected] || null; }
  function updateIslandButtons() {
    const off = state.selected < 0;
    ['rotateIsland', 'flipIslandH', 'flipIslandV'].forEach(id => { $(id).disabled = off; });
  }
  function transformIsland(fn) {
    const isl = selectedIsland();
    if (!isl) return;
    fn(isl);
    state.geometryVersion++;
    isl.x = Math.min(isl.x, Math.max(0, 1 - isl.w));
    isl.y = Math.min(isl.y, Math.max(0, 1 - isl.h));
    drawUV();
    drawModel();
  }

  /* ---------------- 3D viewport ---------------- */
  function drawModel(target) {
    const canvas=target||$('modelCanvas');
    if(state.gpu){
      const view=canvas===$('paintModelCanvas')?state.gpu.paint:state.gpu.model;
      canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
      view.render(state.mesh,state.faceMap,state.geometryVersion,state.texturePreview||getComposite(false).canvas,$('renderMode')?.value||'texture',state.orbit,state.zoom,{roughness:+$('roughness').value/100,metalness:+$('metallic').value/100,roughnessMap:getComposite(false,'roughness').canvas,metalnessMap:getComposite(false,'metallic').canvas});
      return;
    }
    const { ctx, w, h } = fit(canvas, 1400);
    ctx.clearRect(0, 0, w, h);
    const mesh = state.mesh;
    if (!mesh) return;
    const mode = $('renderMode')?.value || 'texture';
    const texture = state.texturePreview || getComposite(false).canvas;
    const L = [-0.35, 0.58, 0.74];
    const tris = mesh.f.map((f, i) => {
      const p = [project(mesh.v[f[0]], w, h), project(mesh.v[f[1]], w, h), project(mesh.v[f[2]], w, h)];
      return { p, z: p[0][2] + p[1][2] + p[2][2], i };
    }).sort((a, b) => b.z - a.z);
    for (const t of tris) {
      const n = rotateVec(state.normals[t.i]), lam = Math.max(0,n[0]*L[0]+n[1]*L[1]+n[2]*L[2]);
      const m=state.faceMap[t.i];
      ctx.beginPath();
      ctx.moveTo(t.p[0][0], t.p[0][1]);
      ctx.lineTo(t.p[1][0], t.p[1][1]);
      ctx.lineTo(t.p[2][0], t.p[2][1]);
      ctx.closePath();
      ctx.closePath(); ctx.save(); ctx.clip();
      if(mode!=='solid' && m){
        const s=m.isl.pts.slice(m.k*3,m.k*3+3).map(p=>[(m.isl.x+p[0])*TEX,(m.isl.y+p[1])*TEX]);
        const d=t.p, den=s[0][0]*(s[1][1]-s[2][1])+s[1][0]*(s[2][1]-s[0][1])+s[2][0]*(s[0][1]-s[1][1]);
        if(Math.abs(den)>1e-8){
          const a=(d[0][0]*(s[1][1]-s[2][1])+d[1][0]*(s[2][1]-s[0][1])+d[2][0]*(s[0][1]-s[1][1]))/den;
          const c=(d[0][1]*(s[1][1]-s[2][1])+d[1][1]*(s[2][1]-s[0][1])+d[2][1]*(s[0][1]-s[1][1]))/den;
          const b=(d[0][0]*(s[2][0]-s[1][0])+d[1][0]*(s[0][0]-s[2][0])+d[2][0]*(s[1][0]-s[0][0]))/den;
          const dd=(d[0][1]*(s[2][0]-s[1][0])+d[1][1]*(s[0][0]-s[2][0])+d[2][1]*(s[1][0]-s[0][0]))/den;
          const e=(d[0][0]*(s[1][0]*s[2][1]-s[2][0]*s[1][1])+d[1][0]*(s[2][0]*s[0][1]-s[0][0]*s[2][1])+d[2][0]*(s[0][0]*s[1][1]-s[1][0]*s[0][1]))/den;
          const f=(d[0][1]*(s[1][0]*s[2][1]-s[2][0]*s[1][1])+d[1][1]*(s[2][0]*s[0][1]-s[0][0]*s[2][1])+d[2][1]*(s[0][0]*s[1][1]-s[1][0]*s[0][1]))/den;
          ctx.setTransform(a,c,b,dd,e,f);ctx.drawImage(texture,0,0);
        }
      } else {ctx.fillStyle='#d8dadd';ctx.fill();}
      ctx.restore();
      if(mode==='rendered'){ctx.fillStyle=`rgba(10,14,18,${Math.max(0,.52-lam*.48)})`;ctx.fill();ctx.fillStyle=`rgba(255,255,255,${Math.pow(lam,12)*.22})`;ctx.fill();}
      else if(mode==='solid'){ctx.fillStyle=`rgba(25,30,36,${Math.max(0,.30-lam*.25)})`;ctx.fill();}
      ctx.strokeStyle='rgba(255,255,255,.035)';ctx.lineWidth=.7;ctx.stroke();
    }
  }

  /* ---------------- layers & compositing ---------------- */
  const compCanvas = mkCanvas();
  const channelCache = new Map();
  const strokeCanvas = mkCanvas(), strokeCtx = strokeCanvas.getContext('2d');
  const previewCanvas = mkCanvas(), previewCtx = previewCanvas.getContext('2d');
  let compDirty = true, compData = null;

  function setTextureResolution(size, preserve=true){
    size=+size;if(![256,512,1024,2048,4096].includes(size)||size===TEX)return;
    const resize=(c,keep)=>{let old=null;if(keep){old=document.createElement('canvas');old.width=c.width;old.height=c.height;old.getContext('2d').drawImage(c,0,0);}c.width=c.height=size;if(old)c.getContext('2d').drawImage(old,0,0,size,size);};
    state.layers.forEach(l=>{resize(l.canvas,preserve);if(l.mask)resize(l.mask,preserve)});
    if(state.texturePreview)resize(state.texturePreview,preserve);
    TEX=size;[compCanvas,strokeCanvas,previewCanvas].forEach(c=>{c.width=c.height=size});
    $('paintCanvas').width=$('paintCanvas').height=size;$('textureResolution').value=String(size);
    $('paintLabel').textContent=`${$('paintChannel').selectedOptions[0].text} · ${size}²`;
    state.undo.length=0;invalidate();redraw();toast(`Texture resolution set to ${size} × ${size}`);
  }

  function invalidate() { compDirty = true; channelCache.clear(); state.dirty = true; }
  function getComposite(withData, channel='baseColor') {
    if(channel!=='baseColor'){
      if(!channelCache.has(channel)){const canvas=mkCanvas(),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,TEX,TEX);for(let i=state.layers.length-1;i>=0;i--){const l=state.layers[i];if(!l.visible||(l.channel||'baseColor')!==channel)continue;if(!l.mask)ctx.drawImage(l.canvas,0,0);else{const tmp=mkCanvas(),tc=tmp.getContext('2d');tc.drawImage(l.canvas,0,0);tc.globalCompositeOperation='destination-in';tc.drawImage(l.mask,0,0);ctx.drawImage(tmp,0,0);}}channelCache.set(channel,{canvas,data:null});}const out=channelCache.get(channel);if(withData&&!out.data)out.data=out.canvas.getContext('2d').getImageData(0,0,TEX,TEX).data;return out;
    }
    if (compDirty) {
      const ctx = compCanvas.getContext('2d');
      ctx.clearRect(0, 0, TEX, TEX);
      for (let i = state.layers.length - 1; i >= 0; i--) {
        const l=state.layers[i];
        if (!l.visible || (l.channel || 'baseColor') !== 'baseColor') continue;
        if (!l.mask) ctx.drawImage(l.canvas,0,0);
        else { const tmp=mkCanvas(), tc=tmp.getContext('2d'); tc.drawImage(l.canvas,0,0); tc.globalCompositeOperation='destination-in'; tc.drawImage(l.mask,0,0); ctx.drawImage(tmp,0,0); }
      }
      compDirty = false;
      compData = null;
    }
    if (withData && !compData) compData = compCanvas.getContext('2d').getImageData(0, 0, TEX, TEX).data;
    return { canvas: compCanvas, data: compData };
  }

  function activeLayer() { return state.layers[state.active] || null; }
  function addLayer(name, channel) {
    state.layers.unshift({ name, channel: channel || ($('paintChannel') ? $('paintChannel').value : 'baseColor'), canvas: mkCanvas(), visible: true, mask: null });
    state.active = 0;
    renderLayers();
    invalidate();
  }

  function renderLayers() {
    const box = $('layers');
    box.innerHTML = '';
    state.layers.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (i === state.active ? ' sel' : '');
      row.onclick = () => { state.active = i; renderLayers(); updateStatus(); };

      const eye = document.createElement('button');
      eye.className = 'lbtn' + (l.visible ? '' : ' off');
      eye.title = 'Toggle visibility';
      eye.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>';
      eye.onclick = e => { e.stopPropagation(); l.visible = !l.visible; invalidate(); renderLayers(); drawPaint(); };

      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = `${l.mask ? '◐ ' : ''}${l.name}`;

      const mk = (label, title, disabled, fn) => {
        const b = document.createElement('button');
        b.className = 'lbtn';
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.onclick = e => { e.stopPropagation(); fn(); };
        return b;
      };
      const act = activeLayer();
      const move = dir => {
        state.layers.splice(i + dir, 0, ...state.layers.splice(i, 1));
        state.active = state.layers.indexOf(act);
        invalidate(); renderLayers(); drawPaint();
      };
      row.append(
        eye, name,
        mk('▲', 'Move up', i === 0, () => move(-1)),
        mk('▼', 'Move down', i === state.layers.length - 1, () => move(1)),
        mk('✕', 'Delete layer', state.layers.length < 2, () => {
          state.layers.splice(i, 1);
          state.active = Math.min(state.active, state.layers.length - 1);
          invalidate(); renderLayers(); drawPaint(); updateStatus();
        }),
      );
      box.append(row);
    });
  }

  /* ---------------- painting ---------------- */
  // Strokes are dabbed at full opacity into strokeCanvas, then committed to
  // the layer once with the opacity slider — so opacity never stacks
  // mid-stroke, exactly like a real painting app.
  function paintPos(e) {
    const r = $('paintCanvas').getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * TEX, (e.clientY - r.top) / r.height * TEX];
  }

  function dab(x, y) {
    const size = +$('brushSize').value, hard = +$('hardness').value / 100;
    const col = state.tool === 'erase' ? '#000000' : $('brushColor').value;
    const rad = Math.max(0.5, size / 2);
    const g = strokeCtx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, col);
    g.addColorStop(Math.min(0.99, hard), col);
    g.addColorStop(1, col + '00');
    strokeCtx.fillStyle = g;
    strokeCtx.beginPath();
    strokeCtx.arc(x, y, rad, 0, Math.PI * 2);
    strokeCtx.fill();
    const preset = $('brushPreset')?.value || 'round';
    if (['rust','grunge','speckle','splatter','spray','dirt','stars'].includes(preset)) {
      const count = {speckle:10,splatter:32,spray:55,dirt:26,stars:8}[preset] || 22;
      strokeCtx.fillStyle = col;
      for (let i=0;i<count;i++) {
        const a=Math.random()*Math.PI*2, rr=Math.sqrt(Math.random())*rad;
        strokeCtx.globalAlpha = .12 + Math.random()*.55;
        const scale=preset==='splatter'?.18:preset==='spray'?.025:preset==='stars'?.08:preset==='rust'?.12:.06;
        const px=x+Math.cos(a)*rr,py=y+Math.sin(a)*rr,pr=Math.max(1,rad*(.012+Math.random()*scale));
        strokeCtx.beginPath();
        if(preset==='stars'){for(let k=0;k<10;k++){const ar=-Math.PI/2+k*Math.PI/5,ro=k%2?pr*.42:pr;const X=px+Math.cos(ar)*ro,Y=py+Math.sin(ar)*ro;k?strokeCtx.lineTo(X,Y):strokeCtx.moveTo(X,Y);}strokeCtx.closePath();}
        else strokeCtx.arc(px,py,pr,0,Math.PI*2);
        strokeCtx.fill();
      }
      strokeCtx.globalAlpha=1;
    }
    if(preset==='scratches'||preset==='cracks'){
      strokeCtx.save();strokeCtx.strokeStyle=col;strokeCtx.lineCap='round';
      const count=preset==='scratches'?7:4;
      for(let i=0;i<count;i++){let px=x+(Math.random()-.5)*rad,py=y+(Math.random()-.5)*rad;strokeCtx.globalAlpha=.2+Math.random()*.55;strokeCtx.lineWidth=Math.max(1,rad*(.01+Math.random()*.025));strokeCtx.beginPath();strokeCtx.moveTo(px,py);for(let k=0;k<(preset==='cracks'?5:2);k++){px+=(Math.random()-.5)*rad*.65;py+=(preset==='scratches'?.7:(Math.random()-.5))*rad*.65;strokeCtx.lineTo(px,py);}strokeCtx.stroke();}strokeCtx.restore();
    }
  }

  function strokeTo(x, y) {
    const last = state.lastPt;
    if (!last) { dab(x, y); state.lastPt = [x, y]; return; }
    const dx = x - last[0], dy = y - last[1], dist = Math.hypot(dx, dy);
    const step = Math.max(1.5, +$('brushSize').value * 0.12);
    if (dist < step) return;
    const n = Math.ceil(dist / step);
    for (let i = 1; i <= n; i++) dab(last[0] + dx * i / n, last[1] + dy * i / n);
    state.lastPt = [x, y];
  }

  function commitStroke() {
    const l = activeLayer();
    if (!l) return;
    const apply=(layer,color)=>{const target=state.paintingMask&&layer===l&&layer.mask?layer.mask:layer.canvas,ctx=target.getContext('2d');let source=strokeCanvas;if(color&&state.tool!=='erase'){source=mkCanvas();const sc=source.getContext('2d');sc.drawImage(strokeCanvas,0,0);sc.globalCompositeOperation='source-in';sc.fillStyle=color;sc.fillRect(0,0,TEX,TEX);}ctx.save();ctx.globalAlpha=+$('brushOpacity').value/100;ctx.globalCompositeOperation=state.tool==='erase'?'destination-out':'source-over';ctx.drawImage(source,0,0);ctx.restore();};
    if($('materialBrush')?.checked&&!state.paintingMask){const mat=BUILTIN_MATERIALS[$('materialPreset').value]||customMaterials[$('materialPreset').value]||BUILTIN_MATERIALS.iron;const values={baseColor:mat.color,roughness:gray(mat.roughness),metallic:gray(mat.metallic),height:gray(mat.height)};for(const [ch,color] of Object.entries(values)){let layer=state.layers.find(x=>(x.channel||'baseColor')===ch&&x.materialPaint);if(!layer){layer={name:`${$('materialPreset').value} · ${ch}`,channel:ch,canvas:mkCanvas(),visible:true,mask:null,materialPaint:true};state.layers.unshift(layer);}apply(layer,color);}state.active=state.layers.indexOf(l);}
    else apply(l,null);
    strokeCtx.clearRect(0, 0, TEX, TEX);
    state.lastPt = null;
    invalidate();
    renderLayers();
  }

  function gray(v){const n=Math.max(0,Math.min(255,Math.round(v*255))).toString(16).padStart(2,'0');return `#${n}${n}${n}`;}

  function pushUndo() {
    const l = activeLayer();
    if (!l) return;
    const snap = mkCanvas();
    const mask = state.paintingMask && l.mask;
    snap.getContext('2d').drawImage(mask ? l.mask : l.canvas, 0, 0);
    state.undo.push({ layer: l, snap, mask });
    if (state.undo.length > 8) state.undo.shift();
  }
  function undoPaint() {
    while (state.undo.length) {
      const u = state.undo.pop();
      if (!state.layers.includes(u.layer)) continue; // layer was deleted
      const target = u.mask && u.layer.mask ? u.layer.mask : u.layer.canvas;
      const ctx = target.getContext('2d');
      ctx.clearRect(0, 0, TEX, TEX);
      ctx.drawImage(u.snap, 0, 0);
      invalidate();
      drawPaint();
      toast('Stroke undone');
      return;
    }
    toast('Nothing to undo');
  }

  function islandAtUV(u, v) {
    for (let i = state.islands.length - 1; i >= 0; i--) {
      const isl = state.islands[i];
      if (u < isl.x || u > isl.x + isl.w || v < isl.y || v > isl.y + isl.h) continue;
      const lu = u - isl.x, lv = v - isl.y;
      for (let k = 0; k < isl.faces.length; k++) {
        const a = isl.pts[k * 3], b = isl.pts[k * 3 + 1], c = isl.pts[k * 3 + 2];
        const d1 = (lu - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (lv - b[1]);
        const d2 = (lu - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (lv - c[1]);
        const d3 = (lu - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (lv - a[1]);
        if (!(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)))) return isl;
      }
    }
    return null;
  }

  function fillAt(x, y) {
    const l = activeLayer();
    if (!l) return;
    pushUndo();
    const ctx = l.canvas.getContext('2d');
    ctx.save();
    ctx.globalAlpha = +$('brushOpacity').value / 100;
    ctx.fillStyle = $('brushColor').value;
    const isl = islandAtUV(x / TEX, y / TEX);
    if (isl) {
      ctx.beginPath();
      for (let k = 0; k < isl.faces.length; k++) {
        for (let c = 0; c < 3; c++) {
          const p = isl.pts[k * 3 + c];
          const X = (isl.x + p[0]) * TEX, Y = (isl.y + p[1]) * TEX;
          c ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
        }
        ctx.closePath();
      }
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
      toast('Filled UV island');
    } else {
      ctx.fillRect(0, 0, TEX, TEX);
      toast('Filled whole layer');
    }
    ctx.restore();
    invalidate();
    drawPaint();
  }

  function pickAt(x, y) {
    const { data } = getComposite(true);
    const tx = Math.min(TEX - 1, Math.max(0, x | 0)), ty = Math.min(TEX - 1, Math.max(0, y | 0));
    const ti = (ty * TEX + tx) * 4;
    $('brushColor').value = '#' + [data[ti], data[ti + 1], data[ti + 2]].map(n => n.toString(16).padStart(2, '0')).join('');
    toast('Color picked');
  }

  function drawPaint() {
    const ctx = $('paintCanvas').getContext('2d');
    ctx.clearRect(0, 0, TEX, TEX);
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (!l.visible || (l.channel || 'baseColor') !== $('paintChannel').value) continue;
      if (state.painting && i === state.active) {
        previewCtx.clearRect(0, 0, TEX, TEX);
        previewCtx.drawImage(l.canvas, 0, 0);
        previewCtx.save();
        previewCtx.globalAlpha = +$('brushOpacity').value / 100;
        previewCtx.globalCompositeOperation = state.tool === 'erase' ? 'destination-out' : 'source-over';
        previewCtx.drawImage(strokeCanvas, 0, 0);
        previewCtx.restore();
        ctx.drawImage(previewCanvas, 0, 0);
      } else ctx.drawImage(l.canvas, 0, 0);
    }
    if(state.texturePreview) ctx.drawImage(state.texturePreview,0,0);
    if ($('wireToggle').checked && state.islands.length) {
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const isl of state.islands) {
        for (let k = 0; k < isl.faces.length; k++) {
          for (let c = 0; c < 3; c++) {
            const p = isl.pts[k * 3 + c];
            const X = (isl.x + p[0]) * TEX, Y = (isl.y + p[1]) * TEX;
            c ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
          }
          const p0 = isl.pts[k * 3];
          ctx.lineTo((isl.x + p0[0]) * TEX, (isl.y + p0[1]) * TEX);
        }
      }
      ctx.stroke();
    }
    drawModel($('paintModelCanvas'));
  }

  /* ---------------- material preview ---------------- */
  const ENVS = {
    studio: { light: [1, 1, 1], amb: 0.16 },
    courtyard: { light: [1, 0.94, 0.82], amb: 0.24 },
    night: { light: [0.72, 0.82, 1], amb: 0.07 },
  };

  let matPending = false;
  function requestMaterial() {
    if (matPending) return;
    matPending = true;
    requestAnimationFrame(() => { matPending = false; drawMaterial(); });
  }

  function drawMaterial() {
    if(state.gpu?.material){const c=$('materialCanvas');c.getContext('2d').clearRect(0,0,c.width,c.height);state.gpu.material.renderMaterial(getComposite(false).canvas,state.sphereRot,+$('roughness').value/100,+$('metallic').value/100,+$('light').value*Math.PI/180);return;}
    const { ctx, w, h, d } = fit($('materialCanvas'), 860);
    ctx.clearRect(0, 0, w, h);
    const tex = getComposite(true).data;
    const rough = +$('roughness').value / 100, metal = +$('metallic').value / 100, bump = +$('bump').value / 100;
    const env = ENVS[$('environment').value] || ENVS.studio;
    const a = +$('light').value * Math.PI / 180, lx = Math.cos(a), ly = Math.sin(a);
    const R = Math.min(w, h) * 0.36, cx = w / 2, cy = h * 0.5;
    const shin = 4 + 120 * (1 - rough) * (1 - rough);
    const img = ctx.createImageData(w, h), out = img.data;
    for (let yy = Math.max(0, (cy - R) | 0); yy < Math.min(h, cy + R + 1); yy++) {
      for (let xx = Math.max(0, (cx - R) | 0); xx < Math.min(w, cx + R + 1); xx++) {
        const nx0 = (xx - cx) / R, ny = (yy - cy) / R, q = nx0 * nx0 + ny * ny;
        if (q > 1) continue;
        const nz = Math.sqrt(1 - q);
        const u = ((Math.atan2(nx0, nz) / (Math.PI * 2) + 0.5 + state.sphereRot) % 1 + 1) % 1;
        const v = Math.acos(Math.max(-1, Math.min(1, -ny))) / Math.PI;
        const tx = (u * (TEX - 1)) | 0, ty = (v * (TEX - 1)) | 0, ti = (ty * TEX + tx) * 4;
        const al = tex[ti + 3] / 255;
        const cr = tex[ti] * al + 96 * (1 - al);
        const cg = tex[ti + 1] * al + 96 * (1 - al);
        const cb = tex[ti + 2] * al + 96 * (1 - al);
        // bump: nudge the normal by the luminance slope along u
        const tx2 = Math.min(TEX - 1, tx + 2), ti2 = (ty * TEX + tx2) * 4;
        const al2 = tex[ti2 + 3] / 255;
        const lum = (cr + cg + cb) / 765;
        const lum2 = ((tex[ti2] + tex[ti2 + 1] + tex[ti2 + 2]) * al2 + 288 * (1 - al2)) / 765;
        const nx = nx0 + (lum - lum2) * bump * 2;
        const diff = Math.max(env.amb, nx * lx + (-ny) * ly * 0.9 + nz * 0.55);
        const spec = Math.pow(Math.max(0, nx * lx + (-ny) * ly + nz * 0.75), shin) * (1 - rough * 0.85);
        const base = [cr, cg, cb], di = (yy * w + xx) * 4;
        for (let k = 0; k < 3; k++) {
          const lc = env.light[k];
          const dielectric = base[k] * diff * lc + 255 * spec * 0.55 * lc;
          const metallic = base[k] * diff * lc * 0.55 + base[k] * spec * 1.6 * lc;
          out[di + k] = Math.min(255, dielectric * (1 - metal) + metallic * metal + base[k] * env.amb * 0.4);
        }
        out[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 2 * d;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* ---------------- project save / load ---------------- */
  function setSlider(id, outId, val, suffix) {
    $(id).value = val;
    if (outId) $(outId).value = $(id).value + suffix;
  }

  function saveProject() {
    const data = projectData();
    const a = document.createElement('a');
    a.download = 'planetforge-project.json';
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    state.dirty=false;toast('Project saved');
  }
  function projectData(){return {
      version: 3,
      textureResolution:TEX,
      meshName: state.meshName,
      mesh: state.mesh,
      islands: state.islands,
      material: {
        roughness: $('roughness').value, metallic: $('metallic').value, bump: $('bump').value,
        light: $('light').value, environment: $('environment').value,
      },
      layers: state.layers.map(l => ({ name: l.name, channel:l.channel||'baseColor', materialPaint:!!l.materialPaint, visible: l.visible, data: l.canvas.toDataURL('image/png'), mask:l.mask?l.mask.toDataURL('image/png'):null })),
    }}

  async function loadProject(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data.mesh || !Array.isArray(data.layers)) throw new Error('not a PlanetForge project file');
      if(data.textureResolution&&data.textureResolution!==TEX)setTextureResolution(+data.textureResolution,false);
      state.mesh = data.mesh;
      state.meshName = data.meshName || 'Loaded project';
      computeNormals();
      state.islands = data.islands || [];
      state.geometryVersion++;
      state.faceMap = [];
      state.islands.forEach(isl => isl.faces.forEach((fi, k) => { state.faceMap[fi] = { isl, k }; }));
      const layers = [];
      for (const l of data.layers) {
        const canvas = mkCanvas();
        if (l.data) await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => { canvas.getContext('2d').drawImage(im, 0, 0, TEX, TEX); res(); };
          im.onerror = () => rej(new Error('broken layer image'));
          im.src = l.data;
        });
        let mask=null;
        if(l.mask){mask=mkCanvas();await new Promise((res,rej)=>{const im=new Image();im.onload=()=>{mask.getContext('2d').drawImage(im,0,0,TEX,TEX);res()};im.onerror=rej;im.src=l.mask})}
        layers.push({ name: l.name || 'Layer', channel:l.channel||'baseColor', materialPaint:!!l.materialPaint, visible: l.visible !== false, canvas, mask });
      }
      state.layers = layers;
      state.active = 0;
      if (!state.layers.length) addLayer('Base color'); else renderLayers();
      const m = data.material || {};
      setSlider('roughness', 'roughOut', m.roughness ?? 46, '%');
      setSlider('metallic', 'metalOut', m.metallic ?? 4, '%');
      setSlider('bump', 'bumpOut', m.bump ?? 38, '%');
      setSlider('light', 'lightOut', m.light ?? 315, '°');
      $('environment').value = ENVS[m.environment] ? m.environment : 'studio';
      $('materialWorkspace').dataset.env = $('environment').value;
      state.undo.length = 0;
      state.selected = -1;
      invalidate();
      $('modelStats').textContent = `${state.meshName} · ${state.mesh.f.length.toLocaleString()} tris`;
      updateIslandButtons();
      updateStatus();
      redraw();
      state.dirty=false;
      toast('Project loaded');
    } catch (err) {
      toast('Could not load project: ' + err.message);
    }
  }

  /* ---------------- imports ---------------- */
  async function importOBJ(file) {
    try {
      state.mesh = parseOBJ(await file.text());
      state.meshName = file.name;
      computeNormals();
      $('modelStats').textContent = `${file.name} · ${state.mesh.f.length.toLocaleString()} tris`;
      if (state.mesh.f.length > 60000) toast('Large mesh — unwrap and orbit may be slow');
      if (state.mode !== 'uv') setMode('uv');
      if(applyImportedUV(state.mesh)){updateIslandButtons();updateStatus();redraw();toast(`Imported ${state.islands.length} UV-mapped triangles`);}else unwrap();
    } catch (err) {
      toast(err.message);
    }
  }

  async function importModelFiles(files){
    const list=[...files],main=list.find(f=>/\.(obj|gltf|glb|fbx)$/i.test(f.name));if(!main)return toast('Choose an OBJ, glTF, GLB, or FBX model');
    if(/\.obj$/i.test(main.name))return importOBJ(main);
    try{state.mesh=/\.fbx$/i.test(main.name)?await parseFBX(main):await parseGLTF(main,list);state.meshName=main.name;computeNormals();$('modelStats').textContent=`${main.name} · ${state.mesh.f.length.toLocaleString()} tris`;if(state.mode!=='uv')setMode('uv');if(applyImportedUV(state.mesh)){updateIslandButtons();updateStatus();redraw();toast('Model and original UVs imported');}else unwrap();}catch(err){toast('Could not import model: '+err.message);}
  }

  function importTexture(file) {
    const l = activeLayer();
    if (!l) return;
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      pushUndo();
      l.canvas.getContext('2d').drawImage(im, 0, 0, TEX, TEX);
      URL.revokeObjectURL(url);
      invalidate();
      redraw();
      toast(`Imported into “${l.name}”`);
    };
    im.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that image'); };
    im.src = url;
  }
  async function importPlanetTex(file){
    try{
      const layers=JSON.parse(await file.text()), frame=$('planetTexEngine');
      if(!Array.isArray(layers)||!layers.length)throw Error('Invalid preset');
      if(!frame.contentWindow?.PlanetTex) await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PlanetTex renderer did not load')),8000);frame.addEventListener('load',()=>{clearTimeout(timer);resolve()},{once:true})});
      const url=frame.contentWindow.PlanetTex.renderPreset(layers,TEX), im=new Image();
      await new Promise((resolve,reject)=>{im.onload=resolve;im.onerror=reject;im.src=url});
      const c=mkCanvas();c.getContext('2d').drawImage(im,0,0,TEX,TEX);
      state.texturePreview=c;state.texturePreviewName=file.name.replace(/\.json$/i,'');
      $('bakePreview').disabled=false;$('previewHint').textContent=`Previewing “${state.texturePreviewName}” — no paint layer has changed.`;
      $('renderMode').value='texture';redraw();toast('PlanetTex preset preview ready');
    }catch(err){toast('Could not render PlanetTex preset: '+(err.message||'invalid JSON'));}
  }

  function downloadBlob(blob,name){const a=document.createElement('a');a.download=name;a.href=URL.createObjectURL(blob);a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);}
  function exportOBJ(){let s='# PlanetForge textured OBJ\nmtllib planetforge.mtl\no PlanetForge\n';state.mesh.v.forEach(v=>s+=`v ${v.join(' ')}\n`);const uv=[];state.mesh.f.forEach((f,fi)=>{const m=state.faceMap[fi];for(let c=0;c<3;c++){const p=m?[m.isl.x+m.isl.pts[m.k*3+c][0],m.isl.y+m.isl.pts[m.k*3+c][1]]:[0,0];uv.push(p);s+=`vt ${p[0]} ${1-p[1]}\n`;}});s+='usemtl PlanetForgeMaterial\n';state.mesh.f.forEach((f,i)=>s+=`f ${f.map((v,c)=>`${v+1}/${i*3+c+1}`).join(' ')}\n`);downloadBlob(new Blob([s],{type:'text/plain'}),'planetforge-model.obj');}
  function gltfData(){const pos=[],uv=[];state.mesh.f.forEach((f,fi)=>{const m=state.faceMap[fi];f.forEach((vi,c)=>{pos.push(...state.mesh.v[vi]);const p=m?[m.isl.x+m.isl.pts[m.k*3+c][0],m.isl.y+m.isl.pts[m.k*3+c][1]]:[0,0];uv.push(p[0],1-p[1]);});});const bin=new ArrayBuffer(pos.length*4+uv.length*4),dv=new DataView(bin);pos.forEach((v,i)=>dv.setFloat32(i*4,v,true));const off=pos.length*4;uv.forEach((v,i)=>dv.setFloat32(off+i*4,v,true));const b64=btoa(String.fromCharCode(...new Uint8Array(bin)));return {json:{asset:{version:'2.0',generator:'PlanetForge'},buffers:[{byteLength:bin.byteLength,uri:`data:application/octet-stream;base64,${b64}`}],bufferViews:[{buffer:0,byteOffset:0,byteLength:off,target:34962},{buffer:0,byteOffset:off,byteLength:uv.length*4,target:34962}],accessors:[{bufferView:0,componentType:5126,count:pos.length/3,type:'VEC3'},{bufferView:1,componentType:5126,count:uv.length/2,type:'VEC2'}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},mode:4}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0},bin};}
  function exportGLTF(){const g=gltfData();downloadBlob(new Blob([JSON.stringify(g.json)],{type:'model/gltf+json'}),'planetforge-model.gltf');}
  function exportGLB(){const g=gltfData(),j=structuredClone(g.json);delete j.buffers[0].uri;let js=new TextEncoder().encode(JSON.stringify(j)),jp=(4-js.length%4)%4,bp=(4-g.bin.byteLength%4)%4,total=12+8+js.length+jp+8+g.bin.byteLength+bp,out=new ArrayBuffer(total),dv=new DataView(out),u=new Uint8Array(out);dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);dv.setUint32(8,total,true);dv.setUint32(12,js.length+jp,true);dv.setUint32(16,0x4e4f534a,true);u.set(js,20);u.fill(32,20+js.length,20+js.length+jp);let o=20+js.length+jp;dv.setUint32(o,g.bin.byteLength+bp,true);dv.setUint32(o+4,0x004e4942,true);u.set(new Uint8Array(g.bin),o+8);downloadBlob(new Blob([out],{type:'model/gltf-binary'}),'planetforge-model.glb');}
  function exportFBX(){let s='; FBX 7.4.0 project exported by PlanetForge\nObjects: {\n Geometry: 1, "Geometry::PlanetForge", "Mesh" {\n  Vertices: *'+state.mesh.v.length*3+' { a: '+state.mesh.v.flat().join(',')+' }\n  PolygonVertexIndex: *'+state.mesh.f.length*3+' { a: '+state.mesh.f.flatMap(f=>[f[0],f[1],-f[2]-1]).join(',')+' }\n }\n}\n';downloadBlob(new Blob([s],{type:'text/plain'}),'planetforge-model.fbx');}

  /* ---------------- modes & status ---------------- */
  function updateStatus() {
    const el = $('statusText');
    if (state.mode === 'uv') {
      el.textContent = state.islands.length
        ? `${state.islands.length} islands · ${state.selected >= 0 ? 1 : 0} selected`
        : 'No UV islands yet — run the unwrap';
    } else if (state.mode === 'paint') {
      const l = activeLayer();
      el.textContent = l ? `Painting on “${l.name}”` : 'Add a layer to start painting';
    } else el.textContent = 'Drag the sphere to rotate it';
  }

  function redraw() {
    if (state.mode === 'uv') { drawModel(); drawUV(); }
    else if (state.mode === 'paint') drawPaint();
    else drawMaterial();
  }

  function setMode(m) {
    state.mode = m;
    $$('.mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== m && p.dataset.panel !== 'all'; });
    $('uvWorkspace').hidden = m !== 'uv';
    $('paintWorkspace').hidden = m !== 'paint';
    $('materialWorkspace').hidden = m !== 'material';
    $('uvTools').hidden = m !== 'uv';
    updateStatus();
    requestAnimationFrame(redraw);
  }

  /* ---------------- events ---------------- */
  $$('.mode-tab').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });

  $('importModel').onclick = () => $('modelFile').click();
  $('modelFile').onchange = e => { if(e.target.files.length)importModelFiles(e.target.files); e.target.value = ''; };
  $('unwrap').onclick = unwrap;

  $('gridToggle').onclick = () => {
    state.grid = !state.grid;
    $('gridToggle').classList.toggle('active', state.grid);
    drawUV();
  };
  $('resetView').onclick = () => { state.orbit = { x: -0.35, y: 0.65 }; state.zoom = 1; drawModel(); };

  $('rotateIsland').onclick = () => transformIsland(isl => {
    isl.pts = isl.pts.map(([u, v]) => [isl.h - v, u]);
    const t = isl.w; isl.w = isl.h; isl.h = t;
  });
  $('flipIslandH').onclick = () => transformIsland(isl => { isl.pts = isl.pts.map(([u, v]) => [isl.w - u, v]); });
  $('flipIslandV').onclick = () => transformIsland(isl => { isl.pts = isl.pts.map(([u, v]) => [u, isl.h - v]); });

  // 3D viewport: orbit + zoom
  const mc = $('modelCanvas');
  mc.onpointerdown = e => { state.drag = { kind: 'orbit', x: e.clientX, y: e.clientY }; mc.setPointerCapture(e.pointerId); };
  mc.onpointermove = e => {
    if (state.drag?.kind !== 'orbit') return;
    state.orbit.y += (e.clientX - state.drag.x) * 0.01;
    state.orbit.x = Math.max(-1.55, Math.min(1.55, state.orbit.x + (e.clientY - state.drag.y) * 0.01));
    state.drag.x = e.clientX;
    state.drag.y = e.clientY;
    drawModel();
  };
  mc.onpointerup = mc.onpointercancel = () => { state.drag = null; };
  mc.addEventListener('wheel', e => {
    e.preventDefault();
    state.zoom = Math.min(3, Math.max(0.4, state.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    drawModel();
  }, { passive: false });

  // UV canvas: select + drag islands
  const uc = $('uvCanvas');
  function uvPos(e) {
    const r = uc.getBoundingClientRect();
    return [
      ((e.clientX - r.left) * uvView.d - uvView.ox) / uvView.size,
      ((e.clientY - r.top) * uvView.d - uvView.oy) / uvView.size,
    ];
  }
  uc.onpointerdown = e => {
    if (!uvView) return;
    const [x, y] = uvPos(e);
    let hit = -1;
    for (let i = state.islands.length - 1; i >= 0; i--) {
      const it = state.islands[i];
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) { hit = i; break; }
    }
    state.selected = hit;
    if (hit >= 0) {
      const it = state.islands[hit];
      state.drag = { kind: 'island', x, y, ix: it.x, iy: it.y };
      uc.setPointerCapture(e.pointerId);
    }
    updateIslandButtons();
    updateStatus();
    drawUV();
  };
  uc.onpointermove = e => {
    if (state.drag?.kind !== 'island') return;
    const [x, y] = uvPos(e), it = state.islands[state.selected];
    it.x = Math.max(0, Math.min(1 - it.w, state.drag.ix + x - state.drag.x));
    it.y = Math.max(0, Math.min(1 - it.h, state.drag.iy + y - state.drag.y));
    drawUV();
  };
  uc.onpointerup = uc.onpointercancel = () => {
    if (state.drag?.kind === 'island') { state.geometryVersion++; state.drag = null; drawModel(); }
  };

  // paint tools
  $$('.ptool').forEach(b => {
    b.onclick = () => {
      state.tool = b.dataset.tool;
      $$('.ptool').forEach(x => x.classList.toggle('active', x === b));
    };
  });

  const pc = $('paintCanvas');
  pc.onpointerdown = e => {
    const [x, y] = paintPos(e);
    if (state.tool === 'pick') return pickAt(x, y);
    if (state.tool === 'fill') return fillAt(x, y);
    const l = activeLayer();
    if (!l) return;
    if (!l.visible) return toast('This layer is hidden');
    pushUndo();
    state.painting = true;
    state.lastPt = null;
    strokeCtx.clearRect(0, 0, TEX, TEX);
    strokeTo(x, y);
    pc.setPointerCapture(e.pointerId);
    drawPaint();
  };
  pc.onpointermove = e => {
    if (!state.painting) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) { const [x, y] = paintPos(ev); strokeTo(x, y); }
    drawPaint();
  };
  pc.onpointerup = pc.onpointercancel = () => {
    if (!state.painting) return;
    state.painting = false;
    commitStroke();
    drawPaint();
  };

  $('undoStroke').onclick = undoPaint;
  $('addLayer').onclick = () => { addLayer(`Paint layer ${state.layers.length + 1}`); drawPaint(); updateStatus(); };
  $('importTexture').onclick = () => $('textureFile').click();
  $('textureFile').onchange = e => { const f=e.target.files[0]; if(f)(/\.json$/i.test(f.name)?importPlanetTex(f):importTexture(f)); e.target.value = ''; };
  $('wireToggle').onchange = drawPaint;
  $('bakePreview').onclick=()=>{
    if(!state.texturePreview)return;
    addLayer(state.texturePreviewName||'PlanetTex bake','baseColor');
    activeLayer().canvas.getContext('2d').drawImage(state.texturePreview,0,0);
    state.texturePreview=null;state.texturePreviewName='';$('bakePreview').disabled=true;
    $('previewHint').textContent='PlanetTex presets remain a preview until you bake them.';
    invalidate();renderLayers();drawPaint();toast('Preview baked to a new texture layer');
  };
  $('renderMode').onchange=redraw;
  $('paintChannel').onchange = () => {
    const ch=$('paintChannel').value, hit=state.layers.findIndex(l=>(l.channel||'baseColor')===ch);
    if(hit<0) addLayer(ch[0].toUpperCase()+ch.slice(1),ch); else state.active=hit;
    state.paintingMask=false; $('paintLabel').textContent=`${$('paintChannel').selectedOptions[0].text} · ${TEX}²`;
    renderLayers(); drawPaint();
  };
  $('textureResolution').onchange=()=>setTextureResolution($('textureResolution').value,true);
  $('addMask').onclick=()=>{ const l=activeLayer(); if(!l)return; if(!l.mask){l.mask=mkCanvas();l.mask.getContext('2d').fillStyle='#fff';l.mask.getContext('2d').fillRect(0,0,TEX,TEX);} state.paintingMask=!state.paintingMask; renderLayers(); toast(state.paintingMask?'Painting layer mask':'Painting texture'); };
  $('clearMask').onclick=()=>{const l=activeLayer();if(l?.mask){l.mask=null;state.paintingMask=false;invalidate();renderLayers();drawPaint();}};

  const builtInBrushes={round:{size:42,hard:72},soft:{size:90,hard:12},rust:{size:74,hard:48},grunge:{size:110,hard:22},speckle:{size:54,hard:80},splatter:{size:120,hard:76},spray:{size:95,hard:30},dirt:{size:135,hard:18},scratches:{size:105,hard:92},cracks:{size:125,hard:96},stars:{size:90,hard:88}};
  function loadBrushes(){let custom={};try{custom=JSON.parse(localStorage.getItem('planetforge-brushes')||'{}')}catch{} const sel=$('brushPreset'),grid=$('brushPresets'),current=sel.value||'round';sel.innerHTML='';grid.innerHTML='';Object.keys({...builtInBrushes,...custom}).forEach(n=>{const o=document.createElement('option');o.value=o.textContent=n;sel.append(o);const b=document.createElement('button');b.type='button';b.className='brush-preset';b.dataset.shape=n;b.title=n;b.innerHTML=`<i></i><span>${n}</span>`;b.onclick=()=>{sel.value=n;sel.onchange();refreshBrushTiles()};grid.append(b)});sel._custom=custom;sel.value=[...sel.options].some(o=>o.value===current)?current:'round';refreshBrushTiles();}
  function refreshBrushTiles(){$$('#brushPresets .brush-preset').forEach(b=>b.classList.toggle('active',b.dataset.shape===$('brushPreset').value));}
  $('brushPreset').onchange=()=>{const p=builtInBrushes[$('brushPreset').value]||$('brushPreset')._custom[$('brushPreset').value];if(p){setSlider('brushSize','brushSizeOut',p.size,' px');setSlider('hardness','hardnessOut',p.hard,'%');}};
  $('saveBrush').onclick=()=>{const n=prompt('Brush preset name');if(!n)return;const c=$('brushPreset')._custom;c[n]={size:+$('brushSize').value,hard:+$('hardness').value};localStorage.setItem('planetforge-brushes',JSON.stringify(c));loadBrushes();$('brushPreset').value=n;toast('Brush saved locally');};
  $('deleteBrush').onclick=()=>{const n=$('brushPreset').value,c=$('brushPreset')._custom;if(!c[n])return toast('Built-in presets cannot be deleted');delete c[n];localStorage.setItem('planetforge-brushes',JSON.stringify(c));loadBrushes();};
  loadBrushes();

  function loadMaterials(){try{customMaterials=JSON.parse(localStorage.getItem('planetforge-materials')||'{}')}catch{customMaterials={}}const s=$('materialPreset'),cur=s.value||'iron';s.innerHTML='';Object.keys({...BUILTIN_MATERIALS,...customMaterials}).forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n.replace(/([A-Z])/g,' $1');s.append(o)});s.value=[...s.options].some(o=>o.value===cur)?cur:'iron';updateMaterialPreset();}
  function updateMaterialPreset(){const m=BUILTIN_MATERIALS[$('materialPreset').value]||customMaterials[$('materialPreset').value];if(!m)return;$('materialSwatch').style.background=`linear-gradient(135deg,${m.color},color-mix(in srgb,${m.color} 55%,white))`;$('brushColor').value=m.color;setSlider('roughness','roughOut',Math.round(m.roughness*100),'%');setSlider('metallic','metalOut',Math.round(m.metallic*100),'%');}
  $('materialPreset').onchange=updateMaterialPreset;
  $('saveMaterialPreset').onclick=()=>{const n=prompt('Custom material name');if(!n)return;customMaterials[n]={color:$('brushColor').value,roughness:+$('roughness').value/100,metallic:+$('metallic').value/100,height:.5};localStorage.setItem('planetforge-materials',JSON.stringify(customMaterials));loadMaterials();$('materialPreset').value=n;updateMaterialPreset();toast('Material preset saved locally');};
  $('deleteMaterialPreset').onclick=()=>{const n=$('materialPreset').value;if(!customMaterials[n])return toast('Built-in materials cannot be deleted');delete customMaterials[n];localStorage.setItem('planetforge-materials',JSON.stringify(customMaterials));loadMaterials();};
  loadMaterials();

  const pmc=$('paintModelCanvas');
  function modelPaintPos(e){
    if(state.gpu?.paint){const uv=state.gpu.paint.pickUV(e.clientX,e.clientY);return uv?{x:uv.u*TEX,y:uv.v*TEX,z:0}:null;}
    const r=pmc.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*pmc.width,y=(e.clientY-r.top)/r.height*pmc.height;let hit=null;
    state.mesh.f.forEach((face,fi)=>{const m=state.faceMap[fi];if(!m)return;const p=face.map(vi=>project(state.mesh.v[vi],pmc.width,pmc.height)),den=(p[1][1]-p[2][1])*(p[0][0]-p[2][0])+(p[2][0]-p[1][0])*(p[0][1]-p[2][1]);if(Math.abs(den)<1e-8)return;const a=((p[1][1]-p[2][1])*(x-p[2][0])+(p[2][0]-p[1][0])*(y-p[2][1]))/den,b=((p[2][1]-p[0][1])*(x-p[2][0])+(p[0][0]-p[2][0])*(y-p[2][1]))/den,c=1-a-b;if(a<-.001||b<-.001||c<-.001)return;const z=a*p[0][2]+b*p[1][2]+c*p[2][2];if(hit&&z>=hit.z)return;const q=m.isl.pts.slice(m.k*3,m.k*3+3),u=m.isl.x+a*q[0][0]+b*q[1][0]+c*q[2][0],v=m.isl.y+a*q[0][1]+b*q[1][1]+c*q[2][1];hit={x:u*TEX,y:v*TEX,z};});return hit;
  }
  function modelStrokePoint(e){const p=modelPaintPos(e);if(!p)return;const last=state.lastPt;if(last&&Math.hypot(p.x-last[0],p.y-last[1])>+$('brushSize').value*4)state.lastPt=null;strokeTo(p.x,p.y);drawPaint();}
  pmc.onpointerdown=e=>{
    if($('paintOnModel').checked&&!e.altKey){const p=modelPaintPos(e);if(!p)return;if(state.tool==='pick')return pickAt(p.x,p.y);if(state.tool==='fill')return fillAt(p.x,p.y);const l=activeLayer();if(!l||!l.visible)return toast('Select a visible layer first');pushUndo();state.painting=true;state.lastPt=null;strokeCtx.clearRect(0,0,TEX,TEX);state.drag={kind:'modelPaint'};modelStrokePoint(e);}
    else state.drag={kind:'paintOrbit',x:e.clientX,y:e.clientY};pmc.setPointerCapture(e.pointerId);
  };
  pmc.onpointermove=e=>{if(state.drag?.kind==='modelPaint')return modelStrokePoint(e);if(state.drag?.kind!=='paintOrbit')return;state.orbit.y+=(e.clientX-state.drag.x)*.01;state.orbit.x=Math.max(-1.55,Math.min(1.55,state.orbit.x+(e.clientY-state.drag.y)*.01));state.drag.x=e.clientX;state.drag.y=e.clientY;drawModel(pmc)};
  pmc.onpointerup=pmc.onpointercancel=()=>{if(state.drag?.kind==='modelPaint'){state.painting=false;commitStroke();drawPaint();}state.drag=null};
  pmc.addEventListener('wheel',e=>{e.preventDefault();state.zoom=Math.min(3,Math.max(.4,state.zoom*(e.deltaY<0?1.1:.9)));drawModel(pmc)},{passive:false});

  // material
  const matc = $('materialCanvas');
  matc.onpointerdown = e => { state.drag = { kind: 'sphere', x: e.clientX }; matc.setPointerCapture(e.pointerId); };
  matc.onpointermove = e => {
    if (state.drag?.kind !== 'sphere') return;
    state.sphereRot = (state.sphereRot + (e.clientX - state.drag.x) / 400) % 1;
    state.drag.x = e.clientX;
    requestMaterial();
  };
  matc.onpointerup = matc.onpointercancel = () => { state.drag = null; };

  $('environment').onchange = () => {
    $('materialWorkspace').dataset.env = $('environment').value;
    if (state.mode === 'material') requestMaterial();
  };
  $('resetMaterial').onclick = () => {
    setSlider('roughness', 'roughOut', 46, '%');
    setSlider('metallic', 'metalOut', 4, '%');
    setSlider('bump', 'bumpOut', 38, '%');
    setSlider('light', 'lightOut', 315, '°');
    $('environment').value = 'studio';
    $('materialWorkspace').dataset.env = 'studio';
    requestMaterial();
  };

  // slider readouts
  [
    ['seamAngle', 'angleOut', '°'], ['padding', 'paddingOut', ' px'],
    ['brushSize', 'brushSizeOut', ' px'], ['brushOpacity', 'opacityOut', '%'], ['hardness', 'hardnessOut', '%'],
    ['roughness', 'roughOut', '%'], ['metallic', 'metalOut', '%'], ['bump', 'bumpOut', '%'], ['light', 'lightOut', '°'],
  ].forEach(([id, out, suffix]) => {
    $(id).addEventListener('input', () => {
      $(out).value = $(id).value + suffix;
      if (state.mode === 'material' && ['roughness', 'metallic', 'bump', 'light'].includes(id)) requestMaterial();
    });
  });

  // project
  const autosaveDB=new Promise((resolve,reject)=>{const q=indexedDB.open('PlanetForge',1);q.onupgradeneeded=()=>q.result.createObjectStore('projects');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
  async function autosave(){if(!state.dirty)return;try{const db=await autosaveDB,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(JSON.stringify(projectData()),'autosave');await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});state.dirty=false;$('autosaveStatus').textContent=`Auto-saved locally at ${new Date().toLocaleTimeString()}`;}catch(err){$('autosaveStatus').textContent='Auto-save unavailable: '+err.message;}}
  async function restoreAutosave(){try{const db=await autosaveDB,tx=db.transaction('projects'),q=tx.objectStore('projects').get('autosave'),raw=await new Promise((res,rej)=>{q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});if(raw&&confirm('Restore your locally auto-saved PlanetForge project?'))await loadProject(new Blob([raw],{type:'application/json'}));}catch(err){console.warn('Autosave restore unavailable',err);}}
  async function clearAutosave(){try{const db=await autosaveDB;db.transaction('projects','readwrite').objectStore('projects').delete('autosave')}catch{}}
  setInterval(()=>window.requestIdleCallback?requestIdleCallback(autosave,{timeout:2000}):autosave(),8000);
  $('saveProject').onclick = saveProject;
  $('newProject').onclick=()=>{if(!confirm('Start a new project? All unsaved work will be discarded.'))return;clearAutosave();state.mesh=demoMesh();state.meshName='Demo cube';computeNormals();state.layers=[];state.active=0;state.undo=[];state.texturePreview=null;addLayer('Base color');state.geometryVersion++;$('modelStats').textContent='Demo cube · 12 tris';setMode('uv');unwrap();state.dirty=false;toast('New project created');};
  $('loadProject').onclick = () => $('projectFile').click();
  $('projectFile').onchange = e => { if (e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ''; };
  $('exportTexture').onclick = () => {
    const a = document.createElement('a');
    a.download = 'planetforge-basecolor.png';
    a.href = getComposite(false).canvas.toDataURL('image/png');
    a.click();
    toast('Texture exported');
  };
  $('exportModel').onclick=()=>({obj:exportOBJ,gltf:exportGLTF,glb:exportGLB,fbx:exportFBX}[$('exportFormat').value]());

  // drop OBJ / image / project anywhere on the app
  const appEl = document.querySelector('.app');
  appEl.addEventListener('dragover', e => e.preventDefault());
  appEl.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (/\.(obj|gltf|glb|fbx)$/i.test(file.name)) importModelFiles(e.dataTransfer.files);
    else if (/\.json$/i.test(file.name)) loadProject(file);
    else if (/^image\//.test(file.type)) importTexture(file);
    else toast('Drop an OBJ, a PNG/JPG texture, or a project JSON');
  });

  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.mode === 'paint') {
      e.preventDefault();
      undoPaint();
    }
  });

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(redraw);
  });

  /* ---------------- boot ---------------- */
  state.mesh = demoMesh();
  state.meshName = 'Demo cube';
  computeNormals();
  $('modelStats').textContent = 'Demo cube · 12 tris';

  addLayer('Base color');
  const bctx = activeLayer().canvas.getContext('2d');
  const grad = bctx.createLinearGradient(0, 0, TEX, TEX);
  grad.addColorStop(0, '#8f5c3f');
  grad.addColorStop(1, '#d29a68');
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, TEX, TEX);
  for (let i = 0; i < 180; i++) {
    bctx.fillStyle = `rgba(45,25,15,${(Math.random() * 0.12).toFixed(3)})`;
    bctx.beginPath();
    bctx.arc(Math.random() * TEX, Math.random() * TEX, Math.random() * 28, 0, Math.PI * 2);
    bctx.fill();
  }
  invalidate();

  unwrap();
  setMode('uv');
  import(new URL('./gpu-viewport.js',document.baseURI).href).then(({GPUViewport,GPUMaterialViewport})=>{
    state.gpu={model:new GPUViewport($('modelCanvas')),paint:new GPUViewport($('paintModelCanvas')),material:new GPUMaterialViewport($('materialCanvas'))};
    redraw();toast('High-performance GPU viewport enabled');
  }).catch(err=>{console.warn('PlanetForge GPU viewport unavailable; using software fallback.',err);const webgl=/webgl|context/i.test(err?.message||'');toast(webgl?'WebGL context unavailable — using compatibility renderer':`GPU module error: ${err?.message||'unknown error'}`);});
  setTimeout(restoreAutosave,500);
})();
