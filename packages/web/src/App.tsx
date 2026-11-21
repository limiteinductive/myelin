// The whole app: the sign-in screen, or the thread with its composer, and at a desk a page beside it.
import { applyRunEvent, clockText, currentRun, groupAsides, passageText, runLeft, uuidv7, type Anchor, type Aside, type PageState, type Run } from "@myelin/core";
import { watchActivity } from "./activity.js";
import { createEffect, createMemo, createSignal, createStore, For, Match, onSettled, Show, Switch } from "solid-js";
import { PageEditor, type EditPayload, type Highlight, type Scope, type SendResult } from "./editor.js";
import { foldPages, pageFacts, pageStatus } from "./pages.js";
import { draft, login, saveKey, SendError, SignInError, Sync, type Draft, type Ev, type Me } from "./sync.js";
import { Body, inline, splitLead } from "./text.js";
import { renderMathText } from "./math.js";
import { inFence, insertFence } from "./fence.js";
import { lineOf, markQuote, quoteText, type Quote } from "./quote.js";
import { current, foldUnits, type UnitView } from "./units.js";
import type { JSX } from "@solidjs/web";

export type Screen = { kind: "loading" } | { kind: "signin"; error?: string } | { kind: "thread"; session: Me };

/** Every button is an icon, named for screen readers by its aria-label (proposal 94). */
const ICONS = {
  send: "M9 14V4M4.5 8.5 9 4l4.5 4.5",
  plus: "M9 4v10M4 9h10",
  code: "M6.5 5 3 9l3.5 4M11.5 5 15 9l-3.5 4",
  page: "M4.75 2.75h5.5l3 3v9.5h-8.5zM10.25 2.75v3h3",
  close: "M4.5 4.5l9 9M13.5 4.5l-9 9",
  reword: "M11.5 3.5l3 3L6 15H3v-3zM9.5 5.5l3 3",
  done: "M3.75 9.5l3.5 3.5 7-7.5",
  open: "M7 4.5l4.5 4.5L7 13.5",
} as const;

const Icon = (props: { name: keyof typeof ICONS }) => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d={ICONS[props.name]} />
  </svg>
);

const isTouch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function App(props: { screen: Screen; go: (s: Screen) => void }) {
  const signin = () => (props.screen.kind === "signin" ? props.screen : null);
  const session = () => (props.screen.kind === "thread" ? props.screen.session : null);
  return (
    <Switch>
      <Match when={signin()}>{(s) => <SignIn error={s().error} go={props.go} />}</Match>
      <Match when={session()} keyed>
        {(me) => <Thread session={me} go={props.go} />}
      </Match>
    </Switch>
  );
}

function SignIn(props: { error?: string | undefined; go: (s: Screen) => void }) {
  const [empty, setEmpty] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let field!: HTMLInputElement;
  const shownError = () => error() ?? props.error ?? null;

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault();
    if (!field.value.trim()) return;
    setBusy(true);
    try {
      props.go({ kind: "thread", session: await login(field.value) });
    } catch (e) {
      // The field keeps what was pasted.
      setError(e instanceof SignInError ? e.message : "Could not reach the server.");
      setBusy(false);
    }
  };

  return (
    <main class="myl-signin">
      <span class="myl-logo" style={{ "font-size": "40px" }}>
        <svg class="myl-logo__mark" viewBox="0 0 96 96" aria-hidden="true">
          <path d="M12 88V56a18 18 0 0 1 36 0M48 88V32a18 18 0 0 1 36 0V88" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round" />
        </svg>
        Myelin
      </span>
      <form class="myl-composer" onSubmit={submit}>
        <div class="myl-composer__row">
          <input
            ref={field}
            class="myl-composer__field"
            type="text"
            aria-label="Invite link"
            placeholder="Paste your invite link"
            autocomplete="off"
            onInput={(e) => setEmpty(e.currentTarget.value.trim() === "")}
          />
          <button type="submit" class="myl-send" aria-label="Sign in" disabled={empty() || busy()}>
            <Icon name="send" />
          </button>
        </div>
      </form>
      <p class={{ "myl-trace": true, "app-warning": Boolean(shownError()) }} role="status">
        {shownError() ?? "Whoever runs this server can make you a link."}
      </p>
    </main>
  );
}

type UnitCard = { kind: "unit"; unit_id: string; how: string; note: string | null };
type PageCard = { kind: "page"; page_id: string };
type TimelineCard = { kind: "timeline"; run_id: string; duration_ms: number; segments: { name: string; ms: number; costly?: boolean; unused?: boolean }[] };
type ChipState = "shown" | "not_yet" | "missed";
type UnitsRow = { unit_id: string; text: string; kind: string; found: string | null; rests_on: string; told: boolean; depths: { depth: string; state: ChipState }[] };
type UnitsTableCard = { kind: "units"; rows: UnitsRow[] };
type Line = {
  id: string;
  author: "learner" | "tutor";
  text: string;
  ts: number;
  trace: string | null;
  units: UnitCard[];
  pages: PageCard[];
  timelines: TimelineCard[];
  tables: UnitsTableCard[];
  anchor: Anchor | null;
  /** The passage of an earlier message this one replies to. */
  quote: Quote | null;
  /** A page the learner opened with the plus button: no message, only its link. */
  opened: boolean;
};
/** A message on its own, or a run of messages in one aside, shown as its passage and then the messages. */
type Item = { id: string; kind: "line"; line: Line } | { id: string; kind: "aside"; aside: Aside; lines: Line[] };

const isUnitCard = (c: { kind: string }): c is UnitCard => c.kind === "unit" && typeof (c as UnitCard).unit_id === "string";
const isPageCard = (c: { kind: string }): c is PageCard => c.kind === "page" && typeof (c as PageCard).page_id === "string";
const isTimelineCard = (c: { kind: string }): c is TimelineCard =>
  c.kind === "timeline" && Array.isArray((c as TimelineCard).segments) && (c as TimelineCard).duration_ms > 0;

const isUnitsTableCard = (c: { kind: string }): c is UnitsTableCard => c.kind === "units" && Array.isArray((c as UnitsTableCard).rows);

