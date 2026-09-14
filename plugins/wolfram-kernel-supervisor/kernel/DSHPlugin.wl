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

   Every render goes through evalAndRasterize: the body is evaluated under
   TimeConstrained + Check + an Internal`AddHandler["Message", …] trap (pattern from
   CoreTools/Prelude/PreTracing.wl TraceLoading), then rasterized under its own
   TimeConstrained; any message or timeout means NO rasterization and a structured
   failure. A "DSH-SHOW:" JSON line reports ok, evalMs, rasterMs, totalMs, messages,
   timedOut and errorImage (pink error-box pixels, MathTools ErrorImageQ) so the host
   and the GUI can decide e.g. whether live slider previews are affordable.

   Options: "Resolution" (dpi, 144 = @2x), "Background" (None = transparent PNG | Automatic),
   "TimeLimit" (seconds for the evaluation, default 30; the rasterization gets the same). *)

BeginPackage["DSHPlugin`"];

(* NB: no System` names here — a package symbol spelled like a built-in (e.g. Show) resolves to the built-in. *)

ShowRasterizer::usage = "DSHPlugin`ShowRasterizer[id, expr, opts] rasterizes expr for the chat; Manipulate is made interactive.";
Render::usage = "DSHPlugin`Render[id, values] re-renders a registered Manipulate.";
RunScript::usage = "DSHPlugin`RunScript[path, args] runs a script file inside this kernel.";

Begin["`Private`"];

Options[ShowRasterizer] = {"Resolution" -> 144, "Background" -> None, "TimeLimit" -> 30};
Options[Render] = Options[ShowRasterizer];
SetAttributes[ShowRasterizer, HoldAllComplete];

$manipulates = <||>;

rasterize[expr_, opts_List] := Rasterize[expr,
  Background -> Lookup[opts, "Background", None],
  ImageResolution -> Lookup[opts, "Resolution", 144]];

(* ---- guarded evaluation + rasterization ---- *)

(* One message, as "Symbol::tag: rendered text". *)
messageString[Hold[Message[mn : MessageName[sym_, tag_], args___]]] := Module[{txt = mn},
  If[! StringQ[txt], txt = MessageName[General, tag]];     (* most System messages are defined on General *)
  If[! StringQ[txt], txt = "(no message text)"];
  (* Arguments arrive as HoldCompleteForm[...] wrappers; InputForm them first so the text is one line. *)
  ToString[Unevaluated[mn]] <> ": " <> ToString[StringForm[txt, Sequence @@ Map[argString, {args}]], OutputForm]];
(* Unevaluated as ToString's ARGUMENT (not as a result) formats the held expression without evaluating it. *)
argString[(HoldCompleteForm | HoldForm)[e_]] := ToString[Unevaluated[e], InputForm];
argString[other_] := ToString[other, InputForm];
messageString[other_] := ToString[other, InputForm];

(* Evaluate expr while collecting the messages actually issued, as strings, into msgsVar (a held symbol).
   The "Message" handler sees EVERY message including internally Quiet-ed ones (its printed flag is False
   for all of them inside the sandbox kernel), so it only supplies the rendered text; $MessageList — which
   records issued, non-Quiet messages only — decides which of them count. The handler is installed for
   exactly this evaluation (WithLocalSettings unwinds on Abort too). *)
SetAttributes[withMessageCapture, HoldAll];
withMessageCapture[msgsVar_Symbol, expr_] := Module[{handler, all = {}, n0 = Length[$MessageList], issued, res},
  handler[Hold[m : Message[mn_MessageName, ___], _]] := AppendTo[all, {HoldForm[mn], Hold[m]}];
  handler[___] := Null;
  res = Internal`WithLocalSettings[
    Internal`AddHandler["Message", handler],
    expr,
    Internal`RemoveHandler["Message", handler]];
  issued = Drop[$MessageList, n0];
  msgsVar = Join[msgsVar, DeleteDuplicates[messageString[Last[#]] & /@ Select[all, MemberQ[issued, First[#]] &]]];
  res];

(* MathTools ErrorImageQ: the front end draws failed boxes in pink; >50 such pixels = an error rendered as an image. *)
errorImageQ[img_Image] := Count[Catenate[ImageData[img, "Byte"]], {255, 242, 242} | {255, 242, 242, _} | {255, 89, 89, _}] > 50;
errorImageQ[_] := False;

fail[reason_String, extra_Association : <||>] := Join[<|"ok" -> False, "error" -> reason|>, extra];

(* HoldComplete[body] -> <| ok, image, evalMs, rasterMs, totalMs, messages, timedOut, errorImage |> or a failure. *)
evalAndRasterize[held_HoldComplete, opts_List] := Module[
  {limit = Lookup[opts, "TimeLimit", 30], msgs = {}, evalT, res, rasterT, img, t0 = AbsoluteTime[]},
  {evalT, res} = AbsoluteTiming @ withMessageCapture[msgs,
    Check[TimeConstrained[ReleaseHold[held], limit, $DSHTimedOut], $DSHMessageFailed]];
  Which[
    res === $DSHTimedOut,
      Return @ fail["evaluation exceeded the time limit of " <> ToString[limit] <> " s", <|"timedOut" -> True, "evalMs" -> Round[1000 evalT], "messages" -> msgs|>],
    msgs =!= {} || res === $DSHMessageFailed,
      Return @ fail["evaluation issued messages; nothing was rasterized", <|"evalMs" -> Round[1000 evalT], "messages" -> msgs|>]];
  {rasterT, img} = AbsoluteTiming @ withMessageCapture[msgs,
    Check[TimeConstrained[rasterize[res, opts], limit, $DSHTimedOut], $DSHMessageFailed]];
  Which[
    img === $DSHTimedOut,
      Return @ fail["rasterization exceeded the time limit of " <> ToString[limit] <> " s", <|"timedOut" -> True, "evalMs" -> Round[1000 evalT], "rasterMs" -> Round[1000 rasterT], "messages" -> msgs|>],
    ! ImageQ[img],
      Return @ fail["rasterization failed (" <> ToString[Head[img]] <> ")", <|"evalMs" -> Round[1000 evalT], "rasterMs" -> Round[1000 rasterT], "messages" -> msgs|>]];
  <|"ok" -> True, "image" -> img, "evalMs" -> Round[1000 evalT], "rasterMs" -> Round[1000 rasterT],
    "totalMs" -> Round[1000 (AbsoluteTime[] - t0)], "messages" -> msgs, "timedOut" -> False, "errorImage" -> errorImageQ[img]|>
];

(* Print the DSH-SHOW report line (everything but the image) and return the image or $Failed. *)
emit[r_Association] := (
  Print["DSH-SHOW:" <> Developer`WriteRawJSONString[KeyDrop[r, "image"], "Compact" -> True]];
  If[TrueQ[r["ok"]], r["image"], $Failed]);

(* ---- plain expression ---- *)
ShowRasterizer[id_String, expr_, opts : OptionsPattern[]] := emit @ evalAndRasterize[HoldComplete[expr], Flatten[{opts, Options[ShowRasterizer]}]];

(* ---- Manipulate ---- *)
ShowRasterizer[id_String, Manipulate[body_, controls___], opts : OptionsPattern[]] := Module[
  {specs, held, optList = Flatten[{opts, Options[ShowRasterizer]}], init, json},
  specs = DeleteCases[parseControl /@ Hold /@ Unevaluated[{controls}], $Failed];
  (* Manipulate options (SaveDefinitions -> True, ...) are rules and parse to $Failed: dropped. *)
  If[specs === {}, Return[emit @ evalAndRasterize[HoldComplete[Manipulate[body, controls]], optList]]];
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
  If[MissingQ[m], Return[emit @ fail["no such interactive graphic: " <> id]]];
  If[Length[values] =!= Length[m["specs"]], Return[emit @ fail["wrong number of control values"]]];
  rules = MapThread[controlRule, {m["specs"], values}];
  body = m["body"] /. rules;                                    (* HoldComplete[body'] *)
  emit @ evalAndRasterize[body, Join[extra, m["opts"]]]
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
