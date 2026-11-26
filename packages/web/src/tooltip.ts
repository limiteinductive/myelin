// Global styled tooltip portal so Myelin never renders ugly native OS title popups.
// Supports `data-tip="..."` (preferred, reactive-safe) and optional `data-tip-side="top"|"bottom"`,
// and also intercepts any stray native `title="..."` attribute before the browser shows it.

const OPEN_DELAY_MS = 600;
const WARM_DELAY_MS = 180;
const WARM_WINDOW_MS = 220;
const GAP_PX = 8;
const EDGE_MARGIN_PX = 10;

export function installStyledTooltips(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};

  const el = document.createElement("div");
  el.className = "v2-tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  const textEl = document.createElement("span");
  textEl.className = "v2-tooltip-text";
  el.appendChild(textEl);
  document.body.appendChild(el);

  let activeAnchor: HTMLElement | null = null;
  let timer: number | null = null;
  let lastHiddenAt = 0;
  let visible = false;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const readTip = (node: HTMLElement): string => {
    const rawTitle = node.getAttribute("title");
    if (rawTitle !== null) {
      node.removeAttribute("title");
      const trimmed = rawTitle.trim();
      if (trimmed) node.dataset.tip = trimmed;
      else delete node.dataset.tip;
    }
    return (node.dataset.tip ?? "").trim();
  };

  const findAnchor = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const hit = target.closest<HTMLElement>("[data-tip], [title]");
    if (!hit) return null;
    return readTip(hit) ? hit : null;
  };

  const hide = () => {
    clearTimer();
    if (visible) {
      lastHiddenAt = Date.now();
      visible = false;
    }
    activeAnchor = null;
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
  };

  const position = (anchor: HTMLElement, text: string) => {
    textEl.textContent = text;
    el.style.left = "0px";
    el.style.top = "0px";
    // Layout size, not the painted rect: the closed state carries a transform, and a
    // transformed rect would put the centring off by a fraction of a pixel.
    const tipRect = { width: el.offsetWidth, height: el.offsetHeight };
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      hide();
      return;
    }

    const preferred = anchor.dataset.tipSide === "bottom" ? "bottom" : "top";
    const fitsTop = r.top - tipRect.height - GAP_PX >= EDGE_MARGIN_PX;
    const fitsBottom = r.bottom + tipRect.height + GAP_PX <= window.innerHeight - EDGE_MARGIN_PX;
    const side =
      preferred === "bottom"
        ? fitsBottom || !fitsTop
          ? "bottom"
          : "top"
        : fitsTop || !fitsBottom
          ? "top"
          : "bottom";

    const top =
      side === "bottom"
        ? Math.min(window.innerHeight - tipRect.height - EDGE_MARGIN_PX, r.bottom + GAP_PX)
        : Math.max(EDGE_MARGIN_PX, r.top - tipRect.height - GAP_PX);

    const idealLeft = r.left + r.width / 2 - tipRect.width / 2;
    const left = Math.min(
      window.innerWidth - tipRect.width - EDGE_MARGIN_PX,
      Math.max(EDGE_MARGIN_PX, idealLeft),
    );

    el.dataset.side = side;
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  };

  const showNow = (anchor: HTMLElement) => {
    if (!anchor.isConnected) {
      hide();
      return;
    }
    const text = readTip(anchor);
    if (!text) {
      hide();
      return;
    }
    position(anchor, text);
    visible = true;
    el.setAttribute("aria-hidden", "false");
    el.classList.add("is-open");
  };

  const scheduleShow = (anchor: HTMLElement, immediate = false) => {
    if (activeAnchor === anchor && (visible || timer !== null)) return;
    clearTimer();
    activeAnchor = anchor;
    const warm = visible || Date.now() - lastHiddenAt < WARM_WINDOW_MS;
    const delay = immediate ? 0 : warm ? WARM_DELAY_MS : OPEN_DELAY_MS;
    if (delay === 0) {
      showNow(anchor);
    } else {
      timer = window.setTimeout(() => {
        timer = null;
        if (activeAnchor === anchor) showNow(anchor);
      }, delay);
    }
  };

  const onPointerOver = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const anchor = findAnchor(e.target);
    if (!anchor) {
      if (activeAnchor) hide();
      return;
    }
    scheduleShow(anchor);
  };

  const onPointerOut = (e: PointerEvent) => {
    if (!activeAnchor) return;
    const related = e.relatedTarget;
    if (related instanceof Node && activeAnchor.contains(related)) return;
    const nextAnchor = findAnchor(related);
    if (nextAnchor) {
      scheduleShow(nextAnchor);
    } else {
      hide();
    }
  };

  const onFocusIn = (e: FocusEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    // Only show on keyboard focus so clicking a button doesn't leave a sticky tooltip.
    try {
      if (!target.matches(":focus-visible")) return;
    } catch {
      return;
    }
    const anchor = findAnchor(target);
    if (anchor) scheduleShow(anchor, true);
  };

  const onFocusOut = () => {
    hide();
  };

  const onPointerDown = () => {
    hide();
  };

  const onScroll = () => {
    if (activeAnchor || visible) hide();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && (visible || timer !== null)) hide();
  };

  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);
  window.addEventListener("keydown", onKeyDown, true);

  return () => {
    clearTimer();
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    window.removeEventListener("keydown", onKeyDown, true);
    el.remove();
  };
}
