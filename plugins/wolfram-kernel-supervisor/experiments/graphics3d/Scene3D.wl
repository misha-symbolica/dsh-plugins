(* ::Package:: *)
(* Scene3D` — EXPERIMENT (2026-09-21): translate Graphics3D into a web-friendly JSON scene by
   walking the box IR that MakeBoxes produces (Graphics3DBox and the ~26 box heads under it),
   instead of rasterizing. See README.md next to this file for the findings.

     Scene3D`ToScene[g]                   -> Association (the scene); g may be Graphics3D,
                                              Legended[...], a Graph, or a bare 3D primitive
     Scene3D`ToSceneJSON[g]               -> compact JSON string
     Scene3D`ExportScene[file, g]         -> writes JSON

   Scene format ("dsh-graphics3d/0"):
     range       {{xmin,xmax},{ymin,ymax},{zmin,zmax}}   (Charting`get3DPlotRange, incl. padding)
     boxRatios   {rx,ry,rz} | Null (Automatic = true proportions)
     view        <|point, vertical, angle, center, projection|>   (ViewPoint convention)
     boxed, axes, ticks (per axis: major {pos,label}..., minor pos...), axesLabel
     lighting    list of <|type, color, dir|dirScene|pos|>   (dir = Mathematica ImageScaled convention)
     background  Null | {r,g,b}
     imageSize   Null | {w, h|Null}
     elements    list of elements in scene coordinates (Wolfram z-up)
     unsupported list of box heads / directives that were skipped — the host should fall back to
                 rasterizing when non-empty (or show the partial scene and say so)

   Elements (all carry "style"):
     sphere     centers, radius            cylinder/cone  segments {{p1,p2}..}, radius
     cuboid     min, max                   tube           paths {{p..}..}, radius|Null
     polyhedron coords, faces (0-based)    mesh           coords, faces (0-based, ragged) [, vertexColors]
     line       paths                      point          coords
     arrow      paths, radius|Null         text           text, position, offset
     complex    coords [, vertexNormals, vertexColors], children — children of a complex are the
                same element types but with "idx" (0-based indices into coords) instead of geometry:
                mesh.faces / line.paths / arrow.paths / tube.paths are index lists, point.idx is one
     group      matrix <|m (3x3), t|>, children
   Numbers: positions rounded relative to the box scale (~6 significant digits), normals/colours to 3
   decimals. *)

BeginPackage["Scene3D`"];

ToScene::usage = "Scene3D`ToScene[g] translates a Graphics3D into a scene Association.";
ToSceneJSON::usage = "Scene3D`ToSceneJSON[g] gives the compact JSON string for the scene.";
ExportScene::usage = "Scene3D`ExportScene[file, g] writes the scene JSON to file.";

Begin["`Private`"];

$unsupported = {};
$range = {{0, 1}, {0, 1}, {0, 1}};
$cc = Null;            (* coordinate array of the enclosing GraphicsComplex3DBox, or Null *)
$q = 10.^-6;           (* position rounding quantum, set from the plot range *)

note[s_String] := (AppendTo[$unsupported, s]; {});

(* ---- colours & style state ---- *)

$defaultStyle = <|"color" -> {1., 1., 1.}, "opacity" -> 1., "specular" -> Null, "edge" -> <|"color" -> {0., 0., 0.}, "opacity" -> 1.|>,
  "face" -> Null, "pointSize" -> <|"scaled" -> 0.01|>, "thickness" -> <|"scaled" -> 0.001|>, "dashing" -> Null, "arrowheads" -> Null,
  "glow" -> Null, "lighting" -> Null|>;

rgb[c_?ColorQ] := Module[{l = List @@ ColorConvert[c, "RGB"]}, r3 @ l[[;; 3]]];
alpha[c_?ColorQ] := Module[{l = List @@ ColorConvert[c, "RGB"]}, If[Length[l] > 3, N @ l[[4]], Null]];
r3[x_] := N @ Round[x, 0.001];

applyDirective[st_, c_?ColorQ] := Module[{s = st, a = alpha[c]}, s["color"] = rgb[c]; If[a =!= Null, s["opacity"] = a]; s];
applyDirective[st_, Opacity[o_?NumericQ]] := Append[st, "opacity" -> N[o]];
applyDirective[st_, Opacity[o_?NumericQ, c_?ColorQ]] := Append[applyDirective[st, c], "opacity" -> N[o]];
applyDirective[st_, Specularity[c_?ColorQ, e_ : 1]] := Append[st, "specular" -> <|"color" -> rgb[c], "exponent" -> N[e]|>];
applyDirective[st_, Specularity[s_?NumericQ, e_ : 1]] := Append[st, "specular" -> <|"color" -> N@{s, s, s}, "exponent" -> N[e]|>];
applyDirective[st_, EdgeForm[] | EdgeForm[None]] := Append[st, "edge" -> Null];
applyDirective[st_, EdgeForm[d_]] := Module[{es = applyDirectives[$defaultStyle, Flatten[{d}]]},
  Append[st, "edge" -> <|"color" -> es["color"], "opacity" -> es["opacity"], "thickness" -> es["thickness"]|>]];
applyDirective[st_, FaceForm[d_]] := applyDirectives[st, Flatten[{d}]];
applyDirective[st_, FaceForm[front_, back_]] := Append[applyDirectives[st, Flatten[{front}]], "face" -> <|"back" -> applyDirectives[$defaultStyle, Flatten[{back}]]["color"]|>];
applyDirective[st_, PointSize[s_?NumericQ]] := Append[st, "pointSize" -> <|"scaled" -> N[s]|>];
applyDirective[st_, AbsolutePointSize[s_?NumericQ]] := Append[st, "pointSize" -> <|"absolute" -> N[s]|>];
applyDirective[st_, PointSize[s_Symbol]] := Append[st, "pointSize" -> <|"scaled" -> s /. {Tiny -> 0.005, Small -> 0.0075, Medium -> 0.01, Large -> 0.015}|>];
applyDirective[st_, Thickness[s_?NumericQ]] := Append[st, "thickness" -> <|"scaled" -> N[s]|>];
applyDirective[st_, AbsoluteThickness[s_?NumericQ]] := Append[st, "thickness" -> <|"absolute" -> N[s]|>];
applyDirective[st_, Thickness[s_Symbol]] := Append[st, "thickness" -> <|"absolute" -> s /. {Tiny -> 0.25, Small -> 0.5, Medium -> 1., Large -> 2.}|>];
applyDirective[st_, Thick] := Append[st, "thickness" -> <|"absolute" -> 2.|>];
applyDirective[st_, Thin] := Append[st, "thickness" -> <|"absolute" -> 0.25|>];
applyDirective[st_, Dashing[d_List]] := Append[st, "dashing" -> N[d /. {Tiny -> 1., Small -> 2., Medium -> 4., Large -> 8.}]];
applyDirective[st_, Dashed] := Append[st, "dashing" -> {4., 4.}];
applyDirective[st_, Dotted] := Append[st, "dashing" -> {1., 2.}];
applyDirective[st_, DotDashed] := Append[st, "dashing" -> {1., 2., 4., 2.}];
applyDirective[st_, Arrowheads[s_?NumericQ]] := Append[st, "arrowheads" -> N[s]];
applyDirective[st_, Arrowheads[l_List, ___Rule]] := Append[st, "arrowheads" -> Replace[FirstCase[Flatten[{l}], _?NumericQ, Null], x_?NumericQ :> N[x]]];   (* nested specs: first size only *)
applyDirective[st_, Glow[c_?ColorQ]] := Append[st, "glow" -> rgb[c]];
applyDirective[st_, Lighting -> l_] := Append[st, "lighting" -> lightingSpec[l]];
applyDirective[st_, Directive[d___]] := applyDirectives[st, {d}];
applyDirective[st_, _CapForm | _JoinForm | _Texture | _Antialiasing | ((VertexColors | VertexNormals | VertexTextureCoordinates) -> _)] := st;
applyDirective[st_, other_] := (note["directive:" <> ToString[Head[other]]]; st);
applyDirectives[st_, ds_List] := Fold[applyDirective, st, ds];

directiveQ[e_] := MatchQ[e, _?ColorQ | _Opacity | _Specularity | _EdgeForm | _FaceForm | _PointSize | _AbsolutePointSize | _Thickness | _AbsoluteThickness |
  Thick | Thin | Dashed | Dotted | DotDashed | _Dashing | _Arrowheads | _Glow | _Directive | _CapForm | _JoinForm | _Texture | _Antialiasing | (Lighting -> _)];

emitStyle[st_] := KeySelect[st, # === "color" || st[#] =!= $defaultStyle[#] &];

(* ---- numbers ---- *)
num[NCache[_, n_]] := num[n];
num[x_?NumericQ] := N[x];
num[l_List] := num /@ l;
num[other_] := other;
pos[c_] := N @ Round[Developer`ToPackedArray @ N @ (c /. NCache[_, n_] :> n), $q];     (* positions: box-relative rounding *)
idx0[i_] := i - 1;

(* ---- primitives ---- *)

el[type_, st_, extra_Association] := Join[<|"type" -> type, "style" -> emitStyle[st]|>, extra];

(* Is spec an index specification into the enclosing complex? *)
indexQ[spec_] := $cc =!= Null && (IntegerQ[spec] || ArrayQ[spec, 1, IntegerQ] || (MatchQ[spec, {__List}] && AllTrue[spec, VectorQ[#, IntegerQ] &]));
listOfPaths[spec_] := Which[ArrayQ[num@spec, 2], {pos[spec]}, MatchQ[spec, {__List}], pos /@ spec, True, $Failed];
pathIdx[spec_] := Which[ArrayQ[spec, 1, IntegerQ], {idx0[spec]}, True, idx0 /@ spec];
(* A point spec: single point, list of points, or (in a complex) indices. *)
withPoints[st_, spec_, type_, key_] := Which[
  indexQ[spec], {el[type, st, <|key -> Flatten[{idx0[spec]}]|>]},
  ArrayQ[num@spec, 2], {el[type, st, <|"coords" -> pos[spec]|>]},
  ArrayQ[num@spec, 1], {el[type, st, <|"coords" -> {pos[spec]}|>]},
  True, note[type <> ":shape"]];
withPaths[st_, spec_, type_, extra_ : <||>] := Which[
  indexQ[spec], {el[type, st, Join[<|"paths" -> pathIdx[spec], "idx" -> True|>, extra]]},
  listOfPaths[spec] =!= $Failed, {el[type, st, Join[<|"paths" -> listOfPaths[spec]|>, extra]]},
  True, note[type <> ":shape"]];

walk[l_List, st_] := Module[{s = st, out = {}},
  Do[If[directiveQ[e], s = applyDirective[s, e], out = Join[out, walk[e, s]]], {e, l}];
  out];

(* semantic wrappers whose SECOND argument is the original expression *)
walk[InterpretationBox[_BSplineSurface3DBox | _ConicHullRegion3DBox, orig_, ___], st_] := region[st, orig];
walk[TagBox[_ConicHullRegion3DBox, orig_, ___], st_] := region[st, orig];
(* plain wrappers *)
walk[(TagBox | InterpretationBox | StyleBox | FormBox | TooltipBox | DynamicBox | DynamicModuleBox | NamespaceBox | PaneBox | GraphicsGroup3DBox)[b_, ___], st_] := walk[b, st];

walk[GraphicsComplex3DBox[pts_, prims_, opts___], st_] := Module[{o = Flatten[{opts}], vc, vn, children, e},
  vc = Lookup[o, VertexColors, None]; vn = Lookup[o, VertexNormals, None];
  children = Block[{$cc = pts}, walk[prims, st]];
  e = <|"type" -> "complex", "coords" -> pos[pts], "children" -> children|>;
  If[vn =!= None && ArrayQ[vn, 2, NumericQ], e["vertexNormals"] = r3[vn]];
  Which[vc === None, Null,
    ArrayQ[vc, 2, NumericQ], e["vertexColors"] = r3[vc],
    ArrayQ[vc, 1, ColorQ], e["vertexColors"] = rgb /@ vc,
    True, note["VertexColors:shape"]];
  {e}];

walk[GeometricTransformation3DBox[b_, tf_, ___], st_] := Module[{ms = tfMatrices[tf], children},
  If[ms === $Failed, note["GeometricTransformation3DBox:" <> ToString[Head[tf]]]; Return[walk[b, st]]];
  children = walk[b, st];
  <|"type" -> "group", "matrix" -> #, "children" -> children|> & /@ ms];
tfMatrix[{m_?MatrixQ, v_?VectorQ}] := <|"m" -> num[m], "t" -> num[v]|>;
tfMatrix[{m_?MatrixQ, Center}] := <|"m" -> num[m], "t" -> {0., 0., 0.}|>;   (* rotate about the bounding-box centre — VectorPlot3D emits this identity form *)
tfMatrix[m_?MatrixQ /; Dimensions[m] == {3, 3}] := <|"m" -> num[m], "t" -> {0., 0., 0.}|>;
tfMatrix[v_?VectorQ /; Length[v] == 3] := <|"m" -> N @ IdentityMatrix[3], "t" -> num[v]|>;
tfMatrix[t_TransformationFunction] := With[{mm = TransformationMatrix[t]}, <|"m" -> num[mm[[;; 3, ;; 3]]], "t" -> num[mm[[;; 3, 4]]]|>];
tfMatrix[_] := $Failed;
tfMatrices[tf_] := Module[{one = tfMatrix[tf]},
  If[one =!= $Failed, Return[{one}]];
  If[ListQ[tf], With[{all = tfMatrix /@ tf}, If[FreeQ[all, $Failed], all, $Failed]], $Failed]];

(* shapes — inside a GraphicsComplex3DBox their point arguments may be vertex indices *)
rp[spec_] := If[indexQ[spec], num @ $cc[[spec]], num @ spec];
walk[SphereBox[c_, r_ : 1], st_] := With[{p = rp[c]}, {el["sphere", st, <|"centers" -> If[ArrayQ[p, 2], pos@p, {pos@p}], "radius" -> num[r]|>]}];
walk[CylinderBox[segs_, r_ : 1], st_] := With[{p = rp[segs]}, {el["cylinder", st, <|"segments" -> If[ArrayQ[p, 3], pos@p, {pos@p}], "radius" -> num[r]|>]}];
walk[ConeBox[segs_, r_ : 1], st_] := With[{p = rp[segs]}, {el["cone", st, <|"segments" -> If[ArrayQ[p, 3], pos@p, {pos@p}], "radius" -> num[r]|>]}];
walk[CuboidBox[mn_, mx_ : Automatic], st_] := {el["cuboid", st, <|"min" -> pos[rp@mn], "max" -> If[mx === Automatic, pos[rp@mn] + 1, pos[rp@mx]]|>]};
walk[TubeBox[spec_, r_ : Automatic], st_] := withPaths[st, spec, "tube", <|"radius" -> If[r === Automatic, Null, num[r]]|>];
walk[(TubeBSplineCurveBox | TubeBezierCurveBox)[spec_, r_ : Automatic, opts___], st_] := Module[{p, f},
  p = If[indexQ[spec], $cc[[spec]], num[spec]];
  f = Quiet @ BSplineFunction[p, FilterRules[{opts}, Options[BSplineFunction]]];
  If[Head[f] =!= BSplineFunction, Return @ note["TubeBSplineCurveBox"]];
  {el["tube", st, <|"paths" -> {pos @ Table[f[t], {t, 0, 1, 1/64}]}, "radius" -> If[r === Automatic, Null, num[r]]|>]}];

(* polyhedra with implicit face lists (vertex order as documented for Hexahedron/Prism/Pyramid/Tetrahedron) *)
walk[HexahedronBox[pts_], st_] := polyhedron[st, pts, {{1, 4, 3, 2}, {5, 6, 7, 8}, {1, 2, 6, 5}, {2, 3, 7, 6}, {3, 4, 8, 7}, {4, 1, 5, 8}}];
walk[TetrahedronBox[pts_], st_] := polyhedron[st, pts, {{1, 3, 2}, {1, 2, 4}, {2, 3, 4}, {3, 1, 4}}];
walk[PrismBox[pts_], st_] := polyhedron[st, pts, {{1, 3, 2}, {4, 5, 6}, {1, 2, 5, 4}, {2, 3, 6, 5}, {3, 1, 4, 6}}];
walk[PyramidBox[pts_], st_] := polyhedron[st, pts, {{1, 4, 3, 2}, {1, 2, 5}, {2, 3, 5}, {3, 4, 5}, {4, 1, 5}}];
walk[PolyhedronBox[pts_, faces_, ___], st_] := polyhedron[st, pts, faces];
polyhedron[st_, pts_, faces_] := Module[{p = If[indexQ[pts], $cc[[pts]], num[pts]]},
  Which[
    ArrayQ[p, 2], {el["polyhedron", st, <|"coords" -> pos[p], "faces" -> idx0[faces]|>]},
    ArrayQ[p, 3], el["polyhedron", st, <|"coords" -> pos[#], "faces" -> idx0[faces]|>] & /@ p,
    True, note["polyhedron:shape"]]];

(* polygons: inside a complex the spec is an index list (or list of them); outside it is coordinates *)
walk[Polygon3DBox[spec_, opts___], st_] := Module[{o = Flatten[{opts}], vc, e},
  e = Which[
    indexQ[spec], el["mesh", st, <|"faces" -> pathIdx[spec], "idx" -> True|>],
    ArrayQ[num@spec, 2], el["mesh", st, <|"coords" -> pos[spec], "faces" -> {Range[0, Length[spec] - 1]}|>],
    MatchQ[spec, {__List}], Module[{all = Join @@ (pos /@ spec), offs = Prepend[Accumulate[Length /@ spec], 0]},
      el["mesh", st, <|"coords" -> all, "faces" -> Table[Range[offs[[i]], offs[[i + 1]] - 1], {i, Length[spec]}]|>]],
    True, $Failed];
  If[e === $Failed, Return @ note["Polygon3DBox:shape"]];
  vc = Lookup[o, VertexColors, None];
  Which[vc === None, Null, ArrayQ[vc, 1, ColorQ], e["vertexColors"] = rgb /@ vc, ArrayQ[vc, 2, NumericQ], e["vertexColors"] = r3[vc]];
  {e}];

walk[Line3DBox[spec_, ___], st_] := withPaths[st, spec, "line"];
walk[Point3DBox[spec_, ___], st_] := withPoints[st, spec, "point", "idx"];
(* Arrow3DBox[spec, setback]: the optional second argument shortens the ends (ignored in v0) *)
walk[Arrow3DBox[TubeBox[spec_, r_ : Automatic], ___], st_] := withPaths[st, spec, "arrow", <|"tube" -> True, "radius" -> If[r === Automatic, Null, num[r]]|>];
walk[Arrow3DBox[spec_, ___], st_] := withPaths[st, spec, "arrow", <|"tube" -> False, "radius" -> Null|>];
walk[(BezierCurve3DBox | BSplineCurve3DBox)[spec_, opts___], st_] := Module[{p, f},
  p = If[indexQ[spec], $cc[[spec]], num[spec]];
  f = Quiet @ BSplineFunction[p, FilterRules[{opts}, Options[BSplineFunction]]];
  If[Head[f] =!= BSplineFunction, Return @ note["BSplineCurve3DBox"]];
  {el["line", st, <|"paths" -> {pos @ Table[f[t], {t, 0, 1, 1/64}]}|>]}];

(* text: plain strings in v0; other boxes are flattened to a string *)
walk[Text3DBox[content_, p_, rest___], st_] := Module[{o = {rest}, offset = {0, 0}},
  If[Length[o] >= 1 && VectorQ[o[[1]], NumericQ], offset = N @ o[[1]]];
  {el["text", st, <|"text" -> boxText[content], "position" -> pos[rp@p], "offset" -> offset|>]}];
boxText[(FormBox | StyleBox | TagBox | InterpretationBox)[b_, ___]] := boxText[b];
boxText[s_String] := StringReplace[s, {StartOfString ~~ "\"" ~~ t___ ~~ "\"" ~~ EndOfString :> t}];
boxText[RowBox[l_List]] := StringJoin[boxText /@ l];
boxText[SuperscriptBox[a_, b_]] := boxText[a] <> "^" <> boxText[b];
boxText[SubscriptBox[a_, b_]] := boxText[a] <> "_" <> boxText[b];
boxText[other_] := ToString[other, InputForm];

(* spline surfaces / infinite regions whose original was lost: rebuild the expression *)
walk[BSplineSurface3DBox[cpts_, opts___], st_] := region[st, BSplineSurface[cpts, opts]];
walk[ConicHullRegion3DBox[p_, vs_, ___], st_] := region[st, ConicHullRegion[num@p, num@vs]];

(* ---- regions: everything the kernel can discretize ----
   Torus[c, {R, r}], FilledTorus, Annulus, ... reach the box IR UNCHANGED (the front end knows
   them), and CapsuleShape/Torus[] arrive as InterpretationBox[BSplineSurface3DBox, orig].
   Bounded regions are meshed directly; unbounded ones are clipped to the plot range first. *)
region[st_, r_] := Module[{rr = r, dim, m},
  If[! TrueQ @ Quiet @ RegionQ[rr], Return @ note["region:" <> ToString[Head[r]]]];
  If[! TrueQ @ Quiet @ BoundedRegionQ[rr], rr = Quiet @ RegionIntersection[rr, Cuboid @@ Transpose[$range]]];
  dim = Quiet @ RegionDimension[rr];
  m = Which[
    dim === 3, Quiet @ Check[BoundaryDiscretizeRegion[rr, PrecisionGoal -> 3], $Failed],
    dim === 2 || dim === 1, Quiet @ Check[DiscretizeRegion[rr, PrecisionGoal -> 3], $Failed],
    True, $Failed];
  If[! (MeshRegionQ[m] || BoundaryMeshRegionQ[m]), m = Quiet @ Check[DiscretizeGraphics[Graphics3D[r]], $Failed]];
  If[! (MeshRegionQ[m] || BoundaryMeshRegionQ[m]), Return @ note["region:" <> ToString[Head[r]]]];
  Which[
    MeshCellCount[m, 2] > 0, {el["mesh", st, <|"coords" -> pos @ MeshCoordinates[m], "faces" -> idx0[First /@ MeshCells[m, 2]]|>]},
    MeshCellCount[m, 1] > 0, {el["line", st, <|"paths" -> (pos[MeshCoordinates[m][[#]]] & /@ (First /@ MeshCells[m, 1]))|>]},
    True, note["region:empty"]]];

walk[r_?(Quiet[RegionQ[#] && RegionEmbeddingDimension[#] === 3] &), st_] := region[st, r];
walk[b_Symbol[___], st_] := note[SymbolName[b]];
walk[other_, st_] := note[ToString[Head[other]]];

(* ---- lighting (documented defaults; directions in ImageScaled convention) ---- *)
imgDir[c_, v_] := <|"type" -> "directional", "color" -> c, "from" -> <|"imageScaled" -> v|>, "to" -> Null|>;
$automaticLighting = {
  <|"type" -> "ambient", "color" -> {0.4, 0.2, 0.2}|>,
  imgDir[{0., 0.18, 0.5}, {2, 0, 2}], imgDir[{0.18, 0.5, 0.18}, {2, 2, 3}], imgDir[{0.5, 0.18, 0.}, {0, 2, 2}]};
$neutralLighting = {
  <|"type" -> "ambient", "color" -> {0.35, 0.35, 0.35}|>,
  imgDir[{0.6, 0.6, 0.6}, {2, 0, 2}], imgDir[{0.6, 0.6, 0.6}, {2, 2, 3}], imgDir[{0.6, 0.6, 0.6}, {0, 2, 2}]};
lightingSpec[Automatic] := $automaticLighting;
lightingSpec["Neutral"] := $neutralLighting;
lightingSpec[None] := {};
lightingSpec[c_?ColorQ] := {<|"type" -> "ambient", "color" -> rgb[c]|>};
lightingSpec[l_List] := DeleteCases[lightSpec /@ l, Null];
lightingSpec[s_String] := (note["Lighting:" <> s]; $neutralLighting);
lightingSpec[_] := $automaticLighting;
(* Light positions: {x,y,z} scene coordinates | Scaled[{..}] fractions of the plot range | ImageScaled[{..}]
   fractions of the DISPLAYED bounding box (x right, y up, z: 0 back .. 1 front), fixed to the camera.
   A lone position shines toward the centre of the bounding box ("to" -> Null). *)
lightPos[ImageScaled[v_]] := <|"imageScaled" -> num[v]|>;
lightPos[Scaled[v_]] := <|"scaled" -> num[v]|>;
lightPos[v_?VectorQ] := <|"scene" -> num[v]|>;
lightPos[_] := Null;
lightSpec[{"Ambient", c_?ColorQ}] := <|"type" -> "ambient", "color" -> rgb[c]|>;
lightSpec[{"Directional", c_?ColorQ, {p_, q_}}] /; lightPos[p] =!= Null && lightPos[q] =!= Null := <|"type" -> "directional", "color" -> rgb[c], "from" -> lightPos[p], "to" -> lightPos[q]|>;
lightSpec[{"Directional", c_?ColorQ, p_}] /; lightPos[p] =!= Null := <|"type" -> "directional", "color" -> rgb[c], "from" -> lightPos[p], "to" -> Null|>;
lightSpec[{"Point", c_?ColorQ, p_, att_ : None}] /; lightPos[p] =!= Null := <|"type" -> "point", "color" -> rgb[c], "from" -> lightPos[p], "attenuation" -> Replace[att, {l_List :> num[l], _ -> Null}]|>;
lightSpec[{"Spot", c_?ColorQ, {p_, t_}, a_, ___}] := <|"type" -> "spot", "color" -> rgb[c], "from" -> lightPos[p], "to" -> lightPos[t], "angle" -> num[a]|>;
lightSpec[c_?ColorQ] := <|"type" -> "ambient", "color" -> rgb[c]|>;
lightSpec[other_] := (note["light:" <> ToString[Head[other]]]; Null);

(* ---- ticks ---- *)
tickList[{min_, max_}] := Module[{t = Quiet @ Check[Charting`ScaledTicks[{Identity, Identity}][min, max, {6, 6}], {}]},
  <|"major" -> Cases[t, {p_?NumericQ, l : Except[_Spacer], ___} :> <|"pos" -> N[p], "label" -> tickLabel[l]|>],
    "minor" -> Cases[t, {p_?NumericQ, _Spacer, ___} :> N[p]]|>];
tickLabel[s_String] := s;
tickLabel[other_] := StringTrim @ ToString[other, OutputForm];

(* ---- the scene ---- *)
optVal[opts_, name_, default_] := Lookup[opts, name, default];

ToScene[g_Graphics3D] := Module[{b, prims, opts, range, axes, ticks, view, elems},
  $unsupported = {};
  b = ToBoxes[g];
  If[! MatchQ[b, _Graphics3DBox], Return[<|"error" -> "not a Graphics3DBox: " <> ToString[Head[b]]|>]];
  prims = b[[1]];
  opts = Association @ Join[Cases[b, (Rule | RuleDelayed)[k_Symbol, v_] :> (k -> v), {2}], Cases[b, (Rule | RuleDelayed)[k_Symbol, v_] :> (k -> v), {1}]];
  range = Quiet @ Check[N @ Charting`get3DPlotRange[g], $Failed];
  If[! MatrixQ[range], range = N @ (PlotRange /. AbsoluteOptions[g, PlotRange])];
  $range = range;
  $q = 10.^(Floor[Log10[Max[Abs[Subtract @@@ range], 10.^-300]]] - 6);
  elems = Block[{$cc = Null}, walk[prims, $defaultStyle]];
  axes = Replace[optVal[opts, Axes, False], {True -> {True, True, True}, False | None -> {False, False, False}, l : {_, _, _} :> TrueQ /@ l, _ -> {False, False, False}}];
  ticks = If[MemberQ[axes, True], tickList /@ range, Null];
  view = <|
    "point" -> num @ Replace[optVal[opts, ViewPoint, {1.3, -2.4, 2}], Except[{_, _, _}] -> {1.3, -2.4, 2}],
    "vertical" -> num @ Replace[optVal[opts, ViewVertical, {0, 0, 1}], Except[{_, _, _}] -> {0, 0, 1}],
    "angle" -> Replace[optVal[opts, ViewAngle, Automatic], {a_?NumericQ :> N[a], _ -> Null}],
    "center" -> Replace[optVal[opts, ViewCenter, Automatic], {c : {_?NumericQ, _?NumericQ, _?NumericQ} :> num[c], _ -> Null}],
    "projection" -> Replace[optVal[opts, ViewProjection, Automatic], {"Orthographic" -> "orthographic", _ -> "perspective"}]|>;
  <|
    "format" -> "dsh-graphics3d/0",
    "range" -> range,
    "boxRatios" -> Replace[optVal[opts, BoxRatios, Automatic], {l : {_, _, _} :> num[l], _ -> Null}],
    "view" -> view,
    "boxed" -> TrueQ @ optVal[opts, Boxed, True],
    "axes" -> axes,
    "ticks" -> ticks,
    "axesLabel" -> Replace[optVal[opts, AxesLabel, None], {None -> Null, l : {_, _, _} :> (Replace[#, {None -> Null, s_ :> ToString[s]}] & /@ l), s_ :> {Null, Null, ToString[s]}}],
    "lighting" -> lightingSpec @ optVal[opts, Lighting, Automatic],
    "background" -> Replace[optVal[opts, Background, None], {c_?ColorQ :> rgb[c], _ -> Null}],
    "imageSize" -> Replace[optVal[opts, ImageSize, Automatic], {n_?NumericQ :> {N[n], Null}, {w_?NumericQ, h_} :> {N[w], Replace[h, {x_?NumericQ :> N[x], _ -> Null}]}, _ -> Null}],
    "elements" -> elems,
    "unsupported" -> DeleteDuplicates[$unsupported]
  |>];
ToScene[Legended[g_, ___]] := ToScene[g];
ToScene[g_Graph] := ToScene[Show[g]];
ToScene[other_] := Module[{g = Quiet @ Check[Graphics3D[other], $Failed]}, If[Head[g] === Graphics3D && FreeQ[ToBoxes[g], $Failed], ToScene[g], <|"error" -> "not Graphics3D"|>]];

ToSceneJSON[g_] := Developer`WriteRawJSONString[ToScene[g], "Compact" -> True];
ExportScene[file_String, g_] := Export[file, ToScene[g], "RawJSON", "Compact" -> True];

End[];
EndPackage[];
