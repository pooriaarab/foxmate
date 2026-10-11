// The fox: an original drawing (app.html #fox-art) with five states that
// follow the run. It has no mouth; it shows how it feels with its eyes,
// ears, posture and tail. It shows up at the moments that matter, then
// steps back: during a long run it fades and goes quiet.
//   idle            breathes, blinks, glances around, tilts its head, sways its tail
//   thinking        looks up-left and up-right, tilts its head, drifts in a small circle
//   working         reads left to right, with quick small nods
//   needs-approval  looks down-right at the approval, ears up, leans in
//   done            happy eyes, one hop and a tail flick, then idle
// The eyes follow the pointer while it is on the page.
//
// One requestAnimationFrame loop moves every visible fox. Each part (rig,
// head, ears, eyes, tail) is a spring that chases a target, and small waves
// with random phases sit on top, so no two loops look the same. It writes
// only SVG transform attributes, after it reads every box, so it never
// forces a layout between writes. It stops when the tab is hidden or no
// fox is on screen. prefers-reduced-motion: a still pose per state, no
// loop, no blinks, no pointer tracking.
// The approach (springs plus layered waves, pointer gaze with clamped
// travel) takes ideas from OpenMausBot's mascot (Apache-2.0); no code from
// it is used. fox.css sizes the drawing and swaps the eyes.
export const STATES = ["idle", "thinking", "working", "needs-approval", "done"];
const STEP_BACK_MS = 8000;
const DONE_MS = 2400;
let state = "idle";
let stepBack;
let settle;

/** Fills each .fox placeholder in `root` with the drawing. */
export function draw(root = document) {
  const art = document.getElementById("fox-art");
  for (const el of root.querySelectorAll(".fox:not([data-drawn])")) {
    el.append(art.content.cloneNode(true));
    el.dataset.drawn = "";
    adopt(el);
  }
  wake();
}

/** Sets the state of the foxes that follow the run (all but the onboarding one). */
export function setRunState(next) {
  if (!STATES.includes(next) || next === state) return;
  state = next;
  clearTimeout(stepBack);
  clearTimeout(settle);
  for (const el of document.querySelectorAll(".fox[data-follow]")) {
    el.dataset.state = next;
    el.classList.remove("stepped-back");
  }
  document.getElementById("presence").dataset.state = next;
  // A long run: the fox steps back until something needs the user.
  if (next === "working" || next === "thinking") stepBack = setTimeout(() => {
    for (const el of document.querySelectorAll(".fox[data-follow]")) el.classList.add("stepped-back");
  }, STEP_BACK_MS);
  // Done celebrates once, then rests.
  if (next === "done") settle = setTimeout(() => setRunState("idle"), DONE_MS);
  wake();
}

export const runState = () => state;

/** Sets one fox on its own, for the onboarding demo. */
export function setFox(el, next) {
  if (STATES.includes(next)) el.dataset.state = next;
  wake();
}

// ---- motion ---------------------------------------------------------------

const still = matchMedia("(prefers-reduced-motion: reduce)");
const rigs = new Map();
const pointer = { x: 0, y: 0, on: false, at: 0, moved: false };
let frame = 0;
let last = 0;
let ticks = 0;
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const r = rigs.get(e.target);
    if (r) r.visible = e.isIntersecting;
  }
  wake();
});

const rand = (a, b) => a + Math.random() * (b - a);
const wave = (t, period, phase = 0) => Math.sin((t / period) * Math.PI * 2 + phase);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f = (n) => n.toFixed(2);

// Stiffness and damping per channel. Below critical damping it overshoots a
// little, which reads as weight: the head and the tail settle, the eyes snap.
const SPRINGS = {
  gx: [260, 30], gy: [260, 30],
  tilt: [55, 9], hx: [70, 13], hy: [90, 15],
  rx: [60, 12], ry: [80, 14],
  tail: [45, 6], earL: [240, 13], earR: [240, 13],
};

