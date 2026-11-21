// Math typed as TeX between dollar signs, rendered by KaTeX. The text keeps the source; rendering is
// a view of it, in the thread and on a page alike. `$$…$$` is displayed math, `$…$` is inline. A
// dollar followed by a space, or a closing dollar followed by a digit, is not math ("$5 and $6").
import katex from "katex";

export interface MathSpan {
  /** Offsets in the text, covering the dollar signs. */
  from: number;
  to: number;
  tex: string;
  display: boolean;
}

export const MATH = /\$\$([^$]+?)\$\$|\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?!\d)/g;

export function mathSpans(text: string): MathSpan[] {
  const out: MathSpan[] = [];
  for (const m of text.matchAll(MATH)) {
    const display = m[1] !== undefined;
    const tex = (display ? m[1] : m[2])!.trim();
    if (tex) out.push({ from: m.index, to: m.index + m[0].length, tex, display });
  }
  return out;
}

const cache = new Map<string, string>();

/** KaTeX's HTML for a formula. Bad TeX renders as the source in KaTeX's error colour; it never throws. */
export function mathHtml(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = cache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "htmlAndMathml", trust: false, strict: "ignore" });
    if (cache.size > 500) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** A span holding rendered math, for the page view. */
export function mathElement(tex: string, display: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = display ? "myl-math app-math-display" : "myl-math";
  el.innerHTML = mathHtml(tex, display);
  return el;
}

/** Sets an element's content to text with its math rendered, for a view whose DOM is managed by hand. */
export function renderMathText(el: HTMLElement, text: string): void {
  const nodes: Node[] = [];
  let at = 0;
  for (const s of mathSpans(text)) {
    if (s.from > at) nodes.push(document.createTextNode(text.slice(at, s.from)));
    nodes.push(mathElement(s.tex, s.display));
    at = s.to;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  el.replaceChildren(...nodes);
}
