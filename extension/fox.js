// The fox: the create-foxkit mascot (app.html #fox-art, fox.css). This file
// only picks the state; fox.css moves the fox, and with
// prefers-reduced-motion it shows a still pose per state. It shows up at the
// moments that matter, then steps back: during a long run it fades and
// pauses (app.css .stepped-back).
//   idle            breathes, blinks, sways its tail, twitches an ear
//   thinking        looks up and tilts its head, with slow nods
//   working         reads from side to side, with quick nods
//   needs-approval  tilts its head, ears up, looks down-right at the approval
//   success         happy eyes and one hop, then idle
//   error           ears out, head down, tail low, then idle
// The list is FOX_STATES from create-foxkit/fox.
export const STATES = ["idle", "thinking", "working", "success", "error", "needs-approval"];
const STEP_BACK_MS = 8000;
const SETTLE_MS = 2400;
let state = "idle";
let stepBack;
let settle;

/** Fills each .fox placeholder in `root` with the drawing. */
export function draw(root = document) {
  const art = document.getElementById("fox-art");
  for (const el of root.querySelectorAll(".fox:not([data-drawn])")) {
    el.append(art.content.cloneNode(true));
    el.dataset.drawn = "";
  }
}

/**
 * Sets the state of the foxes that follow the run (all but the onboarding one).
 * `ended`: the run is over, so the pose shows once and then the fox rests.
 */
export function setRunState(next, ended = next === "success" || next === "error") {
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
  if (ended) settle = setTimeout(() => setRunState("idle"), SETTLE_MS);
}

export const runState = () => state;

/** Sets one fox on its own, for the onboarding demo. */
export function setFox(el, next) {
  if (STATES.includes(next)) el.dataset.state = next;
}