// The still pose of each state, for prefers-reduced-motion and as the
// resting target the springs chase. Units: viewBox (the fox is 100 wide)
// and degrees. gx/gy move the eyes; tilt turns the head; rx/ry move the
// whole fox; earL > 0 and earR < 0 stand the ears up.
const POSE = {
  idle: {},
  thinking: { gx: 2, gy: -2, tilt: 7, earL: 3, earR: -3, tail: -6 },
  working: { gy: 1.3, earL: 2, earR: -2 },
  "needs-approval": { gx: 2.4, gy: 1.9, tilt: 8, hx: 1, rx: 2, ry: -1.2, earL: 8, earR: -8, tail: -4 },
  done: { tilt: 6, earL: 5, earR: -5, tail: 6 },
};

function adopt(el) {
  const q = (s) => el.querySelector(s);
  const ch = {};
  for (const k of Object.keys(SPRINGS)) ch[k] = { x: 0, v: 0, t: 0 };
  const r = {
    el, ch, state: null, since: 0, visible: false, seed: rand(0, 100),
    next: {}, hold: {}, side: Math.random() < 0.5 ? -1 : 1, blinkAt: 0, blinkStart: -1e9,
    rig: q(".fx-rig"), head: q(".fx-head"), earL: q(".fx-ear-l"), earR: q(".fx-ear-r"),
    eyes: q(".fx-eyes"), open: q(".fx-eyes-open"), nose: q(".fx-nose"), tail: q(".fx-tail"),
    box: null,
  };
  rigs.set(el, r);
  // The 30 px fox in the rail stays still; it is too small to read motion.
  if (el.dataset.size !== "xs") seen.observe(el);
  pose(r);
}

/** Writes the still pose of the fox's state. */
function pose(r) {
  r.state = r.el.dataset.state;
  const p = POSE[r.state] ?? {};
  for (const k of Object.keys(r.ch)) {
    const c = r.ch[k];
    c.x = c.t = p[k] ?? 0;
    c.v = 0;
  }
  render(r, {}, 1);
}

function render(r, w, open) {
  const v = (k) => r.ch[k].x + (w[k] ?? 0);
  r.rig.setAttribute("transform", `translate(${f(v("rx"))} ${f(v("ry"))})`);
  r.head.setAttribute("transform", `translate(${f(v("hx"))} ${f(v("hy"))}) rotate(${f(v("tilt"))} 50 56)`);
  r.earL.setAttribute("transform", `rotate(${f(v("earL"))} 33 32)`);
  r.earR.setAttribute("transform", `rotate(${f(v("earR"))} 67 32)`);
  r.tail.setAttribute("transform", `rotate(${f(v("tail"))} 62 86)`);
  const gx = v("gx");
  const gy = v("gy");
  r.eyes.setAttribute("transform", `translate(${f(gx)} ${f(gy)})`);
  // The nose moves less than the eyes, so the face seems to turn.
  r.nose.setAttribute("transform", `translate(${f(gx * 0.45)} ${f(gy * 0.3)})`);
  r.open.setAttribute("transform", open === 1 ? "" : `translate(0 40) scale(1 ${open.toFixed(3)}) translate(0 -40)`);
}

const animating = () => !still.matches && !document.hidden;

