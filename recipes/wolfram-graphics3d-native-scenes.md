# Native 3D scenes for `wolfram_show` (Graphics3D → three.js) — experiment findings

Question (2026-09-21): can `wolfram_show` ship `Graphics3D` (and `Manipulate` of it) as a
**native, rotatable three.js scene** instead of a rasterized PNG, by translating Mathematica's
box-level graphics IR rather than its high-level primitives? And is there a portable MIME type to
carry such scenes as attachments?

Answer in one line: **yes — the box IR is a closed set of ~26 heads, a 350-line WL translator plus a
~400-line three.js viewer already reproduce Plot3D / shapes / polyhedra / Graph3D / VectorPlot3D
visually; glTF is *not* usable as the rendering IR (Mathematica's exporter is too lossy) but is a
fine optional download.** Code: `~/github/tali-dash-plugins/plugins/wolfram-kernel-supervisor/experiments/graphics3d/`
(`Scene3D.wl` translator, `viewer.html`, 13 test scenes with `Rasterize` references). Nothing is wired
into the plugin yet.

## 1. The box IR is small and stable (measured, Mathematica 15.0.1)

`ToBoxes[Graphics3D[...]]` gives `Graphics3DBox[prims, {opts...}]` (options as a *list* in the second
argument — `Cases[b, _Rule, {1}]` finds nothing). 55 high-level inputs (every shape primitive,
regions, `Plot3D`, `ParametricPlot3D`, `ContourPlot3D`, `RegionPlot3D`, `SphericalPlot3D`,
`VectorPlot3D`, `StreamPlot3D`, `ListPointPlot3D`, `ListSurfacePlot3D`, `Graph3D`, `Raster3D`,
`MeshRegion`, `BoundaryMeshRegion`, `Texture`, `Inset`, curves, transforms) normalize to:

| Group | Box heads |
|---|---|
| Structure | `Graphics3DBox`, `GraphicsComplex3DBox` (coords + `VertexNormals`/`VertexColors` as numeric `{n,3}` arrays), `GraphicsGroup3DBox`, `GeometricTransformation3DBox` (matrix, `{m,v}`, `{m, Center}`, or a *list* of them = instancing) |
| Meshes | `Polygon3DBox` (index list / list of index lists inside a complex; coordinates outside; ragged — Plot3D emits separate boxes for tris, quads and pentagons), `Line3DBox`, `Point3DBox` |
| Shapes | `SphereBox`, `CylinderBox`, `ConeBox`, `CuboidBox`, `TubeBox`, `TubeBSplineCurveBox`, `TubeBezierCurveBox`, `HexahedronBox`, `TetrahedronBox`, `PrismBox`, `PyramidBox`, `PolyhedronBox[coords, faces]` — inside a complex their point arguments are **vertex indices** (`SphereBox[1, r]` in `Graph3D`) |
| Curves / surfaces | `BezierCurve3DBox`, `BSplineCurve3DBox`, `BSplineSurface3DBox` (what `CapsuleShape`, `Torus[]`, `Ellipsoid`… become) |
| Infinite | `ConicHullRegion3DBox` (`AffineSpace`, `HalfSpace`, `InfinitePlane`, `InfiniteLine`, `HalfLine`, `ConicHullRegion`) |
| Other | `Arrow3DBox[spec | TubeBox[...], setback]`, `Text3DBox[FormBox[...], pos, offset]`, `Inset3DBox`, `Raster3DBox`, `Axis3DBox` |
| Wrappers | `InterpretationBox[box, original]` (the original expression rides along — used to re-discretize), `TagBox`, `StyleBox`, `FormBox`, `DynamicModuleBox`, `NamespaceBox` (Graph) |
| Directives (unchanged) | colours, `Opacity`, `Specularity`, `EdgeForm`, `FaceForm`, `PointSize`/`AbsolutePointSize`, `Thickness`/`AbsoluteThickness`, `Dashing`, `Arrowheads[{{s, pos}}, Appearance -> …]`, `Glow`, `Texture`, `CapForm`, `Directive[...]`, `Lighting -> …` as an inline directive |

Gotchas found: `NCache[exact, numeric]` wraps exact coordinates (take part 2); **some region
primitives pass through `MakeBoxes` unboxed** — `Torus[{3,0,0},{1,.3}]`, `FilledTorus[...]`,
`Annulus` reach the IR as themselves (the front end knows them), and `Rasterize` of the explicit-arg
`Torus` even produces a pink error box, so the translator's `RegionQ → Discretize` fallback renders
*more* than the front end does.

## 2. glTF / other 3D formats as the carrier: no

`Export` to `"GLTF"` (WolframCGL`GLTFDump`, JSON with data-URI buffers; `"Binary" -> True` is
ignored, there is no GLB) keeps colours/opacity as PBR `baseColorFactor` but emits **triangles only**
(`mode 4`, `POSITION` attribute only — no normals, no vertex colours), silently **drops `Line`,
`Point`, `Text`**, and **rejects `Plot3D` output outright** (`Export::type` for any
`GraphicsComplex` with the plot's structure; even polygons-only gave a 605-byte empty scene). OBJ/X3D/USD
export the same tessellation. Verdict: glTF (`model/gltf+json`) and USDZ (`model/vnd.usdz+zip`,
QuickLook/AR on Apple devices) are worthwhile as an optional *download* button produced by
`Export`, not as the rendering IR. The scene must be our own JSON; DSH's attachment service has
`saveFile` (verbatim bytes, content-addressed `FileAttachmentRef`, `docs/subsystems/attachment.md`)
so it rides the same path as today's PNG — suggested MIME `application/vnd.dsh.graphics3d+json`.

Prior art for the vocabulary: [mathics-threejs-backend](https://github.com/Mathics3/mathics-threejs-backend)
(MIT, jsDelivr) renders a JSON of `sphere/cylinder/cone/cuboid/tube/polygon/line/point/arrow/text/uniformPolyhedron`
+ lights + normalized `viewpoint` + 0–1 ticks — but one element per polygon, no indexed mesh, no vertex
colours, so a `Plot3D` (≈2 000 quads with `VertexColors`/`VertexNormals`) would be slow and flat. We
borrowed the vocabulary and added `complex`/`mesh`.

## 3. The scene format (`dsh-graphics3d/0`) and the translator

`Scene3D.wl` (header documents every key). Scene: `range` (from `Charting\`get3DPlotRange[g]`,
6 ms, includes padding), `boxRatios`, `view` (`ViewPoint`/`ViewVertical`/`ViewAngle`/`ViewCenter`/
`ViewProjection`), `boxed`, `axes`, `ticks` (from `Charting\`ScaledTicks[{Identity, Identity}][min, max, {6, 6}]`
— major ticks carry labels, minor ticks are the `Spacer` rows; labels are `NumberForm[...]`
wrappers → `ToString[l, OutputForm]`), `axesLabel`, `lighting`, `background`, `imageSize`,
`elements`, `unsupported`. Elements carry a `style` (only keys that differ from the default) and are
`sphere | cylinder | cone | cuboid | tube | polyhedron | mesh | line | point | arrow | text | group | complex`;
children of a `complex` reference its coordinate array by 0-based index (`idx: true`). Positions are
rounded to ~6 significant digits relative to the box (`Round[x, 10^(⌊log10 longest side⌉ − 6)]`),
normals/colours to 3 decimals.

Sizes/timings (translate + JSON, warm kernel): shapes 2 KB / 33 ms; `Plot3D` default 223 KB / 37 ms;
`ContourPlot3D` 104 KB; `SphericalPlot3D` 211 KB; heavy `Plot3D` (60 pts, 4 649 vertices, 9 030 faces)
447 KB raw / **119 KB gzipped** in 45 ms + 5 ms, vs the 148 KB @2x PNG. **The first cut emitted 6 MB for
`Plot3D`** because every `Polygon3DBox` inside the complex re-emitted the whole coordinate array plus
normals/colours — the `complex` element with index-referencing children fixed it.

Kernel-side discretization: `BSplineSurface3DBox` / unboxed regions → `BoundaryDiscretizeRegion`
(3D) or `DiscretizeRegion` (2D/1D) with `PrecisionGoal -> 3` (capsule 1 200 tris vs 17 000 at default);
unbounded regions are first clipped with `RegionIntersection[r, Cuboid @@ Transpose[range]]`
(`BoundaryDiscretizeRegion` fails on the 2D `AffineSpace` slab — dimension decides the discretizer).
`TubeBSplineCurveBox` → `BSplineFunction` sampled at 65 points.

## 4. Rendering facts that had to be measured (viewer.html)

| Fact | Consequence in three.js |
|---|---|
| Mathematica shades in gamma space; `ViewPoint` is in normalized-box units (longest side 1, centred); `ViewAngle -> Automatic` fits the box corners | `THREE.ColorManagement.enabled = false`, `outputColorSpace = LinearSRGBColorSpace`; root group translated/scaled by `BoxRatios`; camera at `ViewPoint`, `up = ViewVertical`, fov from the projected corners |
| three ≥ r155 divides Lambert irradiance by π (legacy lights removed); Mathematica sums `lightColor·cosθ` | every light gets **intensity π** — measured on a red sphere: 0.34 → 1.0 |
| `Specularity[s, n]` is classic Phong (reflection vector); three's Blinn half-vector lobe is normalized by `(n/2+1)/π` | `shininess = 4n`, `specular = s·0.35/(2n+1)` — the 0.35 is empirical (Plot3D's `Specularity[White, 3]` barely shows in the front end); **still to calibrate against pixel values** |
| `Lighting -> Automatic` = `{{"Ambient", RGBColor[.4,.2,.2]}, {"Directional", RGBColor[0,.18,.5], ImageScaled[{2,0,2}]}, {"Directional", RGBColor[.18,.5,.18], ImageScaled[{2,2,3}]}, {"Directional", RGBColor[.5,.18,0], ImageScaled[{0,2,2}]}}`; `"Neutral"` = `GrayLevel[.35]` ambient + three `GrayLevel[.6]` directionals at the same points (`Charting\`CommonDump\`$DefaultLighting` is unassigned) | hard-coded in `Scene3D.wl` |
| `ImageScaled[{x,y,z}]` light positions: fractions of the **displayed** bounding box, x right, y up, fixed to the camera; a lone position shines **toward the box centre** ([DirectionalLight docs](https://reference.wolfram.com/language/ref/DirectionalLight.html)). Measured: for *directional* lights z = 0 back … 1 front as documented (white light at `{.5,.5,0}` → black sphere centre, `{.5,.5,1}` → 0.81); for *point* lights **z = 0 already sits at the front face** (`{.5,.5,-5}` black, `{.5,.5,0}` … `{.5,.5,20}` all ≈ 0.97) and the falloff is much softer than Lambert | camera-space AABB of the box each frame; directional lights count depth from the back, point/spot lights from the front; point-light softness not modelled yet (Graph3D vertices render darker than the front end) |
| Points are round, sized as a fraction of the image width | `PointsMaterial` with a canvas disc texture, `sizeAttenuation: false` |
| Mesh lines z-fight with their surface | `polygonOffset` on surface materials |
| Free-standing polygons/polyhedra are flat-shaded with black edges; complexes are smooth (`VertexNormals`) with no edges | per-face vertex duplication for polyhedra; `computeVertexNormals` when no normals were shipped |

Side-by-side results (viewer screenshot vs `Rasterize`): `shapes`, `plot3d`, `plot3d-rainbow`
(`VertexColors`), `polyhedra` (`Dodecahedron` via `PolyhedronBox`, transforms via `group`),
`capsule-torus-affine` (all three discretized), `graph3d` (tube edges, indexed spheres),
`vectorplot` (18 instanced tube arrows) match in geometry, camera, box, ticks and colour;
`Arrowheads[..., Appearance -> "Projected"]` flat heads render as cones; text is CSS2D
(`Text3DBox` → plain string for now).

## 5. Proposed first cut for the plugin

1. **Kernel** (`kernel/DSHPlugin.wl`): `ShowRasterizer` gains a `"Mode" -> "Auto"` — if the
   evaluated result's `ToBoxes` head is `Graphics3DBox` (or `Legended`/`Graph` wrapping one) run
   `Scene3D\`ToScene`; when `unsupported` is empty print `DSH-SCENE3D:{json}` (or write the JSON to a
   temp file and print its path — 450 KB through the MCP text channel costs ~10 ms, files don't help,
   see the transport benchmark in `wolfram-kernel-supervisor.md`) **and still rasterize** a preview
   PNG (the model-visible one-liner and the fallback for clients without WebGL). When `unsupported`
   is non-empty fall back to the PNG and list the heads in the report so we learn what to add
   (`Raster3DBox`, `Inset3DBox`, `Texture`, `Text3DBox` with non-string content are the known ones).
2. **Host** (`tools.mjs`): parse the line, `ctx.attachments.saveFile` the JSON
   (`application/vnd.dsh.graphics3d+json`), put the `FileAttachmentRef` next to the PNG in
   `presentationMeta`, serve it through a sibling of `GET /api/wolfram/shown` (same session-scan
   authorization) with gzip. Manipulate: `Render[id, values]` returns a new scene; the client swaps
   geometry only (camera and controls persist — the actual win over re-rasterizing).
3. **Client** (`src/client/index.tsx`): bundle three (~600 KB min; esbuild inlines it — check the
   plugin bundle rule about externals in AGENTS.md; lazy-import the viewer module so text-only sessions
   never pay) and port `viewer.html` into a `Scene3DView` component used by the toolview, the pinned
   turn-tail gallery and the `/wolfram-show` command card; `OrbitControls` for rotation, the PNG shown
   until the scene is fetched. Dark mode: `LightDark` already drives the kernel; the scene's box/tick
   colours come from CSS variables instead.
4. **Optional**: an "Export glTF/USDZ" action that calls `Export` in the kernel on the held
   expression (lossy, but portable to QuickLook/Blender).

Open items: specular and point-light calibration (measure `ImageValue` of `Rasterize` probes as in
§4 and fit), fat lines (`Line2` — `LineBasicMaterial` is 1 px), `Dashing`, `Texture` (ship the
image as a PNG attachment), `Text3DBox` with styled boxes (reuse `labelTree` from `DSHPlugin.wl`),
`Inset3DBox` (rasterize the inset → sprite), `Raster3DBox` (volume — keep the PNG), `AxesEdge`
heuristics (viewer picks the outermost projected edges), `FaceGrids`, `ClipPlanes`,
`Arrowheads` positions/multiple heads, `Arrow` setback, `GeometricTransformation3DBox[..., {m, Center}]`
(rotation about the object's own bbox centre; identity today).

## 6. Failed attempts / gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Export[..., "GLTF"]` of `Plot3D` → `Export::type` | Wolfram's glTF exporter accepts shapes and mesh regions, not plot `GraphicsComplex`es | glTF is a download, not the IR |
| `ExportByteArray[g, {"GLTF", "Binary" -> True}]` starts with `{` | option ignored; there is no GLB export | parse as JSON |
| `Cases[ToBoxes[g], _Rule, {1}]` empty | `Graphics3DBox[prims, {opts}]` — options are a list at level 2 | look at level 2 (and 1) |
| `elide` helper with `Placeholder[Dimensions[l]]` printed unevaluated | `Placeholder` is a System symbol with hold semantics | use a private symbol |
| `ExampleData[{"ColorTexture", ...}]` → `Throw[$Failed, "DataPacletException"]` and the whole `<|...|>` assignment aborted | no paclet download in the sandbox kernel | generated `Image[RandomReal[...]]` |
| First `Plot3D` scene was 6 MB | coordinates/normals/colours duplicated per `Polygon3DBox` | `complex` element + index children (223 KB) |
| `Torus[{3,0,0},{1,.3}]` reported `unsupported: Torus` | passes through `MakeBoxes` unboxed | `walk[r_?RegionQ]` → discretize |
| Viewer: `Spread syntax requires ...iterable` on `Graph3D` | `SphereBox[1, r]` centre is a vertex index inside the complex | resolve indices for every shape box |
| Everything ~⅓ as bright as the front end | three ≥ r155 Lambert `1/π` | light intensity π |
| Rainbow `Plot3D` washed out to white | Blinn-Phong with exponent 3 + π lights; Mathematica's classic Phong highlight is weak | `shininess = 4n`, damped specular |
| Graph3D scene rendered black | both of its lights sit at `z = 0`, which for directional lights is the back — but the front end lights it | point-light z counts from the front (measured) |
| `python3 -m http.server` never accepted connections (`lsof` shows the socket `CLOSED`) | unknown local quirk; node's `http` works | node one-liner server (README) |

## 7. References

- `deepseek-harness/docs/subsystems/attachment.md` — `saveFile`/`readFileStream`/`fileHostPath`
- `recipes/wolfram-kernel-supervisor.md` — the image path this would extend (presentationMeta, `/api/wolfram/shown`, Manipulate re-render)
- [DirectionalLight](https://reference.wolfram.com/language/ref/DirectionalLight.html), [Lighting](https://reference.wolfram.com/language/ref/Lighting.html) — `ImageScaled` light convention
- [mathics-threejs-backend](https://github.com/Mathics3/mathics-threejs-backend) — prior-art vocabulary
