'use strict';
const $ = id => document.getElementById(id);

/* ---------- param helpers ---------- */
const SC = (v, max = 40) => ({ k: 'scale', n: 'Scale', min: 1, max, step: 1, v });
const DET = v => ({ k: 'detail', n: 'Detail (octaves)', min: 1, max: 8, step: 1, v });
const DIS = (v, max = 3) => ({ k: 'distort', n: 'Distortion', min: 0, max, step: 0.05, v });
const CON = v => ({ k: 'contrast', n: 'Contrast', min: 0.2, max: 4, step: 0.05, v });
const F = (k, n, min, max, step, v) => ({ k, n, min, max, step, v });
const C = (k, v, n) => ({ k, n: n || (k === 'c1' ? 'Color A' : 'Color B'), type: 'color', v });

/* ---------- generators: params + GLSL body defining vec3 render(vec2 uv) ---------- */
const GENS = [
  { name: 'Noise (FBM)', p: [SC(8), DET(5), CON(1.0), C('c1', '#0b0e14'), C('c2', '#e8edf5')], glsl: `
vec3 render(vec2 uv){float n=fbm(uv*u_scale,vec2(u_scale),u_detail);n=pow(n,u_contrast);return mix(u_c1,u_c2,n);}` },

  { name: 'Clouds', p: [SC(5, 20), DET(6), DIS(1.2), C('c1', '#1a3a6b'), C('c2', '#ffffff')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float q=fbm(p+vec2(13.7,9.2),per,u_detail);
float n=fbm(p+u_distort*2.*vec2(q,q*.7),per,u_detail);
n=smoothstep(.3,.8,n);return mix(u_c1,u_c2,n);}` },

  { name: 'Smoke', p: [SC(4, 20), DET(6), DIS(1.5), C('c1', '#05060a'), C('c2', '#b9c2cf')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float q1=fbm(p*2.+7.3,per*2.,u_detail),q2=fbm(p+3.3,per,u_detail);
float w=fbm(p+u_distort*3.*(vec2(q1,q2)-.5),per,u_detail);
w=pow(w,1.8);return mix(u_c1,u_c2,w);}` },

  { name: 'Dust & Scratches', p: [SC(6, 20), F('amount', 'Dust amount', 0, 1, 0.02, 0.5), F('grain', 'Grain', 0, 2, 0.05, 0.6), F('scratch', 'Scratches', 0, 1, 0.02, 0.4), C('c1', '#000000'), C('c2', '#ffffff')], glsl: `
vec3 render(vec2 uv){float S=u_scale;
float base=fbm(uv*S,vec2(S),4.)*.2;
float sp=pow(vnoise(uv*S*8.,vec2(S*8.)),26.-u_amount*22.);
vec2 sv=vec2(S,S*24.);
float sc=pow(vnoise(uv*sv,sv),30.-u_amount*20.);
float v=clamp(base*u_grain+min(sp*3.,1.)+min(sc*3.,1.)*u_scratch,0.,1.);
return mix(u_c1,u_c2,v);}` },

  { name: 'Cells (Voronoi)', p: [SC(10), CON(1.0), C('c1', '#101418'), C('c2', '#59d1ff')], glsl: `
vec3 render(vec2 uv){float d=voro2(uv*u_scale,vec2(u_scale)).x;
float v=pow(clamp(d,0.,1.),u_contrast);return mix(u_c2,u_c1,v);}` },

  { name: 'Marble', p: [SC(4, 16), DET(6), F('bands', 'Bands', 1, 12, 1, 4), DIS(1, 2), C('c1', '#e9e4dc'), C('c2', '#3b3630')], glsl: `
vec3 render(vec2 uv){vec2 per=vec2(u_scale);
float n=fbm(uv*u_scale,per,u_detail);
float v=.5+.5*sin((uv.x+uv.y)*6.28318*u_bands+n*u_distort*8.);
v=pow(v,1.5);return mix(u_c1,u_c2,v);}` },

  { name: 'Wood Rings', p: [SC(4, 12), DET(5), F('rings', 'Ring count', 2, 14, 1, 6), DIS(0.6, 2), C('c1', '#a9744a'), C('c2', '#4a2c14')], glsl: `
vec3 render(vec2 uv){vec2 p=(uv-.5)*u_scale;
float n=fbm(uv*u_scale,vec2(u_scale),u_detail);
float r=length(p*vec2(1.,2.6))+n*u_distort;
float v=fract(r*u_rings*.25);v=smoothstep(0.,.35,v)*smoothstep(1.,.55,v);
vec2 gv=vec2(u_scale,u_scale*12.);
float g=vnoise(uv*gv,gv)*.25;
return mix(u_c2,u_c1,clamp(v+g,0.,1.));}` },

  { name: 'Bricks', p: [SC(6, 16), F('mortar', 'Mortar width', 0.02, 0.4, 0.01, 0.1), F('vary', 'Color variation', 0, 1, 0.05, 0.5), C('c1', '#a64a33'), C('c2', '#c9c2b6', 'Mortar color')], glsl: `
vec3 render(vec2 uv){float S=u_scale;
vec2 p=uv*vec2(S,S*2.);
p.x+=step(1.,mod(p.y,2.))*.5;
vec2 id=floor(p),f=fract(p);
float m=u_mortar;
float b=smoothstep(m*.5,m*.5+.04,f.x)*smoothstep(1.-m*.5,1.-m*.5-.04,f.x)
       *smoothstep(m,m+.08,f.y)*smoothstep(1.-m,1.-m-.08,f.y);
float v=hash(W(id,vec2(S,S*2.)))*u_vary+fbm(uv*S*6.,vec2(S*6.),3.)*.25;
vec3 brick=mix(u_c1,u_c1*.55,clamp(v,0.,1.));
return mix(u_c2,brick,b);}` },

  { name: 'Grid / Checker', p: [SC(8, 40), F('line', 'Line width', 0, 0.3, 0.01, 0.06), F('checker', 'Checker mix', 0, 1, 0.05, 0.3), C('c1', '#14181f'), C('c2', '#54e0c0', 'Line color')], glsl: `
vec3 render(vec2 uv){float S=u_scale;vec2 p=uv*S,f=fract(p);
float ck=mod(floor(p.x)+floor(p.y),2.);
float lw=u_line*.5;
float g=max(max(step(f.x,lw),step(1.-lw,f.x)),max(step(f.y,lw),step(1.-lw,f.y)));
vec3 c=mix(u_c1,mix(u_c1,u_c2,.4),ck*u_checker);
return mix(c,u_c2,g*step(.001,u_line));}` },

  { name: 'Stripes / Fabric', p: [SC(6, 20), DET(4), F('freq', 'Stripe count', 1, 40, 1, 10), F('angle', 'Angle (0/45/90)', 0, 2, 1, 0), DIS(0.5, 2), C('c1', '#22262e'), C('c2', '#cfd6e2')], glsl: `
vec3 render(vec2 uv){vec2 per=vec2(u_scale);
float n=fbm(uv*u_scale,per,u_detail);
vec2 d=u_angle<.5?vec2(1.,0.):(u_angle<1.5?vec2(1.,1.):vec2(0.,1.));
float v=.5+.5*sin((uv.x*d.x+uv.y*d.y)*6.28318*u_freq+n*u_distort*6.);
float weave=vnoise(uv*u_scale*10.,vec2(u_scale*10.))*.15;
return mix(u_c1,u_c2,pow(clamp(v+weave,0.,1.),1.2));}` },

  { name: 'Camo / Posterize', p: [SC(5, 16), DET(5), F('steps', 'Color steps', 2, 8, 1, 4), C('c1', '#2f3b1f'), C('c2', '#b8b09a')], glsl: `
vec3 render(vec2 uv){vec2 per=vec2(u_scale);
float n=fbm(uv*u_scale,per,u_detail);
n=floor(n*u_steps)/max(u_steps-1.,1.);
return mix(u_c1,u_c2,clamp(n,0.,1.));}` },

  { name: 'Rust / Grunge', p: [SC(5, 16), DET(6), F('cover', 'Coverage', 0, 1, 0.02, 0.5), C('c1', '#5c6670', 'Metal color'), C('c2', '#8a3d1a', 'Rust color')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float a=fbm(p,per,u_detail);
float b=fbm(p*3.+7.,per*3.,u_detail);
float blotch=smoothstep(1.-u_cover,1.15-u_cover,a+b*.4);
float speck=pow(vnoise(p*10.,per*10.),8.);
vec3 c=mix(u_c1,u_c2,blotch);
c=mix(c,u_c2*.55,speck*blotch);
return clamp(c+b*.12-.06,0.,1.);}` },

  { name: 'Halftone Dots', p: [SC(4, 12), F('dots', 'Dot grid', 10, 80, 1, 30), F('size', 'Dot size', 0.05, 0.7, 0.01, 0.45), C('c1', '#f2ede4'), C('c2', '#1c1a18', 'Ink color')], glsl: `
vec3 render(vec2 uv){float D=u_dots;
vec2 p=uv*D;vec2 id=floor(p),f=fract(p)-.5;
float t=fbm((id+.5)/D*u_scale,vec2(u_scale),3.);
float r=t*u_size;
float d=smoothstep(r,r-.1,length(f));
return mix(u_c1,u_c2,d);}` },

  { name: 'Fire (VFX)', p: [SC(6, 20), DET(5), DIS(0.9, 2), F('height', 'Flame height', 1, 2.5, 0.05, 1.5), C('c1', '#ff4400', 'Base color'), C('c2', '#ffc21a', 'Tip color')], glsl: `
vec3 render(vec2 uv){vec2 per=vec2(u_scale);
float n=fbm(vec2(uv.x*u_scale,(1.-uv.y)*u_scale*1.5),per,u_detail);
float f=clamp((1.-uv.y)*u_height-n*u_distort,0.,1.);
vec3 c=mix(vec3(0.),u_c1,smoothstep(0.,.45,f));
c=mix(c,u_c2,smoothstep(.35,.8,f));
return mix(c,vec3(1.,.98,.9),smoothstep(.82,1.,f));}` },

  { name: 'Lava Cracks (VFX)', p: [SC(5, 16), DET(6), F('sharp', 'Crack sharpness', 0, 2, 0.05, 1), C('c1', '#1a1210', 'Crust color'), C('c2', '#ff5a00', 'Glow color')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float r=ridge(p,per,u_detail);
float crack=pow(r,u_sharp*5.+2.);
float crust=fbm(p*2.+5.,per*2.,4.);
vec3 c=mix(u_c1,u_c1*.4,crust);
c=mix(c,u_c2,clamp(crack*1.6,0.,1.));
c+=vec3(1.,.9,.5)*pow(crack,3.)*.8;
return clamp(c,0.,1.);}` },

  { name: 'Magic Aura (VFX)', p: [SC(6, 20), DET(5), DIS(0.5, 1.5), F('radius', 'Ring radius', 0.2, 0.9, 0.02, 0.55), F('width', 'Ring width', 0, 1, 0.02, 0.35), C('c1', '#3a0ca3', 'Inner color'), C('c2', '#9d4dff', 'Energy color')], glsl: `
vec3 render(vec2 uv){vec2 d=uv-.5;float r=length(d)*2.;float an=atan(d.y,d.x);
vec2 cp=vec2(cos(an),sin(an))*u_scale*.5;
float n=fbm(cp+vec2(r*u_scale,0.),vec2(1e5),u_detail);
float ring=1.-smoothstep(0.,.15+u_width*.35,abs(r-u_radius+(n-.5)*u_distort));
float glow=exp(-abs(r-u_radius)*4.)*.7;
float core=exp(-r*6.)*.5;
float v=clamp(ring*(.35+n*1.1)+glow*n+core,0.,1.);
vec3 col=mix(u_c1,u_c2,clamp(n*1.7-.25,0.,1.));
col=mix(col,vec3(1.),pow(v,4.)*.6);
return col*v;}` },

  { name: 'Energy / Plasma (VFX)', p: [SC(5, 20), DET(6), DIS(1.2), F('sharp', 'Filament sharpness', 0, 2, 0.05, 1), C('c1', '#0b2a66', 'Base color'), C('c2', '#66e0ff', 'Bolt color')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float q=fbm(p+4.7,per,u_detail);
float r=ridge(p+u_distort*2.*vec2(q,q*.9),per,u_detail);
float v=pow(r,u_sharp*4.+1.);
vec3 c=u_c1*v*1.2+u_c2*pow(v,3.)*1.6+vec3(1.)*pow(v,9.)*.8;
return clamp(c,0.,1.);}` },

  { name: 'Lightning Bolt (VFX)', p: [SC(4, 16), DET(5), DIS(0.35, 1), F('width', 'Bolt width', 0, 1, 0.02, 0.4), C('c1', '#1b2a5e', 'Glow color'), C('c2', '#aee8ff', 'Bolt color')], glsl: `
vec3 render(vec2 uv){vec2 per=vec2(1e5);
float n=fbm(vec2(uv.y*u_scale,3.3),per,u_detail)-.5;
float x=uv.x-.5+n*u_distort;
float d=abs(x);
float bolt=exp(-d*(70.-u_width*50.));
float glow=exp(-d*7.);
float branch=fbm(uv*u_scale*2.+9.,per,u_detail);
vec3 c=u_c1*glow*1.6*branch+u_c2*bolt+vec3(1.)*pow(bolt,4.)*.6;
return clamp(c,0.,1.);}` },

  { name: 'Caustics / Water (VFX)', p: [SC(6, 20), DIS(0.8, 2), F('width', 'Edge width', 0.02, 0.5, 0.01, 0.15), C('c1', '#06304e', 'Water color'), C('c2', '#aef4ff', 'Light color')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float w=fbm(p+7.,per,3.)*u_distort;
vec2 v=voro2(p+w,per);
float e=1.-smoothstep(0.,u_width,v.y-v.x);
float b=voro2(p*2.+w+3.,per*2.).x;
vec3 c=mix(u_c1,u_c2,pow(e,1.5));
return clamp(c+u_c2*(1.-b)*.15,0.,1.);}` },

  { name: 'Nebula / Stars', p: [SC(4, 16), DET(6), F('stars', 'Star density', 0, 1, 0.02, 0.4), C('c1', '#12175e', 'Nebula A'), C('c2', '#a13a75', 'Nebula B')], glsl: `
vec3 render(vec2 uv){vec2 p=uv*u_scale;vec2 per=vec2(u_scale);
float a=fbm(p,per,u_detail),b=fbm(p*2.+11.,per*2.,u_detail),g=fbm(p*4.+23.,per*4.,4.);
vec3 c=u_c1*pow(a,1.4)*1.5+u_c2*pow(b,2.)*1.3+vec3(.85,.6,1.)*pow(g,3.)*.5;
vec2 sg=uv*160.;vec2 si=W(floor(sg),vec2(160.)),sf=fract(sg);
vec2 sc=hash2(si+7.7);
float on=step(1.-u_stars*.08,hash(si+2.3));
float st=on*pow(max(0.,1.-length(sf-sc)*2.),5.)*1.3;
c+=vec3(st);
return clamp(c,0.,1.);}` },
];

