"""Record the demo footage from a running Obsidian (vault "Flow-Demo") through the Obsidian CLI.

Every step sends real input (Chrome DevTools Protocol key/mouse events), then screenshots the window
and records overlay metadata (caret, mouse cursor, keys, caption, camera) for the Remotion composition.

usage: python3 capture.py <vault-dir> <out-dir>
"""
import json, os, subprocess, sys, time

VAULT, OUT = sys.argv[1], sys.argv[2]
FRAMES = os.path.join(OUT, "frames")
os.makedirs(FRAMES, exist_ok=True)
OB = ["obsidian", "vault=Flow-Demo"]

def run(*args, timeout=15, tries=4):
    for attempt in range(tries):
        try:
            r = subprocess.run(OB + list(args), capture_output=True, text=True, timeout=timeout)
            return (r.stdout + r.stderr).strip()
        except subprocess.TimeoutExpired:
            print(f"  timeout on {args[0]}, retry {attempt + 1}", flush=True)
    raise RuntimeError(f"obsidian CLI kept timing out: {args}")

def ev(code):
    out = run("eval", "code=" + code)
    return out[3:] if out.startswith("=> ") else out

def cdp(method, params):
    run("dev:cdp", f"method={method}", "params=" + json.dumps(params))

KEYS = {"Enter": ("Enter", 13, "\r"), "Tab": ("Tab", 9, None), "Escape": ("Escape", 27, None), "Backspace": ("Backspace", 8, None),
        "ArrowUp": ("ArrowUp", 38, None), "ArrowDown": ("ArrowDown", 40, None), "End": ("End", 35, None)}
MODS = {"alt": 1, "ctrl": 2, "cmd": 4, "shift": 8}

def key(spec):
    parts = spec.split("+"); name = parts[-1]; m = sum(MODS[p] for p in parts[:-1])
    if name in KEYS: code, vk, text = KEYS[name]
    else: code, vk, text = "Key" + name.upper(), ord(name.upper()), name
    p = {"type": "keyDown", "key": name, "code": code, "windowsVirtualKeyCode": vk, "modifiers": m}
    if text and not m & 6: p["text"] = text
    cdp("Input.dispatchKeyEvent", p)
    cdp("Input.dispatchKeyEvent", {"type": "keyUp", "key": name, "code": code, "windowsVirtualKeyCode": vk, "modifiers": m})

def char(ch):
    cdp("Input.dispatchKeyEvent", {"type": "keyDown", "key": ch, "text": ch})
    cdp("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})

VIEW = "app.workspace.activeLeaf.view.contentEl"
def rect(expr):
    r = ev(f"(()=>{{const e={expr};if(!e)return 'null';const r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.width,r.height])}})()")
    return json.loads(r)
def row(text):
    return f"[...{VIEW}.querySelectorAll('.flow-text')].find(e=>e.textContent.trim().startsWith({json.dumps(text)}))"
def bullet(text):
    return row(text) + ".parentElement.querySelector('.flow-bullet')"

CARET = """(()=>{const a=document.activeElement;if(!a||!a.classList.contains('flow-editable'))return 'null';
const s=getSelection();if(!s.rangeCount)return 'null';const r=s.getRangeAt(0).cloneRange();r.collapse(false);
let rs=r.getClientRects();let b=rs.length?rs[rs.length-1]:null;const lh=parseFloat(getComputedStyle(a).lineHeight)||24;
if(!b||!b.height){const e=a.getBoundingClientRect();return JSON.stringify({x:e.left,y:e.top+(lh-lh*0.8)/2,h:lh*0.8})}
return JSON.stringify({x:b.left,y:b.top,h:b.height})})()"""

shots = []
state = {"cursor": None, "caption": None, "scene": None, "cam": {"s": 1, "x": 720, "y": 405}}

def shot(dur, keys=None, click=False, caret=True, move=False, wait=0.12):
    i = len(shots)
    png = os.path.join(FRAMES, f"{i:04d}.png")
    jpg = os.path.join(FRAMES, f"{i:04d}.jpg")
    time.sleep(wait)
    while not os.path.exists(png):
        run("dev:screenshot", "path=" + png)
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "88", png, "--out", jpg], capture_output=True)
    os.remove(png)
    c = json.loads(ev(CARET)) if caret else None
    shots.append({"src": f"frames/{i:04d}.jpg", "dur": dur, "keys": keys, "click": click, "move": move,
                  "cursor": state["cursor"], "caret": c, "caption": state["caption"], "scene": state["scene"],
                  "cam": dict(state["cam"])})
    print(f"shot {i:3d} {state['scene']:<10} dur={dur:<3} keys={keys}", flush=True)

def scene(name, caption, cam=None):
    state["scene"], state["caption"] = name, caption
    state["cam"] = cam or {"s": 1, "x": 720, "y": 405}

