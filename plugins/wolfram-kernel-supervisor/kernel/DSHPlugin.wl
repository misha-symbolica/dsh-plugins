(* ::Package:: *)
(* DSHPlugin` — kernel-side support for the DSH wolfram-kernel-supervisor plugin.
   Loaded once per kernel at bootstrap (Get[...] from kernels.mjs). Everything the
   plugin evaluates on the user's behalf goes through this context:

     DSHPlugin`ShowRasterizer[id, expr, opts]     rasterize expr (held) for wolfram_show. If expr is a
                                        top-level Manipulate with simple control specs, register
                                        it under id, Print a "DSH-MANIPULATE:" JSON descriptor
                                        line, and return the initial frame.
     DSHPlugin`Render[id, values]       re-rasterize a registered Manipulate body with the
                                        control values substituted (slider -> number, setter /
                                        popup -> 0-based choice index, checkbox -> True/False).
     DSHPlugin`RunScript[path, args]    Get a script with $ScriptCommandLine set.

   Options: "Resolution" (dpi, 144 = @2x), "Background" (None = transparent PNG | Automatic). *)

BeginPackage["DSHPlugin`"];

(* NB: no System` names here — a package symbol spelled like a built-in (e.g. Show) resolves to the built-in. *)

ShowRasterizer::usage = "DSHPlugin`ShowRasterizer[id, expr, opts] rasterizes expr for the chat; Manipulate is made interactive.";
Render::usage = "DSHPlugin`Render[id, values] re-renders a registered Manipulate.";
RunScript::usage = "DSHPlugin`RunScript[path, args] runs a script file inside this kernel.";

Begin["`Private`"];

Options[ShowRasterizer] = {"Resolution" -> 144, "Background" -> None};
Options[Render] = Options[ShowRasterizer];
SetAttributes[ShowRasterizer, HoldAllComplete];

$manipulates = <||>;

rasterize[expr_, opts_List] := Rasterize[expr,
  Background -> Lookup[opts, "Background", None],
  ImageResolution -> Lookup[opts, "Resolution", 144]];

(* ---- plain expression ---- *)
ShowRasterizer[id_String, expr_, opts : OptionsPattern[]] := rasterize[expr, Flatten[{opts, Options[ShowRasterizer]}]];

(* ---- Manipulate ---- *)
ShowRasterizer[id_String, Manipulate[body_, controls___], opts : OptionsPattern[]] := Module[
  {specs, held, optList = Flatten[{opts, Options[ShowRasterizer]}], init, json},
  specs = DeleteCases[parseControl /@ Hold /@ Unevaluated[{controls}], $Failed];
  (* Manipulate options (SaveDefinitions -> True, ...) are rules and parse to $Failed: dropped. *)
  If[specs === {}, Return[rasterize[Manipulate[body, controls], optList]]];
  held = HoldComplete[body];
  $manipulates[id] = <|"body" -> held, "specs" -> specs, "opts" -> optList|>;
  init = specs[[All, "init"]];
  json = Developer`WriteRawJSONString[<|
    "id" -> id,
    "controls" -> (KeyDrop[#, {"symbol", "values"}] & /@ specs)
  |>, "Compact" -> True];
  Print["DSH-MANIPULATE:" <> json];
  renderWith[id, init]
];

(* A control spec arrives as Hold[{...}]; return an Association or $Failed (not a control).
   Everything except the variable part is EVALUATED, as Manipulate does: {x, 0, Length[l]},
   {n, Range[10]} and {k, 1, 2 Pi} are all legal. *)
parseControl[Hold[{var_, second_, rest___}]] /; ! MatchQ[Unevaluated[var], _Rule | _RuleDelayed] := Module[
  {e2 = second, erest = {rest}},
  Which[
    NumericQ[e2] && Length[erest] >= 1 && NumericQ[First[erest]],
      sliderSpec[Hold[var], e2, First[erest], Rest[erest]],
    ListQ[e2] && e2 =!= {},
      choiceSpec[Hold[var], Hold[second], e2, erest],
    True, $Failed]
];
parseControl[_] := $Failed;

(* {var} | {{var, init}} | {{var, init, label}} *)
varParts[Hold[{sym_Symbol, init_, label_}]] := {Hold[sym], Hold[init], ToString[Unevaluated[label]]};
varParts[Hold[{sym_Symbol, init_}]] := {Hold[sym], Hold[init], SymbolName[Unevaluated[sym]]};
varParts[Hold[{sym_Symbol}]] := {Hold[sym], Missing[], SymbolName[Unevaluated[sym]]};
varParts[Hold[sym_Symbol]] := {Hold[sym], Missing[], SymbolName[Unevaluated[sym]]};
varParts[_] := $Failed;

sliderSpec[hv_, min_, max_, rest_List] := Module[{parts = varParts[hv], step, init},
  If[parts === $Failed, Return[$Failed]];
  step = FirstCase[rest, s_?NumericQ :> N[s], Null];
  init = Replace[parts[[2]], {Hold[i_?NumericQ] :> N[i], _ :> N[min]}];
  <|"symbol" -> parts[[1]], "name" -> SymbolName @@ parts[[1]], "label" -> parts[[3]],
    "type" -> "slider", "min" -> N[min], "max" -> N[max], "step" -> step,
    "init" -> Clip[init, {N[min], N[max]}]|>
];

choiceSpec[hv_, heldLiteral_Hold, evaluated_List, rest_List] := Module[
  {parts = varParts[hv], vals, labels, init, type, initVal},
  If[parts === $Failed, Return[$Failed]];
  vals = Hold /@ evaluated;                                  (* held EVALUATED choice values *)
  (* Labels: the literal spellings when the spec was a literal list ({Red, Blue}), else InputForm of the values. *)
  labels = If[MatchQ[heldLiteral, Hold[_List]] && Length[heldLiteral[[1]]] === Length[vals],
    List @@ Map[Function[e, ToString[Unevaluated[e], InputForm], HoldAllComplete], heldLiteral[[1]]],
    ToString[#, InputForm] & /@ evaluated];
  type = Which[
    MatchQ[evaluated, {True, False} | {False, True}], "checkbox",
    MatchQ[FirstCase[rest, HoldPattern[ControlType -> t_] :> t], PopupMenu], "popup",
    MatchQ[FirstCase[rest, HoldPattern[ControlType -> t_] :> t], Setter | SetterBar | RadioButtonBar], "setter",
    Length[vals] > 6, "popup",
    True, "setter"];
  initVal = Replace[parts[[2]], {Missing[] :> Missing[], Hold[i_] :> Hold[Evaluate[i]]}];
  init = Replace[initVal, {Missing[] -> 0, h_Hold :> Replace[FirstPosition[vals, h, {1}][[1]] - 1, Except[_Integer] -> 0]}];
  <|"symbol" -> parts[[1]], "name" -> SymbolName @@ parts[[1]], "label" -> parts[[3]],
    "type" -> type, "choices" -> labels, "values" -> vals,
    "init" -> If[type === "checkbox", vals[[init + 1]] === Hold[True], init]|>
];

(* ---- re-render ---- *)
Render[id_String, values_List, opts : OptionsPattern[]] := renderWith[id, values, Flatten[{opts}]];

renderWith[id_String, values_List, extra_List : {}] := Module[{m = $manipulates[id], rules, body},
  If[MissingQ[m], Return[$Failed]];
  If[Length[values] =!= Length[m["specs"]], Return[$Failed]];
  rules = MapThread[controlRule, {m["specs"], values}];
  body = m["body"] /. rules;                                    (* HoldComplete[body'] *)
  rasterize[ReleaseHold[body], Join[extra, m["opts"]]]
];

controlRule[spec_, v_] := With[{sym = spec["symbol"]},
  Switch[spec["type"],
    "slider",   (sym /. Hold[s_] :> (HoldPattern[s] -> Clip[N[v], {spec["min"], spec["max"]}])),
    "checkbox", (sym /. Hold[s_] :> (HoldPattern[s] -> TrueQ[v])),
    _,          With[{c = spec["values"][[Clip[Round[v], {0, Length[spec["values"]] - 1}] + 1]]},
                  sym /. Hold[s_] :> (c /. Hold[val_] :> (HoldPattern[s] :> val))]]
];

(* ---- scripts ---- *)
RunScript[path_String, args_List] := (
  Unprotect[$ScriptCommandLine]; $ScriptCommandLine = Prepend[args, path]; Protect[$ScriptCommandLine];
  Get[path]);

End[];
EndPackage[];
