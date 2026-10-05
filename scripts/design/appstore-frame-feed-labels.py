#!/usr/bin/env python3
"""appstore-frame-feed-labels — the offline gate for the App Store artwork's feed captions.

WHY THIS EXISTS (2026-10-05). `src/lib/workouts.ts` made a card's thumb captions
VIEWER-RELATIVE (PR #52, master 676ef31): `feedThumbLabels(isMine)` returns
`YOU` / `YOUR SPOT` for the viewer's own log and `THEM` / `THEIR SPOT` for a co-member's.
The App Store artwork is *generated*, not exported — `/home/team/shared/design/
appstore-listing/screenshots/shots.py` draws every string with PIL — and it still
hardcoded `"YOU" if i == 0 else "YOUR SPOT"` for EVERY card, so frames 05 and 08 drew a
caption on Alex's and Jordan's cards that the shipping app can never draw. The app-side
gate for the app half of that fix is `scripts/smoke/signout-feed-labels-guard.cjs`; this
is the gate for the half that lives in the artwork generator, which has no version
control of its own (design/ is not a git repo), so the gate lives here, next to the
module that is the source of truth.

WHY IT RENDERS INSTEAD OF GREPPING. "What caption does this card draw?" is a fact about
the drawing, not about the text of the source: the generator draws a *derived* value
(`(THUMB_LABELS_MINE if owner else THUMB_LABELS_CO_MEMBER)[i]`), so a grep for `YOU`
cannot tell you whether the card it lands on is the viewer's or a co-member's. So this
gate execs the real generator with `ImageDraw.Draw` replaced by a recorder and
`Image.save` replaced by a no-op — it NEVER writes a frame — runs the nine frame
functions, and asserts on the calls that were actually made. Static AST checks are used
where the question IS about a declaration (the label literals, and each call site's
`owner=` argument).

WHAT IT PROVES
  1  the app's `FEED_THUMB_LABELS` is exactly the pair this gate asserts, in both
     directions — the independent copy a gate needs, because a gate that reads its
     expectations out of the code it is checking can never fail;
  2  the generator's label tuples are exactly that pair, and a label literal appears
     nowhere else in the generator except one documented exemption: the practice-camera
     stage in frame 02 draws a literal `YOU / YOUR SPOT` (PracticeCamStep.tsx:446,455) —
     a DIFFERENT surface, always the viewer's own practice shot, correct there;
  3  frames 05 and 08 draw, for every card: the viewer's own card `YOU` / `YOUR SPOT`,
     a co-member's card `THEM` / `THEIR SPOT`. Expectations come from the call sites'
     own `owner=` flags; actuals come from the recorded draw calls;
  4  the label class is confined to those two frames — no other frame draws a white
     26px thumb caption, so "only 05 and 08 change" stays true;
  5  geometry is unmoved: every label call's (x, y, font size, ink) is identical to the
     pre-fix generator's and only the STRINGS differ — the geometry-key method, so an
     artwork pass that moved a caption fails here;
  6  NEGATIVE CONTROL, in-file and end-to-end: the same analyser is pointed at the
     pre-fix generator (`before-feedlabels-2026-10-05/shots.py.pre`, which regenerates
     the nine checked-in PNGs byte-for-byte) and the label check MUST fail on it,
     reporting the co-member card that claims YOU. Captured by hand, without a pipe:
       python3 scripts/design/appstore-frame-feed-labels.py --pre <pre-fix file>; echo "exit=$?"

NOT covered (so a green run is not read as more than it is): the pixels. This gate reads
draw CALLS, it does not read an image and it never writes one. The byte-level proof that
only 05 and 08 changed, and the visual check, are in
/home/team/shared/frames-05-08-feed-labels-2026-10-05.md.

Also NOT wired into scripts/real-mode-smoke/run_smoke.py on purpose: the artwork tree it
drives lives outside this repository, so a fresh clone could not run it. It refuses to
report PASS when it cannot run — exit 2, never 0.

RUN:  python3 scripts/design/appstore-frame-feed-labels.py           (exit 1 on any FAIL)
      pip install pillow                                           (the only dependency)
"""
import argparse
import ast
import contextlib
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
WORKOUTS = os.path.join(ROOT, "src", "lib", "workouts.ts")
DEFAULT_GENERATOR = "/home/team/shared/design/appstore-listing/screenshots/shots.py"
DEFAULT_PRE = os.path.join(
    os.path.dirname(DEFAULT_GENERATOR), "before-feedlabels-2026-10-05", "shots.py.pre"
)
# The gate's OWN expectations, written out here — never read from the code under test:
# if the product copy changes on purpose this file must be updated with it. Same
# precedent and same reason as EXPECTED_FEED_LABELS in
# scripts/smoke/signout-feed-labels-guard.cjs:584-587.
EXPECTED = {"mine": ("YOU", "YOUR SPOT"), "coMember": ("THEM", "THEIR SPOT")}
# The label call's fingerprint inside feed_card(): FB(26) with the white thumb ink.
# Frame 02's practice stage uses the same ink at FB(28) and is excluded by the size.
LABEL_SIZE = 26
LABEL_INK = (255, 255, 255, 235)
CARDS_ONLY_FRAMES = ("05", "08")
LABEL_CONSTANTS = ("THUMB_LABELS_MINE", "THUMB_LABELS_CO_MEMBER")
ALL_LABELS = set(EXPECTED["mine"]) | set(EXPECTED["coMember"])
# The one frame function whose literal labels are a different surface and stay.
EXEMPT_FRAME_FN = "shot02"