/* ---------- GLSL library shared by all generators ---------- */
const LIB = `precision highp float;
varying vec2 vUv;
uniform float u_seed,u_tile,u_offx,u_offy,u_invert;
vec2 W(vec2 i,vec2 per){return u_tile>.5?mod(i,per):i;}
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031+fract(u_seed*.1031));q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec2 hash2(vec2 p){float h=hash(p);return vec2(h,hash(p+h+17.17));}
float vnoise(vec2 p,vec2 per){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
float a=hash(W(i,per)),b=hash(W(i+vec2(1,0),per)),c=hash(W(i+vec2(0,1),per)),d=hash(W(i+vec2(1,1),per));
return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float fbm(vec2 p,vec2 per,float oct){float v=0.,a=.5,t=0.;
for(int i=0;i<8;i++){if(float(i)>=oct)break;v+=a*vnoise(p,per);t+=a;p*=2.;per*=2.;a*=.5;}
return t>0.?v/t:0.;}
float ridge(vec2 p,vec2 per,float oct){float v=0.,a=.5,t=0.;
for(int i=0;i<8;i++){if(float(i)>=oct)break;v+=a*(1.-abs(vnoise(p,per)*2.-1.));t+=a;p*=2.;per*=2.;a*=.5;}
return t>0.?v/t:0.;}
vec2 voro2(vec2 p,vec2 per){vec2 i=floor(p),f=fract(p);float d1=8.,d2=8.;
for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 o=vec2(float(x),float(y));
vec2 c=hash2(W(i+o,per));float d=length(o+c-f);
if(d<d1){d2=d1;d1=d;}else if(d<d2){d2=d;}}
return vec2(d1,d2);}
`;
const MAIN = `
void main(){
vec2 uv=fract(vUv+vec2(u_offx,u_offy));
vec3 c=render(uv);
if(u_invert>.5)c=1.-c;
gl_FragColor=vec4(c,1.);}`;

