// A code block on a page: the code, which the learner edits, then the output of the page's last run
// and a foot with its status and Run page. Run page runs every block from the top, so there is no
// button to run one block alone. The output and foot are not part of the document.
import type { PageRun } from "@myelin/core";
import type { Node as PMNode } from "prosemirror-model";
import type { Decoration, EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";

/** What a code block shows besides its code, passed in as a node decoration's spec. */
export interface CodeInfo {
  /** The block's place among the page's code blocks. */
  index: number;
  run: PageRun | null;
  running: boolean;
  /** Why the last press of Run page did not run, if it did not. */
  error: string | null;
}

export function codeStatus(info: CodeInfo | null): { text: string; failed: boolean } {
  if (info?.running) return { text: "Running…", failed: false };
  if (info?.error) return { text: info.error, failed: true };
  const b = info?.run?.blocks[info.index];
  if (!b) return { text: "Not run yet", failed: false };
  return b.failed ? { text: "Failed at this block", failed: true } : { text: "Ran with the page", failed: false };
}

export class CodeBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly output: HTMLElement;
  private readonly status: HTMLElement;
  private readonly button: HTMLButtonElement | null;

  constructor(
    private node: PMNode,
    decorations: readonly Decoration[],
    run: (() => void) | null,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "myl-code";
    this.contentDOM = document.createElement("pre");
    this.contentDOM.spellcheck = false;
    this.output = document.createElement("pre");
    this.output.className = "myl-code__output";
    this.output.contentEditable = "false";
    const foot = document.createElement("div");
    foot.className = "myl-code__foot";
    foot.contentEditable = "false";
    this.status = document.createElement("span");
    foot.append(this.status);
    this.button = null;
    if (run) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "myl-icon-button app-act";
      b.setAttribute("aria-label", "Run page");
      b.append(runIcon());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => run());
      foot.append(b);
      this.button = b;
    }
    this.dom.append(this.contentDOM, this.output, foot);
    this.show(decorations);
  }

  private show(decorations: readonly Decoration[]): void {
    const info = (decorations.find((d) => (d.spec as { code?: CodeInfo }).code)?.spec as { code?: CodeInfo } | undefined)?.code ?? null;
    const b = info?.run?.blocks[info.index];
    this.output.hidden = !b;
    this.output.textContent = b ? b.output.replace(/\n$/, "") || "(nothing printed)" : "";
    const st = codeStatus(info);
    this.status.textContent = st.text;
    this.status.className = st.failed ? "myl-code__status--failed" : "";
    if (this.button) this.button.disabled = Boolean(info?.running);
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.show(decorations);
    return true;
  }

  stopEvent(e: Event): boolean {
    return !this.contentDOM.contains(e.target as Node);
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === "selection") return false;
    return !this.contentDOM.contains(m.target);
  }
}

export function codeBlockView(run: (() => void) | null) {
  return (node: PMNode, _view: EditorView, _getPos: () => number | undefined, decorations: readonly Decoration[]) => new CodeBlockView(node, decorations, run);
}

/** Run page's icon, a triangle drawn like the app's other icons (proposal 94). */
function runIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ "aria-hidden": "true", width: "18", height: "18", viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linejoin": "round" })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M5.5 4v10l8.5-5z");
  svg.append(path);
  return svg;
}