passes = 0
fails = 0
FIXED_STRING_CHANGE = "%s -> %s" % (EXPECTED["mine"], EXPECTED["coMember"])


def check(name, ok, detail=""):
    global passes, fails
    if ok:
        passes += 1
    else:
        fails += 1
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, " :: %s" % detail if detail else ""))


def die_env(msg):
    print("FAIL  environment: %s" % msg)
    print("SUMMARY: cannot run — this is NOT a pass")
    sys.exit(2)


# --------------------------------------------------------------------------
# 1. the app module — the source of truth
# --------------------------------------------------------------------------
def app_labels():
    """Read FEED_THUMB_LABELS out of src/lib/workouts.ts without a TS parser: the object
    is a flat literal of four quoted strings, so a shape-checked regex is honest here."""
    src = open(WORKOUTS, encoding="utf-8").read()
    m = re.search(r"FEED_THUMB_LABELS\s*=\s*\{(.*?)\n\}\s*as const", src, re.S)
    if not m:
        return None, None, "FEED_THUMB_LABELS object literal not found in workouts.ts"
    block = m.group(1)
    pairs = {}
    for key in ("mine", "coMember"):
        p = re.search(
            r"%s\s*:\s*\{\s*self\s*:\s*'([^']*)'\s*,\s*spot\s*:\s*'([^']*)'\s*\}" % key, block
        )
        if p:
            pairs[key] = (p.group(1), p.group(2))
    if len(pairs) != 2:
        return None, None, "could not read both pairs: %r" % (sorted(pairs),)
    return pairs["mine"], pairs["coMember"], "workouts.ts"


# --------------------------------------------------------------------------
# 2. the generator — literals and call sites (AST, no rendering)
# --------------------------------------------------------------------------
def generator_source(path):
    if not os.path.exists(path):
        die_env("generator not found: %s" % path)
    return open(path, encoding="utf-8").read()


def enclosing_function(tree, node):
    for fn in tree.body:
        if isinstance(fn, ast.FunctionDef) and fn.lineno <= node.lineno <= getattr(fn, "end_lineno", fn.lineno):
            return fn.name
    return "<module>"


