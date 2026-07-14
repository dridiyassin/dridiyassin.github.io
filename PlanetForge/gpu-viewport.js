import * as THREE from './vendor/three/three.module.js';

export class GPUViewport {
  constructor(hostCanvas) {
    this.host = hostCanvas;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gpu-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    hostCanvas.parentElement.insertBefore(this.canvas, hostCanvas);
    this.renderer = new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38,1,.01,100);
    this.scene.add(new THREE.HemisphereLight(0xe7f1ff,0x454038,2.25));
    const key=new THREE.DirectionalLight(0xffffff,3.2);key.position.set(-3,5,6);this.scene.add(key);
    const rim=new THREE.DirectionalLight(0x86b9ff,1.4);rim.position.set(4,1,-5);this.scene.add(rim);
    this.materials = {
      solid:new THREE.MeshStandardMaterial({color:0xd8dadd,roughness:.68,metalness:0,side:THREE.DoubleSide}),
      texture:new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide}),
      rendered:new THREE.MeshStandardMaterial({color:0xffffff,roughness:.46,metalness:.04,side:THREE.DoubleSide})
    };
    this.mesh=null;this.version=-1;this.source=null;this.textureSource=null;
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();
  }
  pickUV(clientX,clientY){
    if(!this.mesh)return null;const r=this.host.getBoundingClientRect();this.pointer.set((clientX-r.left)/r.width*2-1,-((clientY-r.top)/r.height*2-1));this.raycaster.setFromCamera(this.pointer,this.camera);const hit=this.raycaster.intersectObject(this.mesh,false)[0];return hit?.uv?{u:hit.uv.x,v:1-hit.uv.y}:null;
  }
  sync(mesh,faceMap,version){
    if(this.source===mesh&&this.version===version)return;
    this.source=mesh;this.version=version;
    const pos=[],uv=[];
    mesh.f.forEach((face,fi)=>{const m=faceMap[fi];face.forEach((vi,c)=>{pos.push(...mesh.v[vi]);const p=m?.isl.pts[m.k*3+c];uv.push(m&&p?m.isl.x+p[0]:0,m&&p?1-(m.isl.y+p[1]):0);});});
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();g.computeBoundingSphere();
    if(this.mesh){this.mesh.geometry.dispose();this.scene.remove(this.mesh);}
    this.mesh=new THREE.Mesh(g,this.materials.texture);this.scene.add(this.mesh);
  }
  render(mesh,faceMap,version,textureCanvas,mode,orbit,zoom,material={}){
    this.sync(mesh,faceMap,version);
    const rect=this.host.getBoundingClientRect(),w=Math.max(1,rect.width|0),h=Math.max(1,rect.height|0);
    this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();
    const dist=4.2/Math.max(.35,zoom),cx=Math.cos(orbit.x),sx=Math.sin(orbit.x),cy=Math.cos(orbit.y),sy=Math.sin(orbit.y);
    this.camera.position.set(sy*cx*dist,-sx*dist,cy*cx*dist);this.camera.lookAt(0,0,0);
    if(this.textureSource!==textureCanvas){this.textureSource=textureCanvas;this.map?.dispose();this.map=new THREE.CanvasTexture(textureCanvas);this.map.colorSpace=THREE.SRGBColorSpace;this.materials.texture.map=this.map;this.materials.rendered.map=this.map;}else this.map.needsUpdate=true;
    this.materials.rendered.roughness=material.roughness??.46;this.materials.rendered.metalness=material.metalness??.04;
    const setDataMap=(key,canvas)=>{if(!canvas)return;if(this[key]?.image!==canvas){this[key]?.dispose();this[key]=new THREE.CanvasTexture(canvas);this[key].colorSpace=THREE.NoColorSpace;}else this[key].needsUpdate=true;};
    setDataMap('roughnessMap',material.roughnessMap);setDataMap('metalnessMap',material.metalnessMap);this.materials.rendered.roughnessMap=this.roughnessMap;this.materials.rendered.metalnessMap=this.metalnessMap;
    this.mesh.material=this.materials[mode]||this.materials.texture;
    this.renderer.render(this.scene,this.camera);
  }
}

export class GPUMaterialViewport extends GPUViewport {
  constructor(hostCanvas){
    super(hostCanvas);
    this.sphereMaterial=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.46,metalness:.04});
    this.sphere=new THREE.Mesh(new THREE.SphereGeometry(1,96,64),this.sphereMaterial);this.scene.add(this.sphere);
  }
  renderMaterial(textureCanvas,rotation,roughness,metalness,lightAngle){
    const rect=this.host.getBoundingClientRect(),w=Math.max(1,rect.width|0),h=Math.max(1,rect.height|0);this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.camera.position.set(0,0,3.25);this.camera.lookAt(0,0,0);this.sphere.rotation.y=rotation*Math.PI*2;
    if(this.textureSource!==textureCanvas){this.textureSource=textureCanvas;this.map?.dispose();this.map=new THREE.CanvasTexture(textureCanvas);this.map.colorSpace=THREE.SRGBColorSpace;this.sphereMaterial.map=this.map;}else this.map.needsUpdate=true;
    this.sphereMaterial.roughness=roughness;this.sphereMaterial.metalness=metalness;
    const key=this.scene.children.find(x=>x.isDirectionalLight);if(key)key.position.set(Math.cos(lightAngle)*5,Math.sin(lightAngle)*5,5);
    this.renderer.render(this.scene,this.camera);
  }
}
