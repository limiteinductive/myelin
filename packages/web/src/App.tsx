// The whole app: the sign-in screen, or the thread with its composer. Nothing else.
import { createMemo, createSignal, createStore, For, Match, onSettled, Show, Switch } from "solid-js";
import { draft, login, SendError, SignInError, Sync, type Draft, type Ev, type Me } from "./sync.js";
import { Body } from "./text.js";

export type Screen = { kind: "loading" } | { kind: "signin"; error?: string } | { kind: "thread"; session: Me };

const SendIcon = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 14V4M4.5 8.5 9 4l4.5 4.5" />
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
            <SendIcon />
          </button>
        </div>
      </form>
      <p class={{ "myl-trace": true, "app-warning": Boolean(shownError()) }} role="status">
        {shownError() ?? "Whoever runs this server can make you a link."}
      </p>
    </main>
  );
}

type Line = { id: string; author: "learner" | "tutor"; text: string; ts: number };

const dayLabel = (ts: number, now = Date.now()) => {
  const d = new Date(ts);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(days > 300 ? { year: "numeric" } : {}) });
};

function Thread(props: { session: Me; go: (s: Screen) => void }) {
  const [view, setView] = createStore({
    events: [] as Ev[],
    connected: false,
    lost: false,
    reply: null as Draft | null,
    notice: null as string | null,
  });
  let sync: Sync | null = null;
  let scroller!: HTMLDivElement;
  let stick = true;

  const lines = createMemo<Line[]>(() =>
    view.events
      .filter((e) => e.type === "message.added")
      .map((e) => {
        const p = e.payload as { author: "learner" | "tutor"; text: string };
        return { id: e.id, author: p.author, text: p.text, ts: e.ts };
      }),
  );

  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  onSettled(() => {
    const s = new Sync(props.session);
    sync = s;
    const pull = () => {
      if (s.signedOut) {
        s.stop();
        props.go({ kind: "signin" });
        return;
      }
      setView((v) => {
        if (s.events.length > v.events.length) v.events.push(...s.events.slice(v.events.length));
        v.connected = s.connected;
        v.lost = s.lost;
        v.reply = s.reply ? { ...s.reply } : null;
        v.notice = s.notice;
      });
      // After the DOM has the new text, keep the newest line in view.
      requestAnimationFrame(() => {
        if (stick) toBottom();
      });
    };
    const off = s.subscribe(pull);
    s.start();
    const resize = new ResizeObserver(() => {
      if (stick) toBottom();
    });
    resize.observe(scroller);
    return () => {
      off();
      resize.disconnect();
      s.stop();
    };
  });

  const send = async (text: string): Promise<boolean> => {
    if (!sync) return false;
    stick = true;
    try {
      await sync.append("message.added", { author: "learner", text, cards: [], anchor: null, timing: { shown_at: null, input_started_at: null, sent_at: Date.now() } });
      return true;
    } catch (e) {
      if (e instanceof SendError) console.warn(e.message);
      return false;
    }
  };

  return (
    <div class="myl-phone app-phone">
      <div
        class="myl-phone__scroll"
        ref={scroller}
        onScroll={() => {
          stick = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
        }}
      >
        <main class="myl-thread" aria-live="polite">
          <For each={lines()}>
            {(line, i) => (
              <>
                <Show when={i() === 0 || dayLabel(lines()[i() - 1]!.ts) !== dayLabel(line.ts)}>
                  <div class="myl-day">{dayLabel(line.ts)}</div>
                </Show>
                <article
                  class={{
                    "myl-message": true,
                    "myl-message--learner": line.author === "learner",
                    "myl-turn": i() > 0 && lines()[i() - 1]!.author !== line.author,
                  }}
                >
                  <Body text={line.text} />
                </article>
              </>
            )}
          </For>
          <Show when={view.reply && view.reply.text ? view.reply : null}>
            {(reply) => (
              <article class={{ "myl-message": true, "myl-turn": lines().at(-1)?.author === "learner" }}>
                <Body text={reply().text} />
              </article>
            )}
          </Show>
          <Show when={view.notice}>
            <p class="myl-trace">{view.notice}</p>
          </Show>
        </main>
      </div>
      <div class="myl-phone__foot app-foot">
        <Composer connected={view.connected} lost={view.lost} send={send} />
      </div>
    </div>
  );
}

function Composer(props: { connected: boolean; lost: boolean; send: (text: string) => Promise<boolean> }) {
  const [empty, setEmpty] = createSignal(draft.get().trim() === "");
  const [sending, setSending] = createSignal(false);
  let field!: HTMLTextAreaElement;
  let form!: HTMLFormElement;

  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  };

  onSettled(() => {
    field.value = draft.get();
    grow();
  });

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const text = field.value.trim();
    if (!text || !props.connected || sending()) return;
    setSending(true);
    if (await props.send(text)) {
      field.value = "";
      draft.set("");
      setEmpty(true);
      grow();
    }
    setSending(false);
  };

  return (
    <form class="myl-composer" ref={form} onSubmit={submit}>
      <Show when={props.lost}>
        <div class="myl-composer__scope myl-composer__scope--offline" role="status">
          Not connected. Your draft is kept here.
        </div>
      </Show>
      <div class="myl-composer__row">
        <textarea
          ref={field}
          class="myl-composer__field"
          rows="1"
          aria-label="Message"
          placeholder="Say anything"
          onInput={(e) => {
            draft.set(e.currentTarget.value);
            setEmpty(e.currentTarget.value.trim() === "");
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch()) {
              e.preventDefault();
              form.requestSubmit();
            }
          }}
        />
        <button type="submit" class="myl-send" aria-label="Send" disabled={empty() || sending() || !props.connected}>
          <SendIcon />
        </button>
      </div>
    </form>
  );
}
