// VO1-VO6 (voice): push to talk in Chat. The test gives the sidebar
// foxvoice's WAV microphone: an <audio> element captured with
// mozCaptureStream, no AudioContext, so it plays on a Linux runner with no
// sound card. It is set from outside the add-on; dist-ext/ has no hook.
import { readdirSync } from "node:fs";
import { poll } from "create-foxkit/e2e";
import { JFK, jfk, startHub, wordErrorRate } from "../hub.mjs";
import { saveShot } from "../lib.mjs";

/** Runs in the sidebar: getUserMedia plays the WAV once; model files come from the local hub. */
function useWavMic(b64, hub) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "audio/wav" }));
  window.e2eMic = { calls: 0, tracks: [], ended: Promise.resolve() };
  navigator.mediaDevices.getUserMedia = async () => {
    window.e2eMic.calls += 1;
    const player = new Audio(url);
    window.e2eMic.ended = new Promise((resolve) => player.addEventListener("ended", resolve, { once: true }));
    const stream = player.mozCaptureStream();
    await player.play();
    if (!stream.getAudioTracks().length) await new Promise((resolve) => stream.addEventListener("addtrack", resolve, { once: true }));
    const [track] = stream.getAudioTracks();
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      player.pause();
    };
    window.e2eMic.tracks.push(track);
    return stream;
  };
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => real(typeof input === "string" && input.startsWith("https://huggingface.co/") ? input.replace("https://huggingface.co/", hub) : input, init);
  // Each state of the voice line, for VO5.
  window.e2eVoice = [];
  new MutationObserver(() => window.e2eVoice.push(document.getElementById("voice-status").dataset.state)).observe(document.getElementById("voice-status"), { attributes: true, childList: true });
}

/** The newest tab whose address ends with `suffix`. BiDi sends no navigation events for moz-extension: pages. */
async function findPage(fox, suffix) {
  for (let i = 0; i < 40; i++) {
    for (const p of await fox.browser.pages()) if (await p.evaluate((s) => location.href.endsWith(s), suffix).catch(() => false)) return p;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export default async function voiceCheck({ session, bench, check, record, scripted, finish, runGoal }) {
  const { fox } = session;
  const sidebar = session.sidebar;
  const hub = await startHub();
  try {
    // BiDi cannot bring a moz-extension: page to the front, so the page asks Firefox itself.
    await sidebar.evaluate(async () => browser.tabs.update((await browser.tabs.getCurrent()).id, { active: true }));
    await sidebar.evaluate(useWavMic, (await jfk()).toString("base64"), hub.url);
    // VO1-VO3: hold the button while the file plays, then let go.
    const runs = await sidebar.evaluate(async () => {
      document.getElementById("goal").value = "";
      const talk = document.getElementById("talk");
      talk.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
      while (!window.e2eMic.calls) await new Promise((r) => setTimeout(r, 20));
      await window.e2eMic.ended;
      talk.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
      return document.querySelectorAll("#conversation > li").length;
    });
    const heard = await poll(sidebar, (n) => document.getElementById("goal").value && {
      goal: document.getElementById("goal").value, line: document.getElementById("voice-status").textContent,
      runs: document.querySelectorAll("#conversation > li").length - n, track: window.e2eMic.tracks.at(-1)?.readyState,
    }, runs, 300_000);
    await saveShot(sidebar, "chat-voice");
    record.runs.voice = { heard, hub: hub.requests.length };
    check("VO1 the transcript fills the goal box, and no run starts", { close: true, runs: 0 }, { close: wordErrorRate(JFK, heard.goal) <= 0.1, runs: heard.runs });
    check("VO2 Whisper ran in Firefox, and the model host got no audio", { where: true, posts: 0 }, { where: heard.line.includes("whisper, browser"), posts: hub.requests.filter((r) => !r.startsWith("GET ") && !r.startsWith("OPTIONS ")).length });
    check("VO3 the microphone is off after the user lets go", "ended", heard.track);

    // VO4: the sidebar gets no microphone; the setup page asks Firefox in a tab.
    await sidebar.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("The request is not allowed.", "NotAllowedError"); };
      const talk = document.getElementById("talk");
      talk.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
      setTimeout(() => talk.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true })), 400);
    });
    const offer = await poll(sidebar, () => !document.getElementById("mic-setup").hidden && document.getElementById("mic-setup").textContent);
    await sidebar.evaluate(() => document.getElementById("mic-setup").click());
    const setup = await findPage(fox, "/mic.html");
    await setup?.evaluate(() => document.getElementById("allow").click());
    const allowed = await setup?.evaluate(async () => {
      for (let i = 0; i < 40 && !document.getElementById("result").dataset.state; i++) await new Promise((r) => setTimeout(r, 100));
      return document.getElementById("result").dataset.state;
    });
    check("VO4 a denied microphone offers the setup page, which gets it in a tab", { offer: "Set up the microphone", allowed: "allowed" }, { offer, allowed });
    await setup?.close();

    // VO5: the result is spoken only with the box ticked. Linux runners have no voice: no_voice still shows the call.
    const spoken = async (on) => {
      await sidebar.evaluate((v) => { document.getElementById("speak-result").checked = v; window.e2eVoice.length = 0; }, on);
      const run = await runGoal(session, { url: `${bench.url}/signup/`, goal: "Read the sign-up page.", settings: scripted([{ tool: "snapshot", args: {} }, finish]) });
      await run.page.close();
      await new Promise((r) => setTimeout(r, 500));
      return sidebar.evaluate(() => window.e2eVoice.includes("speaking"));
    };
    check("VO5 the result is spoken only when the box is ticked", { off: false, on: true }, { off: await spoken(false), on: await spoken(true) });
    await sidebar.evaluate(() => { document.getElementById("speak-result").checked = false; });

    check("VO6 dist-ext/ has no sound file", [], readdirSync("dist-ext", { recursive: true }).filter((f) => String(f).endsWith(".wav")));
  } finally {
    await hub.close();
  }
}
