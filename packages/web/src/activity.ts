// Tells the server when the learner is here and when they leave, so active time can be measured
// (spec, "Time"). Only the comings and goings are sent, and while the learner stays, a mark now
// and then: typing at most every half minute, pointing or scrolling at most every minute.
import type { Sync } from "./sync.js";

type Signal = "focus" | "blur" | "typing" | "away";

const TYPING_EVERY_MS = 30_000;
const PRESENT_EVERY_MS = 60_000;

export function watchActivity(sync: Sync): () => void {
  let here = false;
  let lastSent = 0;
  const send = (signal: Signal) => {
    lastSent = Date.now();
    // A leaving signal must outlive the page being hidden or closed.
    sync.append("activity.signal", { signal }, { attempts: 1, keepalive: signal === "away" || signal === "blur" }).catch(() => {});
  };
  const arrive = (signal: "focus" | "typing", every: number) => {
    if (document.visibilityState !== "visible") return;
    if (!here) {
      here = true;
      send(signal);
    } else if (Date.now() - lastSent >= every) send(signal);
  };
  const leave = (signal: "blur" | "away") => {
    if (!here) return;
    here = false;
    send(signal);
  };

  const onFocus = () => arrive("focus", 0);
  const onBlur = () => leave("blur");
  const onVisibility = () => (document.visibilityState === "visible" ? arrive("focus", 0) : leave("away"));
  const onKey = () => arrive("typing", TYPING_EVERY_MS);
  const onPresent = () => arrive("focus", PRESENT_EVERY_MS);
  const onHide = () => leave("away");

  const opts = { capture: true, passive: true } as const;
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", onKey, opts);
  document.addEventListener("pointerdown", onPresent, opts);
  document.addEventListener("pointermove", onPresent, opts);
  document.addEventListener("wheel", onPresent, opts);
  document.addEventListener("scroll", onPresent, opts);
  document.addEventListener("touchstart", onPresent, opts);
  if (document.visibilityState === "visible") arrive("focus", 0);

  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("keydown", onKey, opts);
    document.removeEventListener("pointerdown", onPresent, opts);
    document.removeEventListener("pointermove", onPresent, opts);
    document.removeEventListener("wheel", onPresent, opts);
    document.removeEventListener("scroll", onPresent, opts);
    document.removeEventListener("touchstart", onPresent, opts);
  };
}