const dayLabel = (ts: number, now = Date.now()) => {
  const d = new Date(ts);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(days > 300 ? { year: "numeric" } : {}) });
};

const pagePath = () => location.pathname.match(/^\/page\/([0-9A-Za-z-]{8,64})$/)?.[1] ?? null;

function media(query: string): () => boolean {
  const m = typeof matchMedia === "function" ? matchMedia(query) : null;
  const [get, set] = createSignal(m?.matches ?? false);
  m?.addEventListener("change", (e) => set(e.matches));
  return get;
}

const clip = (s: string, n = 48) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Messages the thread card at the side of a page keeps in view. The rest is in the thread. */
const CARD_MESSAGES = 4;

async function sendEdit(s: Sync, payload: EditPayload, id: string, ts: number): Promise<SendResult> {
  try {
    await s.append("page.edited", { ...payload }, { id, ts, attempts: 1 });
    return "ok";
  } catch (e) {
    if (e instanceof SendError && e.status > 0) return e.stale ? "stale" : "refused";
    return "offline";
  }
}

/** Runs a page's code on the server. The output arrives as a `page.ran` event; this says only if it failed to run. */
async function runPage(pageId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/pages/${encodeURIComponent(pageId)}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.ok) return null;
    if (r.status === 501) return "Code does not run on this server";
    return "The page could not run just now";
  } catch {
    return "The page could not run while offline";
  }
}