def move_to(x, y, dur=16):
    """Animate the cursor to (x, y): hover there for real, then a shot whose overlay glides the cursor in."""
    cdp("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    state["cursor"] = {"x": x, "y": y}
    shot(dur, move=True)

def click_at(x, y, dur=18, keys=None, wait=0.12):
    move_to(x, y)
    for t in ("mousePressed", "mouseReleased"):
        cdp("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1})
    shot(dur, click=True, keys=keys, wait=wait)

def press(spec, label, dur=22):
    key(spec)
    shot(dur, keys=label)

def type_text(text, per=3):
    for ch in text:
        char(ch)
        shot(per)

def end_of(text):
    """A point just right of the item's text: clicking there puts the caret at the end."""
    r = json.loads(ev(f"(()=>{{const e={row(text)};const r=document.createRange();r.selectNodeContents(e);const b=r.getBoundingClientRect();return JSON.stringify([b.right+14,b.top+b.height/2])}})()"))
    return r[0], r[1]

def center_cam(expr, s, dx=260, dy=0):
    r = rect(expr)
    return {"s": s, "x": r[0] + dx, "y": r[1] + r[3] / 2 + dy}

# ---------------------------------------------------------------- scenes
ev("(()=>{document.activeElement&&document.activeElement.blur();return 1})()")
cdp("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 1300, "y": 700})
state["cursor"] = {"x": 1300, "y": 700}

scene("intro", "One infinite outline, right inside Obsidian")
shot(75, caret=False)

# collapse with Cmd-Up
scene("collapse", "⌘↑ / ⌘↓ collapse and expand", center_cam(row("Work"), 1.25))
x, y = end_of("Work"); click_at(x, y, dur=14)
press("cmd+ArrowUp", ["⌘", "↑"], dur=28)
x, y = end_of("Reading list"); click_at(x, y, dur=10)
press("cmd+ArrowUp", ["⌘", "↑"], dur=30)

# typing
scene("typing", "Enter for a new bullet, Tab to nest", center_cam(row("Ideas"), 1.4, dx=230, dy=70))
x, y = end_of("Ideas #inbox"); click_at(x, y, dur=12)
press("Enter", ["↵"], dur=10); press("Tab", ["⇥"], dur=10)
type_text("Learn to bake sourdough")
press("Enter", ["↵"], dur=8); press("Tab", ["⇥"], dur=10)
type_text("Find a starter")
press("Enter", ["↵"], dur=8)
type_text("Bake on Sunday morning")
shot(24)

# complete
scene("complete", "⌘↵ completes an item", center_cam(row("Book flights"), 1.35))
x, y = end_of("Book flights"); click_at(x, y, dur=12)
press("cmd+Enter", ["⌘", "↵"], dur=40)

# drag
scene("drag", "Drag any bullet to reorganize", center_cam(row("Tokyo"), 1.35))
b = rect(bullet("Kyoto")); t = rect(row("Tokyo"))
bx, by = b[0] + b[2] / 2, b[1] + b[3] / 2
move_to(bx, by, dur=16)
cdp("Input.dispatchMouseEvent", {"type": "mousePressed", "x": bx, "y": by, "button": "left", "clickCount": 1})
tx, ty = t[0] + 40, t[1] + 4
for i in range(1, 7):
    px, py = bx + (tx - bx) * i / 6, by + (ty - by) * i / 6
    cdp("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": px, "y": py, "button": "left", "buttons": 1})
    state["cursor"] = {"x": px, "y": py}
    shot(4 if i < 6 else 18)
cdp("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1})
shot(36)

# zoom
scene("zoom", "Click any bullet to zoom in")
b = rect(bullet("Trip to Japan"))
click_at(b[0] + b[2] / 2, b[1] + b[3] / 2, dur=50, wait=0.45)

# links (inside the zoom)
scene("links", "[[ links any note in your vault", center_cam(row("Fushimi"), 1.35))
x, y = end_of("Fushimi Inari at sunrise"); click_at(x, y, dur=10)
press("Enter", ["↵"], dur=8)
type_text("Notes in [[Kyo")
shot(30)
press("Enter", ["↵"], dur=14)
cdp("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 1100, "y": 600})
state["cursor"] = {"x": 1100, "y": 600}
ev("(()=>{const v=app.workspace.activeLeaf.view;v.clearSelection&&v.clearSelection();document.activeElement.blur();return 1})()")
shot(36, caret=False, move=True)

# breadcrumbs
scene("crumbs", "Breadcrumbs take you back out")
c = rect(f"{VIEW}.querySelector('.flow-crumb')")
click_at(c[0] + c[2] / 2, c[1] + c[3] / 2, dur=40, wait=0.45)

# search
scene("search", "Search filters the whole outline as you type")
s = rect(f"{VIEW}.querySelector('.flow-search-input')")
click_at(s[0] + 60, s[1] + s[3] / 2, dur=8)
for ch in "kyoto":
    char(ch); shot(5, caret=False)
shot(60, caret=False)
key("Escape"); key("Escape")
ev("(()=>{document.activeElement&&document.activeElement.blur();return 1})()")
state["cursor"] = None

scene("final", "")
shot(20, caret=False)

time.sleep(1.0)
md = open(os.path.join(VAULT, "Outline.md")).read()
json.dump({"width": 1440, "height": 810, "shots": shots, "markdown": md}, open(os.path.join(OUT, "shots.json"), "w"), indent=1, ensure_ascii=False)
print("done:", len(shots), "shots,", sum(s["dur"] for s in shots), "frames")