/** Starts the loop when a fox is on screen and motion is allowed. */
function wake() {
  if (!animating()) {
    cancelAnimationFrame(frame);
    frame = 0;
    for (const r of rigs.values()) if (r.state !== r.el.dataset.state || still.matches) pose(r);
    return;
  }
  for (const r of rigs.values()) if (!r.visible && r.state !== r.el.dataset.state) pose(r);
  if (!frame && [...rigs.values()].some((r) => r.visible)) {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

function tick(now) {
  frame = 0;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ticks++;
  const live = [];
  for (const r of rigs.values()) {
    if (!r.el.isConnected) { seen.unobserve(r.el); rigs.delete(r.el); continue; }
    if (r.visible) live.push(r);
  }
  if (!live.length || !animating()) return;
  // Reads first: the boxes, only while the pointer is in use.
  const tracking = pointer.on && now - pointer.at < 4000;
  if (tracking && (pointer.moved || ticks % 30 === 0)) {
    for (const r of live) r.box = r.el.getBoundingClientRect();
    pointer.moved = false;
  }
  // Then writes.
  for (const r of live) step(r, now, dt, tracking);
  frame = requestAnimationFrame(tick);
}

function enter(r, now) {
  r.state = r.el.dataset.state;
  r.since = now;
  r.next = {};
  r.hold = {};
  const p = POSE[r.state] ?? {};
  for (const k of Object.keys(r.ch)) r.ch[k].t = p[k] ?? 0;
  // A small push on entry, so the change of state reads as a reaction.
  if (r.state === "needs-approval") { r.ch.earL.v += 60; r.ch.earR.v -= 60; r.ch.ry.v -= 20; }
  if (r.state === "thinking") r.ch.tilt.v += r.side * 30;
  if (r.state === "done") r.ch.tail.v -= 260;
}

const due = (r, key, now) => now >= (r.next[key] ?? 0);

function step(r, now, dt, tracking) {
  if (r.state !== r.el.dataset.state) enter(r, now);
  const t = now / 1000 + r.seed;
  const e = now - r.since;
  const c = r.ch;
  const w = {};
  const s = r.el.classList.contains("stepped-back") ? 0.35 : 1;
  let follow = 0.35;

  switch (r.state) {
    case "idle": {
      follow = 1;
      if (due(r, "glance", now)) {
        const center = Math.random() < 0.4;
        c.gx.t = center ? 0 : rand(-2.3, 2.3);
        c.gy.t = center ? 0 : rand(-1.6, 1.3);
        r.next.glance = now + rand(900, 3200);
      }
      if (due(r, "tilt", now)) {
        if (c.tilt.t === 0) {
          const dir = c.gx.t ? Math.sign(c.gx.t) : r.side;
          c.tilt.t = dir * rand(6, 10);
          r.next.tilt = now + rand(1200, 2600);
        } else {
          c.tilt.t = 0;
          r.next.tilt = now + rand(2500, 6500);
        }
      }
      twitch(r, now, 4000, 9000, 0);
      w.ry = 0.7 * wave(t, 3.8);
      w.hy = 0.35 * wave(t, 3.8, -0.7);
      w.rx = 0.4 * wave(t, 5.3, 1);
      w.tail = 6 * wave(t, 3.4) + 2 * wave(t, 1.9, 1);
      break;
    }
    case "thinking": {
      if (due(r, "glance", now)) {
        r.side = -r.side;
        c.gx.t = r.side * rand(1.8, 2.4);
        c.gy.t = rand(-2.2, -1.6);
        c.tilt.t = r.side * rand(6, 9);
        r.next.glance = now + rand(1400, 2600);
      }
      twitch(r, now, 1800, 3800, 3);
      w.hx = 1.6 * wave(t, 3.4, Math.PI / 2);
      w.hy = 1.6 * wave(t, 3.4);
      w.ry = 0.5 * wave(t, 3.8);
      w.tail = 3 * wave(t, 2.2);
      break;
    }
    case "working": {
      // Reading: a slow sweep to the right in small steps, then a quick return.
      r.hold.line ??= rand(1.6, 2.4);
      r.hold.p = (r.hold.p ?? 0) + dt / r.hold.line;
      if (r.hold.p >= 1) { r.hold.p -= 1; r.hold.line = rand(1.6, 2.4); }
      const p = r.hold.p;
      const sweep = p < 0.85 ? p / 0.85 : 1 - (p - 0.85) / 0.15;
      c.gx.t = -2.2 + 4.4 * (Math.floor(sweep * 6) / 6 + 0.04 * Math.sin(p * 40));
      c.gy.t = 1.3 + 0.25 * wave(t, 7);
      c.tilt.t = c.gx.t * 0.8;
      w.hy = 0.75 * Math.max(0, wave(t, 0.62));
      w.tilt = 1.2 * wave(t, 1.24, 0.5);
      w.ry = 0.35 * wave(t, 0.62, 0.9);
      w.tail = 8 * wave(t, 0.9);
      break;
    }
    case "needs-approval": {
      // Mostly on the approval; now and then a look back at the user.
      if (due(r, "glance", now)) {
        const back = r.hold.back = !r.hold.back && e > 1500;
        c.gx.t = back ? 0 : rand(2.1, 2.6);
        c.gy.t = back ? -0.3 : rand(1.6, 2.1);
        r.next.glance = now + (back ? rand(500, 800) : rand(2200, 4000));
      }
      w.tilt = 1.5 * wave(t, 2.8);
      w.rx = 0.5 * wave(t, 2.8, 1.2);
      w.tail = 4 * wave(t, 1.6);
      break;
    }
    case "done": {
      follow = 1;
      // Crouch, one hop (translate, never scale), a small landing dip.
      if (e < 90) w.ry = 1.5 * (e / 90);
      else if (e < 590) { const u = (e - 90) / 500; w.ry = 1.5 * (1 - u) - 10 * Math.sin(Math.PI * u); }
      else if (e < 900) w.ry = 0.8 * Math.sin((Math.PI * (e - 590)) / 310);
      c.tail.t = e > 60 && e < 320 ? -24 : 6;
      w.tail = e > 900 ? 5 * wave(t, 2.6) : 0;
      w.ry = (w.ry ?? 0) + (e > 900 ? 0.6 * wave(t, 3.8) : 0);
      break;
    }
  }

  // The pointer: the eyes look at it, with clamped travel.
  let gx = c.gx.t;
  let gy = c.gy.t;
  if (tracking && r.box && r.box.width) {
    const dx = pointer.x - (r.box.left + r.box.width / 2);
    const dy = pointer.y - (r.box.top + r.box.height * 0.4);
    const px = clamp((dx / (Math.abs(dx) + 160)) * 2.7, -2.6, 2.6);
    const py = clamp((dy / (Math.abs(dy) + 160)) * 2.2, -2.1, 2.1);
    gx += (px - gx) * follow;
    gy += (py - gy) * follow;
    if (follow === 1) w.tilt = (w.tilt ?? 0) + px * 1.2;
  }

  for (const k of Object.keys(c)) {
    const ch = c[k];
    const target = k === "gx" ? gx : k === "gy" ? gy : ch.t;
    const [stiff, damp] = SPRINGS[k];
    ch.v += (stiff * (target - ch.x) - damp * ch.v) * dt;
    ch.x += ch.v * dt;
  }
  for (const k of Object.keys(w)) w[k] *= s;
  render(r, w, r.state === "done" ? 1 : blink(r, now));
}

/** Flicks one ear now and then. `perk` is the resting lift of the ears. */
function twitch(r, now, min, max, perk) {
  const base = POSE[r.state] ?? {};
  if (r.hold.ear && now > r.hold.ear) {
    r.ch.earL.t = base.earL ?? 0;
    r.ch.earR.t = base.earR ?? 0;
    r.hold.ear = 0;
  }
  if (!due(r, "ear", now)) return;
  if (r.next.ear) {
    if (Math.random() < 0.5) r.ch.earL.t = -(9 + perk);
    else r.ch.earR.t = 9 + perk;
    r.hold.ear = now + rand(110, 180);
  }
  r.next.ear = now + rand(min, max);
}

/** Eye openness, 1 = open. A blink every 2-6 s, sometimes a double one. */
function blink(r, now) {
  if (now >= r.blinkAt) {
    if (r.blinkAt) r.blinkStart = now;
    const double = Math.random() < 0.18;
    r.blinkAt = now + (double ? 260 : rand(2000, 6000));
  }
  const e = now - r.blinkStart;
  return e < 150 ? 1 - 0.92 * Math.sin((Math.PI * e) / 150) : 1;
}

document.addEventListener("pointermove", (ev) => {
  pointer.x = ev.clientX;
  pointer.y = ev.clientY;
  pointer.on = true;
  pointer.at = performance.now();
  pointer.moved = true;
}, { passive: true });
document.addEventListener("pointerout", (ev) => { if (!ev.relatedTarget) pointer.on = false; });
window.addEventListener("blur", () => { pointer.on = false; });
document.addEventListener("visibilitychange", wake);
still.addEventListener("change", wake);