function Thread(props: { session: Me; go: (s: Screen) => void }) {
  const [view, setView] = createStore({
    events: [] as Ev[],
    connected: false,
    lost: false,
    ready: false,
    reply: null as Draft | null,
    notice: null as string | null,
  });
  let sync: Sync | null = null;
  let stick = true;
  /** Scrolls the visible thread to its newest message; set by whichever view shows the thread. */
  let toBottom: (() => void) | null = null;

  const narrow = media("(max-width: 959.98px)");
  const coarse = media("(pointer: coarse)");
  /** Pages are read-only on a phone: a touch screen too narrow for the desk. */
  const phone = () => coarse() && narrow();
  const [now, setNow] = createSignal(Date.now());

  // Pages are folded outside the store, as their documents are mutated in place; the tick says when.
  const pageMap: Record<string, PageState> = {};
  let pagesFolded = 0;
  const [pageTick, setPageTick] = createSignal(0);

  const [route, setRoute] = createSignal(pagePath());
  const openPage = (id: string | null) => {
    if (id === route()) return;
    history.pushState(null, "", id ? `/page/${id}` : "/");
    setRoute(id);
    stick = true;
  };
  const shown = createMemo(() => {
    pageTick();
    const id = route();
    return id && view.ready ? (pageMap[id] ?? null) : null;
  });

  let editor: PageEditor | null = null;
  /** Bumped when an editor is made or dropped, and after every change in it. */
  const [edBound, setEdBound] = createSignal(0);
  const [edTick, setEdTick] = createSignal(0);
  const scope = createMemo<Scope | null>(() => {
    edTick();
    edBound();
    shown();
    return editor?.scope() ?? null;
  });

  /** The thread in log order: its messages, and the pages the learner opened. */
  const entries = createMemo<Line[]>(() =>
    view.events.flatMap((e): Line[] => {
      if (e.type === "page.created") {
        const p = e.payload as { page_id: string; probe?: unknown };
        // The tutor's pages are linked from its messages; a learner's page is linked where it was opened.
        if (e.device_id.startsWith("server:") || e.device_id.startsWith("import:") || p.probe) return [];
        return [{ id: e.id, author: "learner", text: "", ts: e.ts, trace: null, units: [], pages: [{ kind: "page", page_id: p.page_id }], timelines: [], tables: [], anchor: null, quote: null, opened: true }];
      }
      if (e.type !== "message.added") return [];
      const p = e.payload as { author: "learner" | "tutor"; text: string; cards: { kind: string; text?: string }[]; anchor?: Anchor | null; quote?: Quote | null };
      const trace = p.cards.find((c) => c.kind === "trace" && typeof c.text === "string")?.text ?? null;
      const anchor = p.anchor ? { ...p.anchor } : null;
      return [{ id: e.id, author: p.author, text: p.text, ts: e.ts, trace, units: p.cards.filter(isUnitCard), pages: p.cards.filter(isPageCard), timelines: p.cards.filter(isTimelineCard), tables: p.cards.filter(isUnitsTableCard), anchor, quote: p.quote ? { ...p.quote } : null, opened: false }];
    }),
  );
  /** The messages alone. */
  const lines = createMemo<Line[]>(() => entries().filter((l) => !l.opened));
  /** The thread with the tutor's reply in progress at the end, in the thread or in its aside. */
  const allLines = createMemo<Line[]>(() => {
    const r = view.reply;
    const ls = entries();
    if (!r) return ls;
    const anchor = r.anchor ? { ...r.anchor } : null;
    return [...ls, { id: r.id, author: "tutor", text: r.text, ts: ls.at(-1)?.ts ?? Date.now(), trace: null, units: [], pages: [], timelines: [], tables: [], anchor, quote: null, opened: false }];
  });
  const asides = createMemo<Aside[]>(() => {
    pageTick();
    const anchored = allLines().flatMap((l) => (l.anchor ? [{ id: l.id, author: l.author, text: l.text, ts: l.ts, anchor: l.anchor }] : []));
    return groupAsides(anchored, pageMap);
  });
  const asideOf = createMemo(() => {
    const m = new Map<string, Aside>();
    for (const a of asides()) for (const x of a.messages) m.set(x.id, a);
    return m;
  });
  const items = createMemo<Item[]>(() => {
    const out: Item[] = [];
    const of = asideOf();
    for (const l of allLines()) {
      const a = l.anchor ? of.get(l.id) : undefined;
      const last = out.at(-1);
      if (!a) out.push({ id: l.id, kind: "line", line: l });
      else if (last?.kind === "aside" && last.aside.id === a.id) last.lines.push(l);
      else out.push({ id: `aside:${l.id}`, kind: "aside", aside: a, lines: [l] });
    }
    return out;
  });
  /** The newest messages not on the open page, for the thread card in its margin. */
  const recent = createMemo<Line[]>(() => {
    const id = shown()?.id;
    return allLines()
      .filter((l) => l.anchor?.page_id !== id || !asideOf().get(l.id)?.range)
      .slice(-CARD_MESSAGES);
  });
  const pageAsides = createMemo<Aside[]>(() => {
    const page = shown();
    if (!page) return [];
    return asides()
      .filter((a) => a.page_id === page.id && a.range)
      .sort((a, b) => a.range!.from - b.range!.from);
  });
  const quoteOf = (a: Aside) => {
    pageTick();
    const page = pageMap[a.page_id];
    return page && a.range ? passageText(page, a.range.from, a.range.to) || a.quote : a.quote;
  };

  // The highlights follow the asides on the open page.
  createEffect(
    () => [pageAsides(), edBound(), shown()] as const,
    ([list, , page]) => {
      if (!editor || !page) return;
      const hl: Highlight[] = list.map((a) => ({ id: a.id, from: a.range!.from, to: a.range!.to, kind: a.raised_by === "tutor" ? "asked" : "resting" }));
      editor.setHighlights(page.rev, hl);
      queueAlign();
    },
  );

  // Folded once per new event, not per render.
  const unitMap = new Map<string, UnitView>();
  let folded = 0;
  const units = createMemo(() => {
    const evs = view.events;
    if (evs.length < folded) {
      unitMap.clear();
      folded = 0;
    }
    foldUnits(evs.slice(folded) as Ev[], unitMap);
    folded = evs.length;
    return { map: unitMap, n: folded };
  });

  // The timed run that is on, if any, folded once per new event like the units.
  const runMap: Record<string, Run> = {};
  let runsFolded = 0;
  const run = createMemo<Run | null>(() => {
    const evs = view.events;
    for (; runsFolded < evs.length; runsFolded++) applyRunEvent(runMap, evs[runsFolded]!);
    const r = currentRun(runMap);
    return r ? { ...r } : null;
  });
  // The clock ticks only while a run's clock is running.
  const [clockNow, setClockNow] = createSignal(Date.now());
  createEffect(
    () => {
      const r = run();
      return r !== null && r.paused_at === null;
    },
    (running) => {
      setClockNow(Date.now());
      if (!running) return;
      const t = setInterval(() => setClockNow(Date.now()), 250);
      return () => clearInterval(t);
    },
  );
  const Clock = () => <Show when={run()}>{(r) => <RunClock run={r()} now={clockNow()} />}</Show>;

  // When the newest tutor message was first on screen: the start of the learner's answer time.
  let shownId: string | null = null;
  let shownAt: number | null = null;
  const markShown = () => {
    const last = lines().at(-1);
    if (!last || last.author !== "tutor" || last.id === shownId) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    shownId = last.id;
    shownAt = Date.now();
  };

  // Asides sit level with their passage where there is room, and stack where there is not.
  let asidesBox: HTMLDivElement | undefined;
  let alignFrame = 0;
  const queueAlign = () => {
    cancelAnimationFrame(alignFrame);
    alignFrame = requestAnimationFrame(align);
  };
  const align = () => {
    const box = asidesBox;
    if (!box) return;
    const gap = parseFloat(getComputedStyle(box).getPropertyValue("--space-3")) || 12;
    const top0 = box.getBoundingClientRect().top;
    let y = 0;
    for (const [k, el] of ([...box.children] as HTMLElement[]).entries()) {
      const min = k === 0 ? 0 : gap;
      const want = narrow() || !editor ? null : editor.topOf(el.dataset.aside ?? "");
      const mt = want === null ? min : Math.max(min, Math.round(want - top0 - y));
      el.style.marginTop = `${mt}px`;
      y += mt + el.offsetHeight;
    }
  };

  // A page the tutor opens while the learner watches opens beside the thread at a desk.
  let liveFrom = -1;
  /** A scratch page the learner asked for, opened once its event is folded, with the caret on it. */
  let opening: string | null = null;
  let writeIn: string | null = null;
  const scratch = async () => {
    if (!sync) return;
    const page_id = uuidv7();
    opening = page_id;
    try {
      await sync.append("page.created", { page_id, title: "Scratch", starter: null, probe: null });
    } catch {
      if (opening === page_id) opening = null;
    }
  };
  /** The plus menu: a code block in the composer, and scratch work where pages can be edited. */
  const plus = () => ({ page: phone() ? null : () => void scratch() });

  onSettled(() => {
    const s = new Sync(props.session);
    sync = s;
    const pull = () => {
      if (s.signedOut) {
        s.stop();
        props.go({ kind: "signin" });
        return;
      }
      if (s.events.length > pagesFolded) {
        foldPages(s.events.slice(pagesFolded), pageMap);
        pagesFolded = s.events.length;
        editor?.receive(s.events);
        setPageTick((n) => n + 1);
      }
      let opened: string | null = null;
      if (opening && pageMap[opening]) {
        opened = writeIn = opening;
        opening = null;
      }
      if (s.ready && liveFrom < 0) liveFrom = s.events.length;
      for (; liveFrom >= 0 && liveFrom < s.events.length; liveFrom++) {
        const e = s.events[liveFrom]!;
        if (e.type !== "message.added" || e.payload.author !== "tutor") continue;
        for (const c of e.payload.cards as { kind: string; page_id?: string }[]) if (c.kind === "page" && c.page_id) opened = c.page_id;
      }
      setView((v) => {
        if (s.events.length > v.events.length) v.events.push(...s.events.slice(v.events.length));
        v.connected = s.connected;
        v.lost = s.lost;
        v.ready = s.ready;
        v.reply = s.reply ? { ...s.reply, anchor: s.reply.anchor ? { ...s.reply.anchor } : null } : null;
        v.notice = s.notice;
      });
      if (opened && !phone()) {
        stick = true;
        openPage(opened);
      }
      // A link to a page that is not in the log goes to the thread.
      const r = route();
      if (s.ready && r && !pageMap[r]) {
        history.replaceState(null, "", "/");
        setRoute(null);
      }
      // After the DOM has the new text, keep the newest line in view.
      requestAnimationFrame(() => {
        if (stick) toBottom?.();
        markShown();
      });
    };
    const visible = () => markShown();
    const popped = () => setRoute(pagePath());
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("popstate", popped);
    window.addEventListener("resize", queueAlign);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    const off = s.subscribe(pull);
    s.start();
    const unwatch = watchActivity(s);
    return () => {
      unwatch();
      off();
      clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("popstate", popped);
      window.removeEventListener("resize", queueAlign);
      s.stop();
    };
  });

  // A friend brings their own model key: until it is given, the composer takes the key, not a message.
  const [needsKey, setNeedsKey] = createSignal(props.session.needs_key ?? null);
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const giveKey = async (text: string): Promise<boolean> => {
    setKeyError(null);
    try {
      await saveKey(text);
      setNeedsKey(null);
      return true;
    } catch (e) {
      setKeyError(e instanceof SendError ? e.message : "Could not reach the server. Try again.");
      return false;
    }
  };
  const KeyNote = () => (
    <Show when={needsKey()}>
      {(name) => (
        <p class="myl-trace">
          Your tutor runs on your own {name()} API key{name() === "Gemini" ? ", which you can make in Google AI Studio" : ""}. Paste it below and send. It is kept on the
          server for your tutor and never shown again.
        </p>
      )}
    </Show>
  );
  const KeyComposer = () => (
    <Composer secret connected={view.connected} lost={view.lost} send={giveKey} scope={keyError()} placeholder={`Your ${needsKey()} API key`} />
  );

  /** A passage of a thread message the learner selected: the composer replies to it. */
  const [quote, setQuote] = createSignal<(Quote & { range: Range }) | null>(null);
  const aim = (q: (Quote & { range: Range }) | null) => {
    setQuote(q);
    markQuote(q?.range ?? null);
  };
  onSettled(() => {
    // Selecting in a message aims the composer at the passage. Moving into the composer keeps it;
    // a click elsewhere, or a selection on the page, lets it go.
    const watch = () => {
      const sel = getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!sel.isCollapsed) {
        const from = lineOf(range.startContainer);
        const to = lineOf(range.endContainer);
        const id = from?.dataset.line;
        if (id && to?.dataset.line === id && lines().some((l) => l.id === id)) {
          const text = quoteText(range);
          if (text) {
            aim({ message_id: id, text, range: range.cloneRange() });
            editor?.dismissScope();
          }
          return;
        }
      }
      const at = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      if (at?.closest(".myl-composer") || document.activeElement?.closest(".myl-composer")) return;
      if (quote()) aim(null);
    };
    document.addEventListener("selectionchange", watch);
    return () => {
      document.removeEventListener("selectionchange", watch);
      markQuote(null);
    };
  });
  const quoteScope = () => {
    const q = quote();
    if (!q) return null;
    return (
      <>
        Replying to “<span class="app-scope-quote">{inline(q.text.replace(/\$\$/g, "$"))}</span>” · Esc to let go
      </>
    );
  };
  /** A learner's message shows the passage it replies to above it. */
  const Quoted = (p: { quote: Quote | null }) => (
    <Show when={p.quote}>{(q) => <blockquote class="myl-aside__quote app-quote">{inline(q().text.replace(/\$\$/g, "$"))}</blockquote>}</Show>
  );

  const send = async (text: string, startedAt: number | null): Promise<boolean> => {
    if (!sync) return false;
    stick = true;
    const answering = lines().at(-1)?.id === shownId;
    const ed = editor;
    // A message about a passage is anchored to it, at a revision the server has.
    const q = quote();
    const anchor = !q && ed && ed.scope() ? await ed.anchor() : null;
    try {
      await sync.append("message.added", {
        author: "learner",
        text,
        cards: [],
        anchor,
        quote: q ? { message_id: q.message_id, text: q.text } : null,
        timing: { shown_at: answering ? shownAt : null, input_started_at: startedAt, sent_at: Date.now() },
      });
      if (q && quote() === q) aim(null);
      return true;
    } catch (e) {
      if (e instanceof SendError) console.warn(e.message);
      return false;
    }
  };

  const reword = async (unit_id: string, text: string): Promise<boolean> => {
    if (!sync) return false;
    try {
      await sync.append("unit.reworded", { unit_id, text, by: "learner" });
      return true;
    } catch (e) {
      if (e instanceof SendError) console.warn(e.message);
      return false;
    }
  };

  const bindEditor = (ed: PageEditor | null) => {
    editor = ed;
    setEdBound((n) => n + 1);
    if (ed && writeIn && writeIn === shown()?.id) {
      writeIn = null;
      ed.focusEnd();
    }
  };
  const editorChanged = () => {
    setEdTick((n) => n + 1);
    queueAlign();
  };

  const scopeText = () => {
    const sc = scope();
    if (!sc) return null;
    // The quote is shown as it reads on the page, math rendered, cut to one line by the stylesheet.
    const quote = sc.quote.replace(/\s+/g, " ").replace(/\$\$/g, "$").trim();
    return (
      <>
        {sc.aside ? "In the aside on" : "About"} “<span class="app-scope-quote">{inline(quote)}</span>” · Esc for the thread
      </>
    );
  };

  /** A message's cards. Tables and timelines go between the reply's first paragraph and the rest when it has one ("inline"); units and page links after it. */
  const Extras = (p: { line: Line; part?: "inline" | "after" }) => {
    const inlineCards = () => (
      <>
        <For each={p.line.tables}>{(card) => <UnitsTable card={card} unit={(id) => (units().n, current(units().map, id))} />}</For>
        <For each={p.line.timelines}>{(card) => <Timeline card={card} />}</For>
      </>
    );
    return (
      <>
        <Show when={p.part !== "after"}>{inlineCards()}</Show>
        <Show when={p.part !== "inline"}>{afterCards()}</Show>
      </>
    );
    function afterCards() {
      return (
      <>
        <For each={p.line.units}>
          {(card) => (
            <Show when={current(units().map, card.unit_id)}>
              <Unit card={card} unit={() => (units().n, current(units().map, card.unit_id)!)} reword={reword} />
            </Show>
          )}
        </For>
        <For each={p.line.pages}>
          {(card) => (
            <Show when={(pageTick(), pageMap[card.page_id])}>
              {(page) => (
                <PageLink
                  page={page()}
                  status={(pageTick(), pageStatus(page(), pageMap, now(), shown()?.id ?? null))}
                  facts={(pageTick(), pageFacts(page(), asides().filter((a) => a.page_id === page().id && a.raised_by === "tutor").length))}
                  open={() => openPage(page().id)}
                />
              )}
            </Show>
          )}
        </For>
      </>
      );
    }
  };

  /** The reply in progress has no words yet: the tutor is thinking or using its tools. */
  const thinking = (id: string) => view.reply?.id === id && !view.reply.text;
  const Thinking = () => (
    <div class="app-thinking" role="img" aria-label="The tutor is thinking">
      <span />
      <span />
      <span />
    </div>
  );

  const Who = (p: { author: "learner" | "tutor" }) => (
    <span class={{ "myl-aside__who": true, "myl-aside__who--tutor": p.author === "tutor" }}>{p.author === "tutor" ? "Tutor" : "You"}</span>
  );

  const AsideCard = (p: { aside: Aside; messages: { id: string; author: "learner" | "tutor"; text: string }[]; margin?: boolean }) => (
    <section class="myl-aside" aria-label="Aside" data-aside={p.margin ? p.aside.id : undefined}>
      <blockquote class={{ "myl-aside__quote": true, "myl-aside__quote--asked": p.aside.raised_by === "tutor" }}>{inline(quoteOf(p.aside))}</blockquote>
      <For each={p.messages} keyed={(m) => m.id}>
        {(m) => (
          <div class="myl-aside__message">
            <Who author={m().author} />
            <Show when={!thinking(m().id)} fallback={<Thinking />}>
              <Body text={m().text} />
            </Show>
          </div>
        )}
      </For>
    </section>
  );

  const ThreadView = () => {
    let scroller!: HTMLDivElement;
    onSettled(() => {
      toBottom = () => {
        scroller.scrollTop = scroller.scrollHeight;
      };
      toBottom();
      const resize = new ResizeObserver(() => {
        if (stick) toBottom?.();
      });
      resize.observe(scroller);
      return () => {
        resize.disconnect();
        toBottom = null;
      };
    });
    const firstTs = (it: Item) => (it.kind === "line" ? it.line.ts : it.lines[0]!.ts);
    const firstAuthor = (it: Item) => (it.kind === "line" ? it.line.author : it.lines[0]!.author);
    const lastAuthor = (it: Item) => (it.kind === "line" ? it.line.author : it.lines.at(-1)!.author);
    return (
      <div class="myl-phone app-phone">
        <Show when={run()}>
          <div class="app-clockbar">
            <Clock />
          </div>
        </Show>
        <div
          class="myl-phone__scroll"
          ref={scroller}
          onScroll={() => {
            stick = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
          }}
        >
          <main class="myl-thread" aria-live="polite">
            <For each={items()} keyed={(it) => it.id}>
              {(item, i) => {
                const prev = () => items()[i() - 1];
                const newDay = () => !prev() || dayLabel(firstTs(prev()!)) !== dayLabel(firstTs(item()));
                const turn = () => !!prev() && lastAuthor(prev()!) !== firstAuthor(item());
                return (
                  <>
                    <Show when={newDay()}>
                      <div class="myl-day">{dayLabel(firstTs(item()))}</div>
                    </Show>
                    <Switch>
                      <Match when={item().kind === "line" ? (item() as Item & { kind: "line" }).line : null}>
                        {(line) => {
                          const split = () => (line().tables.length || line().timelines.length ? splitLead(line().text) : null);
                          return (
                            <Show
                              when={split()}
                              fallback={
                                <>
                                  <Show when={thinking(line().id)}>
                                    <article class={{ "myl-message": true, "myl-turn": turn() }}>
                                      <Thinking />
                                    </article>
                                  </Show>
                                  <Show when={line().text.trim() || line().trace}>
                                    <article class={{ "myl-message": true, "myl-message--learner": line().author === "learner", "myl-turn": turn() }} data-line={line().id}>
                                      <Quoted quote={line().quote} />
                                      <Body text={line().text} />
                                      <Show when={line().trace}>{(t) => <div class="myl-trace">{t()}</div>}</Show>
                                    </article>
                                  </Show>
                                  <Extras line={line()} />
                                </>
                              }
                            >
                              {(parts) => (
                                <>
                                  <article class={{ "myl-message": true, "myl-turn": turn() }} data-line={line().id}>
                                    <Body text={parts()[0]} />
                                  </article>
                                  <Extras line={line()} part="inline" />
                                  <article class="myl-message" data-line={line().id}>
                                    <Body text={parts()[1]} />
                                    <Show when={line().trace}>{(t) => <div class="myl-trace">{t()}</div>}</Show>
                                  </article>
                                  <Extras line={line()} part="after" />
                                </>
                              )}
                            </Show>
                          );
                        }}
                      </Match>
                      <Match when={item().kind === "aside" ? (item() as Item & { kind: "aside" }) : null}>
                        {(chunk) => (
                          <div class={{ "app-aside-turn": turn() }}>
                            <AsideCard aside={chunk().aside} messages={chunk().lines} />
                            <For each={chunk().lines} keyed={(l) => l.id}>
                              {(l) => <Extras line={l()} />}
                            </For>
                          </div>
                        )}
                      </Match>
                    </Switch>
                  </>
                );
              }}
            </For>
            <Show when={view.notice}>
              <p class="myl-trace">{view.notice}</p>
            </Show>
            <KeyNote />
          </main>
        </div>
        <div class="myl-phone__foot app-foot">
          <Show when={needsKey()} fallback={<Composer connected={view.connected} lost={view.lost} send={send} scope={quoteScope()} escape={() => aim(null)} plus={plus()} />}>
            <KeyComposer />
          </Show>
        </div>
      </div>
    );
  };

  const DeskView = (p: { page: PageState }) => {
    let card!: HTMLElement;
    let article!: HTMLElement;
    onSettled(() => {
      toBottom = () => {
        card.scrollTop = card.scrollHeight;
      };
      toBottom();
      const resize = new ResizeObserver(queueAlign);
      resize.observe(article);
      resize.observe(card);
      return () => {
        resize.disconnect();
        toBottom = null;
        asidesBox = undefined;
      };
    });
    return (
      <div class="app-desk">
        <div class="myl-desk">
          <article class="myl-page app-page" ref={article}>
            <div class="myl-page__bar">
              <a
                class="myl-icon-button"
                href="/"
                aria-label="Back to the thread"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  openPage(null);
                }}
              >
                <Icon name="close" />
              </a>
              <Clock />
            </div>
            <h1>{p.page.title}</h1>
            <PageView page={p.page} editable={true} sync={() => sync} bind={bindEditor} changed={editorChanged} />
          </article>
          <div class="myl-margin app-margin">
            <section class="myl-aside app-thread-card" aria-label="Thread" aria-live="polite" ref={card}>
              <span class="myl-label">Thread</span>
              <For each={recent()} keyed={(l) => l.id}>
                {(l) => (
                  <>
                    <Show when={l().text.trim() || thinking(l().id)}>
                      <div class="myl-aside__message" data-line={l().id}>
                        <Who author={l().author} />
                        <Quoted quote={l().quote} />
                        <Show when={!thinking(l().id)} fallback={<Thinking />}>
                          <Body text={l().text} />
                        </Show>
                      </div>
                    </Show>
                    <Extras line={l()} />
                  </>
                )}
              </For>
              <Show when={view.notice}>
                <p class="myl-trace">{view.notice}</p>
              </Show>
              <KeyNote />
            </section>
            <div class="app-asides" ref={(el) => (asidesBox = el)}>
              <For each={pageAsides()} keyed={(a) => a.id}>
                {(a) => <AsideCard aside={a()} messages={a().messages} margin />}
              </For>
            </div>
            <div class="app-dock">
              <Show
                when={needsKey()}
                fallback={
                  <Composer
                    connected={view.connected}
                    lost={view.lost}
                    send={send}
                    scope={quote() ? quoteScope() : scopeText()}
                    placeholder="Type or dictate"
                    escape={() => (quote() ? aim(null) : editor?.dismissScope())}
                    plus={plus()}
                  />
                }
              >
                <KeyComposer />
              </Show>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <Show when={!phone() && shown()} keyed fallback={<ThreadView />}>
        {(page) => <DeskView page={page} />}
      </Show>
      <Show when={phone() && shown()} keyed>
        {(page) => (
          <div class="app-sheet" role="dialog" aria-modal="true" aria-label={page.title}>
            <article class="myl-page">
              <div class="myl-page__bar">
                <button type="button" class="myl-icon-button" aria-label="Back to the thread" onClick={() => openPage(null)}>
                  <Icon name="close" />
                </button>
                <Clock />
              </div>
              <h1>{page.title}</h1>
              <PageView page={page} editable={false} sync={() => sync} bind={bindEditor} changed={editorChanged} />
            </article>
          </div>
        )}
      </Show>
    </>
  );
}

