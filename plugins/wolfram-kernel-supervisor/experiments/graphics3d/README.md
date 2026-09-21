# Graphics3D → native three.js scene (experiment, 2026-09-21)

Prototype for making `wolfram_show` emit a **native 3D scene** for `Graphics3D` (and
`Manipulate` of it) instead of a PNG. The system-level findings, measurements and the
proposed first cut live in the recipe
`~/github/tali-dash-plugins/recipes/wolfram-graphics3d-native-scenes.md`; this directory
holds the code that produced them.

| File | What |
|---|---|
| (translator) | Now lives in the plugin proper: `../../kernel/Scene3D.wl` (`Scene3D\`ToScene[g]` walks the box IR that `ToBoxes` produces — `Graphics3DBox` + ~26 box heads — and emits the `dsh-graphics3d/0` JSON scene documented in its header). The production renderer is `../../src/client/scene3d.tsx`. |
| `viewer.html` | Standalone three.js (r160, jsDelivr import map) viewer: `viewer.html?scene=<name>` loads `scenes/<name>.json`. Reproduces Mathematica's camera (`ViewPoint` in normalized box units, `ViewAngle` fit), `BoxRatios`, box + axes ticks, gamma-space Phong lighting with `ImageScaled` light placement, `CSS2DRenderer` labels. `&nospec` disables specular (diagnostic). |
| `scenes/*.json`, `scenes/*-ref.png` | The 13 test scenes and their `Rasterize` references (72 dpi) used for the side-by-side comparison. |

Regenerate / view:

```wolfram
Get["<plugin>/kernel/Scene3D.wl"];
Scene3D`ExportScene["<this dir>/scenes/plot3d.json", Plot3D[Sin[x y], {x, 0, 3}, {y, 0, 3}]]
```

```sh
# any static server works EXCEPT python's http.server, which sat in a CLOSED state on this Mac
node -e "require('http').createServer((q,r)=>{const p=require('path').join(process.cwd(),decodeURIComponent(new URL(q.url,'http://x').pathname));require('fs').readFile(p,(e,d)=>{if(e){r.writeHead(404);return r.end()}r.writeHead(200,{'content-type':p.endsWith('.json')?'application/json':'text/html'});r.end(d)})}).listen(8768,'127.0.0.1')"
open http://127.0.0.1:8768/viewer.html?scene=plot3d
```

The viewer stays useful as a standalone harness for the scene format (plain HTML, no DSH): compare a
`scenes/<name>.json` against its `-ref.png`, or drop a new scene from `Scene3D\`ExportScene` in.
