import subprocess, pathlib, tempfile
FONT = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"
# The three verdicts below are real output from
#   echo '{"session_id":"x","last_assistant_message":"..."}' | node plugins/keep-going/scripts/keep-going.mjs claude
# Re-run those before changing them, so the demo keeps showing what the hook does.
OUT = pathlib.Path(tempfile.mkdtemp(prefix="keep-going-demo-"))
OUT.mkdir(parents=True, exist_ok=True)
W, H, PAD, LH, SIZE = 960, 470, 26, 27, 17
BG, DIM, TXT, GREEN, YEL, BLUE = "#0d1117", "#6e7681", "#e6edf3", "#3fb950", "#d29922", "#58a6ff"

# (text, colour). None = blank line.
SCRIPT = [
  ("keep-going — a Stop hook that reviews the turn the agent wanted to end", DIM),
  (None, None),
  ("$ agent stops: \"I drafted the first half of the migration; the second half is missing.\"", TXT),
  ("  keep-going ▸ CONTINUE", YEL),
  ("    blocked: Finish the rest now.", GREEN),
  (None, None),
  ("$ agent stops: \"Should I use Postgres or SQLite for this?\"", TXT),
  ("  keep-going ▸ JUDGE", YEL),
  ("    blocked: Don't ask yet — you can decide this yourself.", GREEN),
  (None, None),
  ("$ agent stops: \"All three tests pass and the changes are committed.\"", TXT),
  ("  keep-going ▸ STOP", BLUE),
  ("    the turn ends.", DIM),
]

def frame(n, lines, cursor=True):
    cmd = ["magick", "-size", f"{W}x{H}", f"xc:{BG}", "-font", FONT, "-pointsize", str(SIZE)]
    y = PAD + LH
    for text, colour in lines:
        if text is not None:
            indent = PAD + (28 if text.startswith("    ") else 0)
            cmd += ["-fill", colour, "-annotate", f"+{indent}+{y}", text.strip()]
        y += LH
    if cursor:
        cmd += ["-fill", TXT, "-annotate", f"+{PAD}+{y}", "▌"]
    cmd.append(str(OUT / f"f{n:03d}.png"))
    subprocess.run(cmd, check=True)

n = 0
shown = []
for entry in SCRIPT:
    shown = shown + [entry]
    frame(n, shown); n += 1
    # Hold on each verdict line so it is readable.
    if entry[1] in (GREEN, BLUE):
        for _ in range(6):
            frame(n, shown); n += 1
# End card: the install line, held.
shown = shown + [(None, None), ("$ npx --yes github:ferdousbhai/keep-going --claude", BLUE)]
for _ in range(14):
    frame(n, shown, cursor=False); n += 1
subprocess.run(
    ["magick", "-delay", "28", "-loop", "0", f"{OUT}/f*.png", "-layers", "Optimize",
     str(pathlib.Path(__file__).resolve().parent.parent / "docs" / "keep-going.gif")],
    check=True)
print(f"{n} frames -> docs/keep-going.gif")