def analyse_source(src):
    """(declared tuples, stray label literals with their enclosing function, tree)."""
    tree = ast.parse(src)
    declared = {}
    tuple_child_ids = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            tgt = node.targets[0]
            name = getattr(tgt, "id", None)
            if name in LABEL_CONSTANTS and isinstance(node.value, ast.Tuple):
                declared[name] = tuple(
                    e.value for e in node.value.elts if isinstance(e, ast.Constant)
                )
                for e in node.value.elts:
                    tuple_child_ids.add(id(e))
    strays = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in ALL_LABELS and id(node) not in tuple_child_ids:
                strays.append((node.lineno, enclosing_function(tree, node), node.value))
    return declared, strays, tree


def ast_cards(tree):
    """The feed_card() call sites per frame function, in source order, with each card's
    own viewer flag and name. Read from the CALL SITE, not from the helper, so a helper
    that ignores its argument is caught."""
    out = {}
    for fn in tree.body:
        if not isinstance(fn, ast.FunctionDef) or not fn.name.startswith("shot"):
            continue
        cards = []
        for node in ast.walk(fn):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "feed_card":
                owner = False
                for kw in node.keywords:
                    if kw.arg == "owner" and isinstance(kw.value, ast.Constant):
                        owner = bool(kw.value.value)
                name = None
                for a in node.args:
                    if isinstance(a, ast.Constant) and isinstance(a.value, str):
                        name = a.value
                        break
                cards.append((name, owner, node.lineno))
        if cards:
            out[fn.name] = sorted(cards, key=lambda c: c[2])
    return out


# --------------------------------------------------------------------------
# 3/4/5. what the frames actually DRAW — exec the generator with a recorder
# --------------------------------------------------------------------------
def recorded_label_calls(path):
    """Exec the real generator with ImageDraw.Draw recording and Image.save neutered,
    run all nine frame functions, and return {frame: [(xy, text, size, ink), ...]} for
    the calls matching the label fingerprint. Writes NOTHING to disk."""
    try:
        import PIL.Image
        import PIL.ImageDraw
    except ImportError as exc:  # pragma: no cover - environment, not a verdict
        die_env("Pillow is required (%s). pip install pillow" % exc)

    src = generator_source(path)
    marker = "\nfor fn in (shot01"  # the driver — stripped so frames run one at a time
    if marker not in src:
        die_env("driver marker %r not found in %s" % (marker, path))
    body = src.split(marker)[0]

    real_draw = PIL.ImageDraw.Draw
    real_save = PIL.Image.Image.save
    # Pillow's ImageDraw.Draw is a FACTORY (a function), not the class: subclass the
    # class it hands back, whatever Pillow version this runs on.
    drawer_cls = type(real_draw(PIL.Image.new("RGB", (1, 1))))
    seen = []
    current = {"frame": None}

    class Recorder(drawer_cls):
        def text(self, *args, **kwargs):
            xy = args[0] if args else kwargs.get("xy")
            txt = args[1] if len(args) > 1 else kwargs.get("text")
            ink = kwargs.get("fill", args[2] if len(args) > 2 else None)
            font = kwargs.get("font", args[3] if len(args) > 3 else None)
            if getattr(font, "size", None) == LABEL_SIZE and ink == LABEL_INK:
                seen.append((current["frame"], tuple(xy), txt, LABEL_SIZE, ink))
            return super().text(*args, **kwargs)

    def draw_factory(*a, **k):
        return Recorder(*a, **k)

    ns = {"__name__": "shots_recorder", "__file__": path}
    PIL.ImageDraw.Draw = draw_factory
    PIL.Image.Image.save = lambda self, *a, **k: None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(body, path, "exec"), ns)
            for num in ("01", "02", "03", "04", "05", "06", "07", "08", "09"):
                fn = ns.get("shot%s" % num)
                if fn is None:
                    die_env("shot%s() not found in %s" % (num, path))
                current["frame"] = num
                fn()
    finally:
        PIL.ImageDraw.Draw = real_draw
        PIL.Image.Image.save = real_save

    per_frame = {}
    for frame, xy, txt, size, ink in seen:
        per_frame.setdefault(frame, []).append((xy, txt, size, ink))
    return per_frame