/* ---------- WebGL setup (offscreen render target) ---------- */
const glCanvas = $('gl');
const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
const out = $('out'), octx = out.getContext('2d');
if (!gl) { $('canvas-wrap').innerHTML = '<p style="color:#f66;padding:1rem">WebGL is not available in this browser.</p>'; }
const VS = 'attribute vec2 a;varying vec2 vUv;void main(){vUv=a*.5+.5;gl_Position=vec4(a,0.,1.);}';
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

function shader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
const progCache = {};
function program(gi) {
  if (progCache[gi]) return progCache[gi];
  const g = GENS[gi];
  const decls = g.p.map(p => `uniform ${p.type === 'color' ? 'vec3' : 'float'} u_${p.k};`).join('\n');
  const fs = LIB + decls + g.glsl + MAIN;
  const pr = gl.createProgram();
  gl.attachShader(pr, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  progCache[gi] = pr; return pr;
}

/* ---------- layers state ---------- */
const BLENDS = { normal: 'source-over', add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', 'soft light': 'soft-light', difference: 'difference' };
const defaults = gi => Object.fromEntries(GENS[gi].p.map(p => [p.k, p.v]));
const newLayer = (gi, blend) => ({ gi, seed: Math.round(Math.random() * 9999) / 100, blend: blend || 'normal', opacity: 1, offx: 0, offy: 0, invert: false, v: defaults(gi) });
const state = { layers: [newLayer(0)], sel: 0 };
state.layers[0].seed = 42.42;
const L = () => state.layers[state.sel];
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

function renderLayer(layer, size) {
  glCanvas.width = glCanvas.height = size;
  gl.viewport(0, 0, size, size);
  const pr = program(layer.gi);
  gl.useProgram(pr);
  const loc = gl.getAttribLocation(pr, 'a');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u1 = (n, v) => gl.uniform1f(gl.getUniformLocation(pr, n), v);
  u1('u_seed', layer.seed);
  u1('u_tile', $('tile-chk').checked ? 1 : 0);
  u1('u_offx', layer.offx); u1('u_offy', layer.offy);
  u1('u_invert', layer.invert ? 1 : 0);
  for (const p of GENS[layer.gi].p) {
    const u = gl.getUniformLocation(pr, 'u_' + p.k);
    if (p.type === 'color') gl.uniform3fv(u, hex2rgb(layer.v[p.k]));
    else gl.uniform1f(u, layer.v[p.k]);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function composite(size) {
  out.width = out.height = size;
  octx.globalCompositeOperation = 'source-over';
  octx.globalAlpha = 1;
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, size, size);
  for (const layer of state.layers) {
    renderLayer(layer, size);
    octx.globalAlpha = layer.opacity;
    octx.globalCompositeOperation = BLENDS[layer.blend] || 'source-over';
    octx.drawImage(glCanvas, 0, 0, size, size);
  }
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = 'source-over';
}

/* ---------- normal map (Sobel on luminance, wrap-around edges) ---------- */
function normalFrom(srcCanvas, strength) {
  const s = srcCanvas.width;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);
  const src = ctx.getImageData(0, 0, s, s), o2 = ctx.createImageData(s, s);
  const h = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) { const o = i * 4; h[i] = (src.data[o] * .299 + src.data[o + 1] * .587 + src.data[o + 2] * .114) / 255; }
  const at = (x, y) => h[((y + s) % s) * s + ((x + s) % s)];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const inv = 1 / Math.hypot(dx, dy, 1), o = (y * s + x) * 4;
    o2.data[o] = (-dx * inv * .5 + .5) * 255;
    o2.data[o + 1] = (dy * inv * .5 + .5) * 255;
    o2.data[o + 2] = (inv * .5 + .5) * 255;
    o2.data[o + 3] = 255;
  }
  ctx.putImageData(o2, 0, 0);
  return c;
}

