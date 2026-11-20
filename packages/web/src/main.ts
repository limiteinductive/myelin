// Milestone 2's page: sign in, see the thread, send a message. Milestone 3 replaces it with the
// Solid app; sync.ts carries over.
import "../../../design/tokens.css";
import "../../../design/components/bundle.css";
import "./app.css";
import { draft, login, me, SignInError, Sync, type Ev, type Me } from "./sync.js";

const app = document.getElementById("app")!;
const SEND_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14V4M4.5 8.5 9 4l4.5 4.5"></path></svg>`;
const LOGO = `<span class="myl-logo" style="font-size: 40px"><svg class="myl-logo__mark" viewBox="0 0 96 96" aria-hidden="true"><path d="M12 88V56a18 18 0 0 1 36 0M48 88V32a18 18 0 0 1 36 0V88" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round"></path></svg>Myelin</span>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
}

function signIn(error?: string): void {
  app.innerHTML = `<main class="myl-signin">${LOGO}
<form class="myl-composer"><div class="myl-composer__row">
<input class="myl-composer__field" type="text" aria-label="Invite link" placeholder="Paste your invite link" autocomplete="off">
<button type="submit" class="myl-send" aria-label="Sign in" disabled>${SEND_ICON}</button>
</div></form>
<p class="myl-trace" role="status"></p></main>`;
  const form = app.querySelector("form")!;
  const field = form.querySelector("input")!;
  const button = form.querySelector("button")!;
  const help = app.querySelector("p")!;
  const showHelp = (warning?: string) => {
    help.textContent = warning ?? "Whoever runs this server can make you a link.";
    help.classList.toggle("app-warning", Boolean(warning));
  };
  showHelp(error);
  field.addEventListener("input", () => (button.disabled = field.value.trim() === ""));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    button.disabled = true;
    try {
      thread(await login(field.value));
    } catch (e) {
      showHelp(e instanceof SignInError ? e.message : "Could not reach the server.");
      button.disabled = false;
    }
  });
}

function thread(session: Me): void {
  app.innerHTML = `<div class="app-shell">
<main class="myl-thread" aria-live="polite"></main>
<form class="myl-composer app-composer">
<div class="myl-composer__scope myl-composer__scope--offline" role="status" hidden>Not connected. Your draft is kept here.</div>
<div class="myl-composer__row">
<textarea class="myl-composer__field" rows="1" aria-label="Message" placeholder="Say anything"></textarea>
<button type="submit" class="myl-send" aria-label="Send" disabled>${SEND_ICON}</button>
</div></form></div>`;
  const list = app.querySelector("main")!;
  const form = app.querySelector("form")!;
  const offline = form.querySelector<HTMLElement>(".myl-composer__scope")!;
  const field = form.querySelector("textarea")!;
  const button = form.querySelector("button")!;
  const sync = new Sync(session);
  let shown = 0;
  let sending = false;

  field.value = draft.get();
  const refresh = () => {
    offline.hidden = sync.connected;
    button.disabled = !sync.connected || sending || field.value.trim() === "";
  };
  const render = () => {
    if (sync.signedOut) return signIn();
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
    for (const e of sync.events.slice(shown)) {
      if (e.type !== "message.added") continue;
      const p = e.payload as { author: "learner" | "tutor"; text: string };
      const m = el("article", { class: `myl-message myl-message--${p.author}`, "data-seq": String(e.seq) });
      for (const para of p.text.split(/\n{2,}/)) m.append(Object.assign(el("p"), { textContent: para }));
      list.append(m);
    }
    shown = sync.events.length;
    if (atBottom) window.scrollTo({ top: document.body.scrollHeight });
    refresh();
  };
  sync.subscribe(render);
  sync.start();

  field.addEventListener("input", () => {
    draft.set(field.value);
    refresh();
  });
  field.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = field.value.trim();
    if (!text || !sync.connected) return;
    sending = true;
    refresh();
    try {
      await sync.append("message.added", { author: "learner", text, cards: [], anchor: null, timing: { shown_at: null, input_started_at: null, sent_at: Date.now() } });
      field.value = "";
      draft.set("");
    } catch {
      // The draft stays in the field.
    } finally {
      sending = false;
      refresh();
    }
  });
}

async function boot(): Promise<void> {
  const link = location.pathname.match(/^\/login\/([A-Za-z0-9_-]+)$/)?.[1];
  if (link) {
    history.replaceState(null, "", "/");
    try {
      return thread(await login(link));
    } catch (e) {
      // A used link on a device that is already signed in just opens the thread.
      const session = await me().catch(() => null);
      if (session) return thread(session);
      return signIn(e instanceof SignInError ? e.message : "Could not reach the server.");
    }
  }
  const session = await me().catch(() => null);
  if (session) thread(session);
  else signIn();
}

void boot();
