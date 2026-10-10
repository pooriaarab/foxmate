// Push to talk in Chat (foxvoice). Hold the button, or Space on it, while
// you speak. Whisper runs in this page with only: ["browser"], so the audio
// and its text stay on this computer in both modes (VO2). The words fill the
// goal box; Run stays your click (VO1). "Speak the result" is off by default (VO5).
import { createVoice, speak } from "foxvoice";

const $ = (id) => document.getElementById(id);
const MIC_ERRORS = new Set(["mic_denied", "no_microphone", "mic_busy", "unsupported"]);
const TEXT = { idle: "", listening: "Listening. Let go to stop.", transcribing: "Turning speech into text on this computer…", speaking: "Speaking the result." };
let voice;
let held = false;
let progress;
const spoken = new WeakSet();

function status(state, text = TEXT[state] ?? "") {
  $("voice-status").dataset.state = state;
  $("voice-status").textContent = text;
}

async function ready() {
  // Whisper lives in browser-model.js with the other in-browser models. It loads on the first press.
  const { whisper } = await import("./browser-model.js");
  voice ??= createVoice({ stt: [whisper()], only: ["browser"] });
  voice.on("state", (state) => {
    $("talk").classList.toggle("on", state === "listening");
    status(state);
    clearInterval(progress);
    if (state === "transcribing") {
      progress = setInterval(() => {
        const model = voice.status()[0];
        if (model?.state === "loading") status("transcribing", `Downloading the speech model once: ${Math.round((model.progress ?? 0) * 100)} %`);
      }, 300);
    }
  });
  return voice;
}

async function start() {
  held = true;
  $("mic-setup").hidden = true;
  const v = voice ?? (await ready());
  if (!held || v.state !== "idle") return;
  try {
    const heard = await v.listen();
    $("goal").value = heard.text;
    $("goal").focus();
    const sure = heard.confidence === undefined || heard.confidence >= 0.5;
    status("heard", `${sure ? "Heard" : "Not sure what I heard"} (${heard.provider}, ${heard.tier}). Check the goal, then press Run.`);
  } catch (error) {
    if (error.code === "aborted") return status("idle");
    status(`error:${error.code}`, error.message);
    if (MIC_ERRORS.has(error.code)) $("mic-setup").hidden = false;
  }
  return undefined;
}

function stop() {
  held = false;
  voice?.stop();
}

export const talk = {
  init() {
    const button = $("talk");
    button.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) button.setPointerCapture(event.pointerId);
      void start();
    });
    for (const name of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(name, stop);
    button.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      void start();
    });
    button.addEventListener("keyup", (event) => event.code === "Space" && stop());
    window.addEventListener("blur", stop);
    $("mic-setup").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("mic.html") }));
  },
  // Chat shows the end of a run first; this speaks that line once, with a voice on this computer.
  message(message) {
    const line = [...document.querySelectorAll("#conversation .end")].at(-1);
    if (!message.end || !line || spoken.has(line) || !$("speak-result").checked) return;
    spoken.add(line);
    status("speaking");
    speak(line.textContent, { localOnly: true }).then(() => status("idle"), (error) => status(`error:${error.code}`, error.message));
  },
};