/* ---------- layer list UI ---------- */
function drawLayers() {
  const box = $('layers');
  box.innerHTML = '';
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const layer = state.layers[i];
    const row = document.createElement('div');
    row.className = 'lrow' + (i === state.sel ? ' sel' : '');
    const name = document.createElement('span');
    name.textContent = GENS[layer.gi].name + (layer.blend !== 'normal' ? ` · ${layer.blend}` : '');
    name.className = 'lname';
    row.appendChild(name);
    const mk = (txt, title, fn, dis) => {
      const b = document.createElement('button');
      b.textContent = txt; b.title = title; b.className = 'lbtn';
      b.disabled = !!dis;
      b.onclick = e => { e.stopPropagation(); fn(); };
      row.appendChild(b);
    };
    mk('▲', 'Move toward top', () => { [state.layers[i], state.layers[i + 1]] = [state.layers[i + 1], state.layers[i]]; state.sel = i + 1; refresh(); }, i === state.layers.length - 1);
    mk('▼', 'Move toward bottom', () => { [state.layers[i], state.layers[i - 1]] = [state.layers[i - 1], state.layers[i]]; state.sel = i - 1; refresh(); }, i === 0);
    mk('✕', 'Delete layer', () => { state.layers.splice(i, 1); state.sel = Math.min(state.sel, state.layers.length - 1); refresh(); }, state.layers.length === 1);
    row.onclick = () => { state.sel = i; refresh(); };
    box.appendChild(row);
  }
}

