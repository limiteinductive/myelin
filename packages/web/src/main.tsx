// Boot: spend a login link if the URL holds one, then show the thread or the sign-in screen.
import "katex/dist/katex.min.css";
import "../../../design/tokens.css";
import "../../../design/components/bundle.css";
import "./app.css";
import "./v2.css";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { App, type Screen } from "./App.js";
import { login, me, SignInError } from "./sync.js";

// Apply device theme immediately before first paint (live updates are managed inside App's owner lifecycle).
if (typeof matchMedia === "function") {
  const t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
}

const [screen, setScreen] = createSignal<Screen>({ kind: "loading" });

async function boot(): Promise<Screen> {
  const link = location.pathname.match(/^\/login\/([A-Za-z0-9_-]+)$/)?.[1];
  if (link) {
    history.replaceState(null, "", "/");
    try {
      return { kind: "thread", session: await login(link) };
    } catch (e) {
      // A used link on a device that is already signed in just opens the thread.
      const session = await me().catch(() => null);
      if (session) return { kind: "thread", session };
      return { kind: "signin", error: e instanceof SignInError ? e.message : "Could not reach the server." };
    }
  }
  const session = await me().catch(() => null);
  return session ? { kind: "thread", session } : { kind: "signin" };
}

render(() => <App screen={screen()} go={setScreen} />, document.getElementById("app")!);
void boot().then(setScreen);