/** A countdown reads whole seconds rounded up, so it shows 0:00 only at zero; padded like 05:30. */
const countdown = (ms: number) => {
  const t = clockText(Math.ceil(Math.max(0, ms) / 1000) * 1000);
  return t.length === 4 ? `0${t}` : t;
};

/** The run clock: the time left in a timed run. It has no buttons; pause and stop are said in words. */
function RunClock(props: { run: Run; now: number }) {
  const paused = () => props.run.paused_at !== null;
  const left = () => runLeft(props.run, props.now);
  const last = () => !paused() && left() <= 60_000;
  return (
    <div
      class={{ "myl-clock": true, "myl-clock--last": last(), "myl-clock--paused": paused() }}
      role="timer"
      aria-label={paused() ? "Paused" : last() ? "Time left, last minute" : "Time left"}
    >
      <span class="myl-clock__time">{countdown(left())}</span>
      <span class="myl-clock__of">{paused() ? "paused" : `left of ${countdown(props.run.duration_ms)}`}</span>
    </div>
  );
}

/** Where the minutes of a timed run went: a bar of segments, and the same in words below it. */
function Timeline(props: { card: TimelineCard }) {
  const length = () => {
    const ms = props.card.duration_ms;
    return ms % 60_000 === 0 ? `${ms / 60_000} minute` : clockText(ms);
  };
  const share = (ms: number) => `${Math.max(0, ms)} 1 0px`;
  return (
    <div class="myl-card myl-card--padded app-timeline">
      <div class="myl-timeline__bar" role="img" aria-label={`Timeline of a ${length()} run in ${props.card.segments.length} parts`}>
        <For each={props.card.segments}>
          {(seg) => (
            <div
              class={{ "myl-timeline__segment": true, "myl-timeline__segment--costly": !!seg.costly, "myl-timeline__segment--unused": !!seg.unused }}
              style={{ flex: share(seg.ms) }}
            />
          )}
        </For>
      </div>
      <dl class="myl-timeline__rows">
        <For each={props.card.segments}>
          {(seg) => {
            const cls = { "myl-timeline__costly": !!seg.costly, "myl-timeline__unused": !!seg.unused };
            return (
              <>
                <dt class={cls}>{seg.name}</dt>
                <dd class={cls}>{clockText(seg.ms)}</dd>
              </>
            );
          }}
        </For>
      </dl>
    </div>
  );
}