/* ---------- params UI for selected layer ---------- */
function field(name, el) {
  const lab = document.createElement('label');
  lab.className = 'field'; lab.textContent = name;
  lab.appendChild(el);
  return lab;
}
function slider(min, max, step, val, fn) {
  const wrap = document.createDocumentFragment();
  const span = document.createElement('span'); span.className = 'val'; span.textContent = val;
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
  inp.oninput = () => { span.textContent = inp.value; fn(+inp.value); };
  wrap.appendChild(span);
  wrap.appendChild(inp);
  return wrap;
}
function buildParams() {
  const layer = L(), box = $('params');
  box.innerHTML = '';
  $('gen-select').value = layer.gi;

  // blend + opacity for this layer
  const bsel = document.createElement('select');
  Object.keys(BLENDS).forEach(b => bsel.add(new Option(b, b)));
  bsel.value = layer.blend;
  bsel.onchange = () => { layer.blend = bsel.value; drawLayers(); update(); };
  box.appendChild(field('Blend mode', bsel));
  box.appendChild(field('Opacity', slider(0, 1, 0.02, layer.opacity, v => { layer.opacity = v; update(); })));
  box.appendChild(document.createElement('hr'));

  // generator params
  for (const p of GENS[layer.gi].p) {
    if (p.type === 'color') {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = layer.v[p.k];
      inp.oninput = () => { layer.v[p.k] = inp.value; update(); };
      box.appendChild(field(p.n, inp));
    } else {
      box.appendChild(field(p.n, slider(p.min, p.max, p.step, layer.v[p.k], v => { layer.v[p.k] = v; update(); })));
    }
  }
  box.appendChild(document.createElement('hr'));

  // universal layer options
  box.appendChild(field('Offset X', slider(0, 1, 0.01, layer.offx, v => { layer.offx = v; update(); })));
  box.appendChild(field('Offset Y', slider(0, 1, 0.01, layer.offy, v => { layer.offy = v; update(); })));
  const inv = document.createElement('input');
  inv.type = 'checkbox'; inv.checked = layer.invert;
  inv.onchange = () => { layer.invert = inv.checked; update(); };
  const invLab = document.createElement('label');
  invLab.className = 'check'; invLab.appendChild(inv);
  invLab.appendChild(document.createTextNode(' Invert colors'));
  box.appendChild(invLab);
  const seed = document.createElement('input');
  seed.type = 'number'; seed.step = 'any'; seed.value = layer.seed;
  seed.oninput = () => { layer.seed = +seed.value || 0; update(); };
  box.appendChild(field('Seed', seed));
}