def label_texts(per_frame, frame):
    return [c[1] for c in per_frame.get(frame, [])]


def expected_texts(cards, frame_fn):
    out = []
    for (_name, owner, _ln) in cards.get(frame_fn, []):
        out.extend(EXPECTED["mine"] if owner else EXPECTED["coMember"])
    return out


def compare_to_expectation(path, cards, per_frame, frame):
    """The analyser used for BOTH the fixed tree and the negative control. Returns
    (ok, detail)."""
    fn_name = "shot%s" % frame
    expected = expected_texts(cards, fn_name)
    actual = label_texts(per_frame, frame)
    ok = bool(expected) and actual == expected and len(expected) == 2 * len(cards.get(fn_name, []))
    return ok, "expected=%r actual=%r cards=%r" % (
        expected,
        actual,
        [(n, "owner" if o else "co-member") for (n, o, _l) in cards.get(fn_name, [])],
    )


def main():
    global passes, fails
    ap = argparse.ArgumentParser(description="App Store artwork feed-caption gate")
    ap.add_argument("--generator", default=DEFAULT_GENERATOR, help="shots.py to check")
    ap.add_argument("--pre", default=DEFAULT_PRE, help="pre-fix generator for the negative control")
    args = ap.parse_args()

    print("=== appstore-frame-feed-labels: the artwork draws the app's viewer-relative captions ===")
    print("generator:  %s" % args.generator)
    print("app module: %s" % WORKOUTS)

    # ---------------- 1. the app's pair, both directions ----------------
    mine, co, detail = app_labels()
    if mine is None:
        check("1 app: FEED_THUMB_LABELS reads as the pair this gate asserts", False, detail)
        print("SUMMARY: %d PASS / %d FAIL" % (passes, fails))
        sys.exit(1)
    check(
        "1 app: FEED_THUMB_LABELS is exactly the pair this gate asserts",
        mine == EXPECTED["mine"] and co == EXPECTED["coMember"],
        "mine=%r coMember=%r expected=%r" % (mine, co, EXPECTED),
    )

    # ---------------- 2. the generator's literals ----------------
    src = generator_source(args.generator)
    declared, strays, tree = analyse_source(src)
    check(
        "2 generator: its two label tuples are exactly the app's pairs",
        declared.get(LABEL_CONSTANTS[0]) == EXPECTED["mine"]
        and declared.get(LABEL_CONSTANTS[1]) == EXPECTED["coMember"],
        "declared=%r expected=%r" % (declared, EXPECTED),
    )
    exempted = [(ln, fn, v) for (ln, fn, v) in strays if fn == EXEMPT_FRAME_FN]
    real_strays = [(ln, fn, v) for (ln, fn, v) in strays if fn != EXEMPT_FRAME_FN]
    check(
        "2 generator: a label literal exists ONLY in those tuples (%s is a different surface, exempt)" % EXEMPT_FRAME_FN,
        not real_strays,
        "strays=%r exempted=%r" % (real_strays, exempted),
    )

    # ---------------- what the frames actually draw ----------------
    per_frame = recorded_label_calls(args.generator)
    cards = ast_cards(tree)

    # 4. the label class is confined to the two frames
    check(
        "4 frames: only 05 and 08 draw thumb captions (the changed set cannot widen)",
        set(per_frame) == set(CARDS_ONLY_FRAMES),
        "frames with label calls=%r" % (sorted(per_frame),),
    )

    # 3. per-card expectation vs the recorded calls
    for num in CARDS_ONLY_FRAMES:
        ok, why = compare_to_expectation(args.generator, cards, per_frame, num)
        check("3 frame %s: every card draws the caption its own viewer test implies" % num, ok, why)

    # 3b. the viewer's own card keeps the true claim
    for num in CARDS_ONLY_FRAMES:
        fn_name = "shot%s" % num
        card_list = cards.get(fn_name, [])
        own_idx = next((i for i, (_n, o, _l) in enumerate(card_list) if o), None)
        if own_idx is None:
            check("3 frame %s: has a card for the viewer himself" % num, False, "no owner=True call site")
            continue
        got = label_texts(per_frame, num)[2 * own_idx: 2 * own_idx + 2]
        check(
            "3 frame %s: the viewer's own card (%s) still draws YOU / YOUR SPOT" % (num, card_list[own_idx][0]),
            got == list(EXPECTED["mine"]),
            "got=%r expected=%r" % (got, list(EXPECTED["mine"])),
        )

    # ---------------- 5. geometry unmoved, vs the pre-fix generator ----------------
    have_pre = bool(args.pre) and os.path.exists(args.pre)
    if have_pre:
        pre_frame = recorded_label_calls(args.pre)
        moved = []
        changed = []
        for num in CARDS_ONLY_FRAMES:
            cur, old = per_frame.get(num, []), pre_frame.get(num, [])
            if len(cur) != len(old):
                moved.append("%s: label call count %d -> %d" % (num, len(old), len(cur)))
                continue
            for c, o in zip(cur, old):
                if (c[0], c[2], c[3]) != (o[0], o[2], o[3]):
                    moved.append("%s: %r -> %r" % (num, o, c))
                if c[1] != o[1]:
                    changed.append((num, o[0], o[1], c[1]))
        total = sum(len(per_frame.get(n, [])) for n in CARDS_ONLY_FRAMES)
        check(
            "5 geometry: every label call is unmoved (same x, y, font size, ink) vs the pre-fix generator",
            not moved,
            "moved=%r" % (moved,) if moved else "all %d label calls identical in geometry" % total,
        )
        # Every changed string must be one of the four co-member substitutions, at the
        # exact same coordinate — i.e. the artwork changed captions and nothing else.
        legit = {(EXPECTED["mine"][0], EXPECTED["coMember"][0]),
                 (EXPECTED["mine"][1], EXPECTED["coMember"][1])}
        check(
            "5 strings: the change is exactly the co-member captions, 4 calls per frame, same slots",
            len(changed) == 8 and all((old, new) in legit for (_n, _xy, old, new) in changed),
            "changed=%r" % (["%s @%s: %r -> %r" % c for c in changed],),
        )
    else:
        print("SKIP  5 geometry: no pre-fix generator at %r (pass --pre to enable)" % args.pre)

    # ---------------- 6. negative control ----------------
    if have_pre:
        pre_src = generator_source(args.pre)
        pre_declared, _strays, pre_tree = analyse_source(pre_src)
        pre_frame = recorded_label_calls(args.pre)
        pre_cards = ast_cards(pre_tree)
        fails_on_pre = []
        for num in CARDS_ONLY_FRAMES:
            ok, _why = compare_to_expectation(args.pre, pre_cards, pre_frame, num)
            if not ok:
                fails_on_pre.append(num)
        same_as_fixed = all(
            label_texts(pre_frame, n) == label_texts(per_frame, n) for n in CARDS_ONLY_FRAMES
        )
        check(
            "6 negative control: the SAME analyser FAILS the pre-fix generator (a gate that cannot fail is not a gate)",
            bool(fails_on_pre) and not same_as_fixed,
            "pre-fix frames the label check rejects=%r preFixEqualsFix=%r preFixDeclaresLabelTuples=%r preFix05=%r" % (
                fails_on_pre, same_as_fixed, bool(pre_declared), label_texts(pre_frame, "05")),
        )
    else:
        print("FAIL  6 negative control: pre-fix generator missing at %r" % args.pre)
        fails += 1

    print("SUMMARY: %d PASS / %d FAIL" % (passes, fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
