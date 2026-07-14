# PlanetLOD

PlanetLOD is a local browser LOD generator for OBJ, glTF, GLB and FBX models. It creates multiple vertex-clustered mesh levels, previews them with WebGL, exports separate OBJ/GLB files, and builds self-contained Unity `.unitypackage` archives containing OBJ meshes and an `LODGroup` prefab.

Serve the repository root and open `/PlanetLOD/`. Models never leave the browser.

## Unity notes

The generated package targets Unity's legacy custom asset-package importer and uses OBJ model assets for maximum built-in compatibility. The generated prefab references the first imported mesh subasset (`fileID: 4300000`) from each OBJ and assigns Unity's built-in default material. Complex source materials, animation, blend shapes, skinning, colliders and custom shaders are not transferred in this initial version.