/* ---------- views ---------- */
let view = 'tex';
const wrap = $('canvas-wrap'), nrmCanvas = $('nrm-canvas');
function updateView() {
  wrap.style.backgroundImage = '';
  out.hidden = view !== 'tex';
  nrmCanvas.hidden = view !== 'nrm';
  if (view === 'nrm') {
    const n = normalFrom(out, +$('nrm-strength').value);
    nrmCanvas.width = nrmCanvas.height = n.width;
    nrmCanvas.getContext('2d').drawImage(n, 0, 0);
  } else if (view === 'tiled') {
    wrap.style.backgroundImage = `url(${out.toDataURL()})`;
    wrap.style.backgroundSize = '33.333% 33.333%';
    wrap.style.backgroundRepeat = 'repeat';
  }
}
function update() { composite(512); updateView(); }
function refresh() { drawLayers(); buildParams(); update(); }

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  view = t.dataset.view;
  updateView();
});

/* ---------- top controls ---------- */
const sel = $('gen-select');
GENS.forEach((g, i) => sel.add(new Option(g.name, i)));
sel.onchange = () => { const layer = L(); layer.gi = +sel.value; layer.v = defaults(layer.gi); refresh(); };
$('tile-chk').onchange = update;
$('nrm-strength').oninput = () => { $('nrm-val').textContent = (+$('nrm-strength').value).toFixed(1); if (view === 'nrm') updateView(); };
$('btn-add').onclick = () => { state.layers.push(newLayer(0, 'multiply')); state.sel = state.layers.length - 1; refresh(); };

