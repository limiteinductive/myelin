// Sidebar row text: edge fades sized to what is actually hidden, and a calm roll that
// reveals a clipped title after a sustained hover. Plain DOM, no framework state.

/** Hover must hold this long before a clipped title starts to roll. */
export const ROLL_DELAY_MS = 1000;
/** Constant reading speed, so short and long titles travel alike. */
export const ROLL_SPEED_PX_S = 40;
/** Pause on the tail, then at the start before the next pass. */
export const ROLL_HOLD_MS = 1200;
export const ROLL_REST_MS = 1000;
/** Below this the title fits well enough: no fade, no roll. */
export const ROLL_MIN_OVERFLOW_PX = 2;

const FADE_PX = 18;
const RETURN_MS = 260;

const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const easeOut = (p: number) => 1 - (1 - p) ** 3;

function glideBackMs(overflow: number): number {
  return Math.min(900, Math.max(320, (overflow / (ROLL_SPEED_PX_S * 4)) * 1000));
}

/**
 * Leftward offset (px) of a rolling title `elapsedMs` after the roll began:
 * roll out at reading speed, hold on the tail, glide home, rest, repeat.
 */
export function rollOffsetAt(overflow: number, elapsedMs: number): number {
  if (overflow <= ROLL_MIN_OVERFLOW_PX || elapsedMs <= 0) return 0;
  const out = (overflow / ROLL_SPEED_PX_S) * 1000;
  const back = glideBackMs(overflow);
  let t = elapsedMs % (out + ROLL_HOLD_MS + back + ROLL_REST_MS);
  if (t < out) return (overflow * t) / out;
  t -= out;
  if (t < ROLL_HOLD_MS) return overflow;
  t -= ROLL_HOLD_MS;
  if (t < back) return overflow * (1 - easeInOut(t / back));
  return 0;
}

/** Each edge fades only as far as there is text hidden behind it. */
function paint(text: HTMLElement, inner: HTMLElement, x: number, overflow: number): void {
  inner.style.transform = x > 0 ? `translateX(${-x}px)` : "";
  text.style.setProperty("--v2-sb-fade-l", `${Math.min(FADE_PX, Math.max(0, x))}px`);
  text.style.setProperty("--v2-sb-fade-r", `${Math.min(FADE_PX, Math.max(0, overflow - x))}px`);
}

const rolling = new WeakSet<HTMLElement>();

function paintRest(text: HTMLElement): void {
  const inner = text.firstElementChild as HTMLElement | null;
  if (!inner || rolling.has(text)) return;
  const overflow = text.scrollWidth - text.clientWidth;
  paint(text, inner, 0, overflow > ROLL_MIN_OVERFLOW_PX ? overflow : 0);
}

let observer: ResizeObserver | undefined;

/**
 * Ref for a `.v2-sb-text` element (with one inner `.v2-sb-roll` child): keeps the
 * right-edge fade on only while the title is actually clipped.
 */
export function trackSidebarOverflow(text: HTMLElement): void {
  if (typeof ResizeObserver !== "function") return;
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      if (!target.isConnected) {
        observer?.unobserve(target);
        continue;
      }
      const host = target.closest<HTMLElement>(".v2-sb-text");
      if (host) paintRest(host);
    }
  });
  // The box changes with the sidebar and the hover action reserve; the child with the title.
  observer.observe(text);
  if (text.firstElementChild) observer.observe(text.firstElementChild);
}

/**
 * Ref for the sidebar list: after a sustained hover on a row whose title is clipped,
 * roll the title; on leave, cancel at once and glide home.
 */
export function installSidebarRoll(list: HTMLElement): void {
  let host: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let active: { text: HTMLElement; inner: HTMLElement; overflow: number; x: number } | null = null;

  const stop = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    host = null;
    const was = active;
    active = null;
    if (!was) return;
    const { text, inner, overflow, x: from } = was;
    const settle = () => {
      rolling.delete(text);
      inner.style.willChange = "";
      paintRest(text);
    };
    if (from <= 0.5) return settle();
    const t0 = performance.now();
    const home = (now: number) => {
      // A fresh roll on the same row takes over.
      if (active?.text === text) return;
      const p = Math.min(1, (now - t0) / RETURN_MS);
      paint(text, inner, from * (1 - easeOut(p)), overflow);
      if (p < 1) requestAnimationFrame(home);
      else settle();
    };
    requestAnimationFrame(home);
  };

  const begin = () => {
    const text = host?.querySelector<HTMLElement>(".v2-sb-text");
    const inner = text?.firstElementChild as HTMLElement | null | undefined;
    if (!text || !inner || !text.isConnected || rolling.has(text)) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Measured now, mid-hover, so a trailing row action's reserve is already taken out.
    const overflow = text.scrollWidth - text.clientWidth;
    if (overflow <= ROLL_MIN_OVERFLOW_PX) return;
    const roll = { text, inner, overflow, x: 0 };
    active = roll;
    rolling.add(text);
    inner.style.willChange = "transform";
    const t0 = performance.now();
    const step = (now: number) => {
      if (active !== roll) return;
      if (!text.isConnected) return stop();
      roll.x = rollOffsetAt(overflow, now - t0);
      paint(text, inner, roll.x, overflow);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  list.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const target = e.target as Element | null;
    const next = target?.closest?.(".v2-sb-row") ?? target?.closest?.(".v2-sb-item") ?? null;
    if (next === host) return;
    stop();
    if (!next) return;
    host = next;
    timer = setTimeout(begin, ROLL_DELAY_MS);
  });
  list.addEventListener("pointerleave", stop);
  list.addEventListener("pointercancel", stop);
}