const DEPTH_LABEL: Record<string, string> = { recall: "Recall", rebuild: "Rebuild", explain: "Explain", use: "Use" };
const CHIP_SAYS: Record<ChipState, string> = { shown: "shown", not_yet: "not yet", missed: "missed" };

/** Where the learner stands on some units: what each rests on and the depths shown. Statements follow later rewordings. */
function UnitsTable(props: { card: UnitsTableCard; unit: (id: string) => UnitView | undefined }) {
  return (
    <div class="myl-card app-units">
      <div class="myl-table-scroll">
        <table class="myl-table">
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">Rests on</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.card.rows}>
              {(row) => {
                const u = () => props.unit(row.unit_id);
                return (
                  <tr>
                    <td>
                      <span class="myl-table__unit">{inline(u()?.text ?? row.text)}</span>
                      <span class={{ "myl-table__kind": true, "myl-table__kind--found": !!row.found }}>{[u()?.kind ?? row.kind, row.found].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td class="myl-table__rests">{inline(row.rests_on)}</td>
                    <td>
                      <Show when={!row.told} fallback={<span class="myl-trace">Told, not rebuilt</span>}>
                        <div class="myl-chips">
                          <For each={row.depths}>
                            {(d) => {
                              const label = DEPTH_LABEL[d.depth] ?? d.depth;
                              return (
                                <span class={{ "myl-chip": true, "myl-chip--shown": d.state === "shown", "myl-chip--not-yet": d.state === "not_yet", "myl-chip--missed": d.state === "missed" }}>
                                  {d.state === "missed" ? `${label}, missed` : label}
                                  <Show when={d.state !== "missed"}>
                                    <span class="myl-visually-hidden">, {CHIP_SAYS[d.state]}</span>
                                  </Show>
                                </span>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The page's document. The editor is made once per page and kept in step with the log by the thread. */
function PageView(props: { page: PageState; editable: boolean; sync: () => Sync | null; bind: (ed: PageEditor | null) => void; changed: () => void }) {
  let mount!: HTMLDivElement;
  onSettled(() => {
    const s = props.sync();
    const ed = new PageEditor(mount, {
      page: props.page,
      editable: props.editable,
      changed: props.changed,
      ...(s && props.editable ? { send: (payload: EditPayload, id: string, ts: number) => sendEdit(s, payload, id, ts), run: () => runPage(props.page.id) } : {}),
      logged: (id) => s?.events.some((e) => e.id === id) ?? false,
    });
    if (s) ed.receive(s.events);
    props.bind(ed);
    return () => {
      props.bind(null);
      ed.destroy();
    };
  });
  return <div ref={mount} class="app-doc-mount" />;
}

/** The link to a page, once, where it was opened. A modified click is left to the browser. */
function PageLink(props: { page: PageState; status: string; facts: string; open: () => void }) {
  return (
    <a
      class="myl-pagelink"
      href={`/page/${props.page.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        props.open();
      }}
    >
      <span class="myl-pagelink__body">
        <span class="myl-label">Page · {props.status}</span>
        <span class="myl-pagelink__title">{props.page.title}</span>
        <span class="myl-trace">{props.facts}</span>
      </span>
      <span class="myl-pagelink__open">
        <Icon name="open" />
      </span>
    </a>
  );
}

function Composer(props: {
  connected: boolean;
  lost: boolean;
  send: (text: string, startedAt: number | null) => Promise<boolean>;
  /** The passage the composer is aimed at, and how to leave it. */
  scope?: JSX.Element | null;
  placeholder?: string;
  escape?: () => void;
  /** For an API key: nothing is kept as a draft, and the browser neither suggests nor checks it. */
  secret?: boolean;
  /** The plus button. Without `page`, where pages cannot be edited, it starts a code block. */
  plus?: { page: (() => void) | null };
}) {
  const kept = () => (props.secret ? "" : draft.get());
  /** The message on its way to the server. It stays in the draft until the server has it. */
  let pending: string | null = null;
  const keep = (text: string) => {
    if (!props.secret) draft.set(pending === null ? text : text.trim() ? `${pending}\n${text}` : pending);
  };
  const [empty, setEmpty] = createSignal(kept().trim() === "");
  const [sending, setSending] = createSignal(false);
  // The first keystroke since the last send. A restored draft has no start time.
  let startedAt: number | null = null;
  let field!: HTMLTextAreaElement;
  let form!: HTMLFormElement;
  let plusButton: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;
  const [menu, setMenu] = createSignal(false);
  const closeMenu = (refocus: boolean) => {
    setMenu(false);
    if (refocus) plusButton?.focus();
  };

  /** Starts a code block at the caret, around the selection if there is one. Undo takes it back. */
  const code = () => {
    setMenu(false);
    field.focus();
    const e = insertFence(field.value, field.selectionStart, field.selectionEnd);
    field.setSelectionRange(e.from, e.to);
    if (!document.execCommand("insertText", false, e.insert)) {
      field.setRangeText(e.insert, e.from, e.to, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field.setSelectionRange(e.caret, e.caret);
  };
  const onPlus = () => {
    if (!props.plus?.page) return code();
    if (menu()) return closeMenu(false);
    setMenu(true);
    requestAnimationFrame(() => menuEl?.querySelector<HTMLButtonElement>("button")?.focus());
  };
  const menuKeys = (e: KeyboardEvent) => {
    const items = Array.from(menuEl?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") closeMenu(false);
  };
  onSettled(() => {
    // A press anywhere but the menu or the plus closes the menu.
    const away = (e: PointerEvent) => {
      if (!menu()) return;
      const t = e.target as Node;
      if (menuEl?.contains(t) || plusButton?.contains(t)) return;
      setMenu(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  });

  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  };

  onSettled(() => {
    field.value = kept();
    grow();
  });

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const text = field.value.trim();
    if (!text || !props.connected || sending()) return;
    setSending(true);
    // The field clears at once, so what is typed while the message goes is the next one.
    const started = startedAt;
    startedAt = null;
    pending = text;
    show("");
    const sent = await props.send(text, started);
    pending = null;
    if (sent) keep(field.value);
    else {
      // Not sent: the message comes back, ahead of anything typed since.
      const after = field.value;
      const at = field.selectionStart;
      show(after.trim() ? `${text}\n${after}` : text);
      if (after.trim() && document.activeElement === field) field.setSelectionRange(at + text.length + 1, at + text.length + 1);
      startedAt = started ?? startedAt;
    }
    setSending(false);
  };
  const show = (text: string) => {
    field.value = text;
    keep(text);
    setEmpty(text.trim() === "");
    grow();
  };

  return (
    <form class="myl-composer" ref={form} onSubmit={submit}>
      <Show when={props.lost}>
        <div class="myl-composer__scope myl-composer__scope--offline" role="status">
          Not connected. Your draft is kept here.
        </div>
      </Show>
      <Show when={!props.lost && props.scope}>
        <div class="myl-composer__scope" role="status">
          {props.scope}
        </div>
      </Show>
      <Show when={menu()}>
        <div class="app-plus-menu" role="menu" aria-label="Add" ref={menuEl} onKeyDown={menuKeys}>
          <button type="button" role="menuitem" class="myl-icon-button" aria-label="Code block" onClick={code}>
            <Icon name="code" />
          </button>
          <button
            type="button"
            role="menuitem"
            class="myl-icon-button"
            aria-label="Scratch page"
            onClick={() => {
              setMenu(false);
              props.plus?.page?.();
            }}
          >
            <Icon name="page" />
          </button>
        </div>
      </Show>
      <div class="myl-composer__row">
        <Show when={props.plus}>
          <button
            type="button"
            ref={plusButton}
            class="myl-icon-button app-plus"
            aria-label={props.plus?.page ? "Add" : "Code block"}
            aria-haspopup={props.plus?.page ? "menu" : undefined}
            aria-expanded={props.plus?.page ? (menu() ? "true" : "false") : undefined}
            onClick={onPlus}
          >
            <Icon name="plus" />
          </button>
        </Show>
        <textarea
          ref={field}
          class="myl-composer__field"
          rows="1"
          aria-label={props.secret ? "API key" : "Message"}
          placeholder={props.placeholder ?? "Say anything"}
          autocomplete={props.secret ? "off" : undefined}
          autocapitalize={props.secret ? "off" : undefined}
          spellcheck={props.secret ? false : undefined}
          onInput={(e) => {
            startedAt ??= Date.now();
            keep(e.currentTarget.value);
            setEmpty(e.currentTarget.value.trim() === "");
            grow();
          }}
          onKeyDown={(e) => {
            const code = inFence(field.value, field.selectionStart);
            if (code && e.key === "Tab" && !e.shiftKey && field.selectionStart === field.selectionEnd) {
              // Indenting code: four spaces. Outside a code block Tab moves on as usual.
              e.preventDefault();
              if (!document.execCommand("insertText", false, "    ")) field.setRangeText("    ", field.selectionStart, field.selectionEnd, "end");
            } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch() && !(code && !(e.metaKey || e.ctrlKey))) {
              // Inside a code block Enter starts a new line, and Cmd or Ctrl with Enter sends.
              e.preventDefault();
              form.requestSubmit();
            } else if (e.key === "Escape" && props.scope) {
              e.preventDefault();
              props.escape?.();
            }
          }}
        />
        <button type="submit" class="myl-send" aria-label="Send" disabled={empty() || sending() || !props.connected}>
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}

/**
 * A unit announced in the thread. Reword makes the statement editable in place; Enter or leaving the
 * field keeps the learner's wording, Escape puts the old one back.
 */
function Unit(props: { card: UnitCard; unit: () => UnitView; reword: (id: string, text: string) => Promise<boolean> }) {
  const [editing, setEditing] = createSignal(false);
  let statement!: HTMLSpanElement;
  const noted = () => props.card.how === "Noted";
  const label = () => `${props.card.how} · ${props.unit().kind}${noted() ? ", told" : ""}`;
  // The statement is set by hand, not by Solid, so the browser's editing never fights the renderer:
  // its math is rendered while it is read, and its source is shown while it is reworded.
  // A saved wording shows until the event carrying it arrives.
  let pending: string | null = null;
  let seen: string | null = null;
  let rendered: string | null = null;
  const show = (text: string) => {
    rendered = text;
    renderMathText(statement, text);
  };
  createEffect(
    () => [props.unit().text, editing()] as const,
    ([text, busy]) => {
      if (text !== seen) [seen, pending] = [text, null];
      const shown = pending ?? text;
      if (!busy && rendered !== shown) show(shown);
    },
  );

  const start = () => {
    statement.textContent = pending ?? props.unit().text;
    rendered = null;
    setEditing(true);
    requestAnimationFrame(() => {
      statement.focus();
      const range = document.createRange();
      range.selectNodeContents(statement);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  };
  const finish = async (keep: boolean) => {
    if (!editing()) return;
    const text = statement.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const u = props.unit();
    const save = keep && text !== "" && text !== u.text;
    pending = save ? text : null;
    setEditing(false);
    if (save && !(await props.reword(u.id, text))) {
      pending = null;
      show(props.unit().text);
    }
  };

  return (
    <aside class={{ "myl-unit": true, "myl-unit--noted": noted() }} aria-label={noted() ? "Unit noted" : "Unit found"}>
      <div class="myl-unit__body">
        <div class="app-unit-head">
          <span class="myl-unit__label">{label()}</span>
          <Show when={!noted()}>
            <button
              type="button"
              class="myl-icon-button app-act"
              aria-label={editing() ? "Done" : "Reword"}
              onMouseDown={(e) => editing() && e.preventDefault()}
              onClick={() => (editing() ? void finish(true) : start())}
            >
              <Icon name={editing() ? "done" : "reword"} />
            </button>
          </Show>
        </div>
        <span
          ref={statement}
          class={{ "myl-unit__statement": true, "app-editing": editing() }}
          contenteditable={editing() ? "plaintext-only" : "false"}
          role={editing() ? "textbox" : undefined}
          aria-label={editing() ? "Your wording" : undefined}
          onKeyDown={(e) => {
            if (!editing()) return;
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              void finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              void finish(false);
            }
          }}
          onBlur={() => void finish(true)}
        />
        <Show when={props.card.note}>{(n) => <span class="myl-unit__note">{n()}</span>}</Show>
      </div>
    </aside>
  );
}