$('btn-random').onclick = () => {
  const layer = L();
  layer.seed = Math.round(Math.random() * 99999) / 100;
  for (const p of GENS[layer.gi].p) {
    if (p.type === 'color' || p.k === 'scale') continue;
    let v = p.min + Math.random() * (p.max - p.min);
    v = Math.round(v / p.step) * p.step;
    layer.v[p.k] = Math.min(p.max, Math.max(p.min, Math.round(v * 100) / 100));
  }
  refresh();
};

/* ---------- presets (save/load layer stack as JSON) ---------- */
function dlBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('btn-save').onclick = () => dlBlob(new Blob([JSON.stringify(state.layers)], { type: 'application/json' }), 'fasttex-preset.json');
$('btn-load').onclick = () => $('preset-file').click();
$('preset-file').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const layers = JSON.parse(r.result);
      if (!Array.isArray(layers) || !layers.length || !layers.every(l => GENS[l.gi] && l.v)) throw 0;
      state.layers = layers.map(l => ({ ...newLayer(l.gi), ...l, v: { ...defaults(l.gi), ...l.v } }));
      state.sel = 0;
      refresh();
    } catch { alert('Not a valid PlanetTex preset file.'); }
  };
  r.readAsText(f);
  e.target.value = '';
};

/* ---------- export ---------- */
const slug = () => GENS[state.layers[0].gi].name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '') + (state.layers.length > 1 ? '-combo' : '');
$('btn-png').onclick = () => {
  const r = +$('res-select').value;
  composite(r);
  out.toBlob(b => dlBlob(b, `fasttex-${slug()}-${r}.png`));
  update();
};
$('btn-normal').onclick = () => {
  const r = +$('res-select').value;
  composite(r);
  normalFrom(out, +$('nrm-strength').value).toBlob(b => dlBlob(b, `fasttex-${slug()}-normal-${r}.png`));
  update();
};

/* ---------- go ---------- */
refresh();

// Same-origin integration used by PlanetForge. It renders the real preset
// with PlanetTex's shader stack instead of asking the consumer to imitate it.
window.PlanetTex = {
  renderPreset(layers, size = 1024) {
    if (!Array.isArray(layers) || !layers.length || !layers.every(l => GENS[l.gi] && l.v))
      throw new Error('Invalid PlanetTex preset');
    state.layers = layers.map(l => ({ ...newLayer(l.gi), ...l, v: { ...defaults(l.gi), ...l.v } }));
    state.sel = 0;
    composite(size);
    return out.toDataURL('image/png');
  }
};
