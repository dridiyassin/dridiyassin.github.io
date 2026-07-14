# PlanetForge

PlanetForge is FreeToolPlanet's local browser-based 3D texturing studio: multi-format model import, smart UV unwrapping, layered texture painting and GPU-accelerated material preview. Everything runs locally.

Serve the repository root and open `/PlanetForge/`:

```bash
python3 -m http.server 8000
# http://localhost:8000/PlanetForge/
```

## Implemented

- Local OBJ, glTF and GLB parsing plus vendored Three.js FBXLoader support for binary and ASCII FBX, with imported UV preservation
- Angle-aware smart unwrap and box projection, with working orient/order options
- Islands keep relative real-world scale (even texel density), shelf packing with true pixel padding
- Manual island selection, move, rotate 90° and flip in the UV editor
- Three.js/WebGL model and material viewports with high-performance GPU preference, orbit, zoom, depth buffering, filtered live textures and CPU compatibility fallback
- Split painting workspace with an independent orbit/zoom live model preview and Solid, Texture and Rendered display modes
- Channel-aware texture layers at 256², 512², 1024², 2048² or 4096² (base color, normal, roughness, metallic, height, emissive and opacity), editable layer masks, PNG import, and exact PlanetTex shader preview with an explicit non-destructive bake step
- Built-in round, soft, rust, grunge, speckle, splatter, spray, dirt, scratch, crack and star brushes plus custom browser-local brush presets
- UV-aware painting directly on the 3D model preview; Alt-drag temporarily switches back to orbiting
- Visual brush-shape palette and multi-channel material brushes with iron, gold, copper, steel, rust, rubber, wood, stone and plastic presets plus browser-local custom materials
- IndexedDB recovery autosave every eight seconds and a confirmation-protected New Project action
- UV-bearing OBJ and glTF/glb export, plus basic ASCII FBX mesh export
- Software material sphere: roughness, metallic, derived bump, movable light, three environments
- Portable JSON project save and load (mesh + islands + layers + material)
- Drag & drop anywhere: `.obj` imports a model, images import into the active layer, `.json` loads a project

## Roadmap

1. Replace the software viewport with WebGL and add glTF/GLB loaders.
2. Topology-aware seam scoring and LSCM/ABF flattening.
3. Texel-density constraints, distortion heatmaps, polygon-accurate packing.
4. Paint in model space with seam dilation, masks and stencils.
5. Full PBR channel sets and HDRI lighting.
