// Message text to elements: paragraphs, headings, lists, blockquotes, fenced code, multi-line
// display math ($$...$$), inline math ($...$), inline code, bold and italic. No raw HTML parsed.
import { createSignal, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import { mathHtml } from "./math.js";

type Block =
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "math"; tex: string }
  | { kind: "h"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  // First split fenced code blocks.
  const fenceParts = text.split(/^```[^\n]*\n?/m);
  fenceParts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/\n$/, "");
      if (code) out.push({ kind: "code", text: code });
      return;
    }
    // Next split multi-line display math blocks ($$ ... $$ on their own lines).
    const mathParts = part.split(/(?:^|\n)\$\$\n?([\s\S]*?)\n?\$\$(?=\n|$)/);
    mathParts.forEach((seg, j) => {
      if (j % 2 === 1) {
        const tex = seg.trim();
        if (tex) out.push({ kind: "math", tex });
        return;
      }
      for (const raw of seg.split(/\n{2,}/)) {
        const t = raw.trim();
        if (!t) continue;
        const lines = t.split("\n");
        if (lines.length === 1 && /^#{1,3}\s+/.test(t)) {
          out.push({ kind: "h", text: t.replace(/^#{1,3}\s+/, "") });
        } else if (lines.every((l) => /^>\s?/.test(l.trim()))) {
          out.push({ kind: "quote", text: lines.map((l) => l.trim().replace(/^>\s?/, "")).join("\n") });
        } else if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
          out.push({ kind: "ul", items: lines.map((l) => l.trim().replace(/^[-*]\s+/, "")) });
        } else if (lines.every((l) => /^\d+\.\s+/.test(l.trim()))) {
          out.push({ kind: "ol", items: lines.map((l) => l.trim().replace(/^\d+\.\s+/, "")) });
        } else {
          out.push({ kind: "p", text: t });
        }
      }
    });
  });
  return out;
}

/**
 * A reply's first paragraph and the rest, so a card can sit between them with a sentence above and
 * below. Null when there is no second paragraph, or the first is code.
 */
export function splitLead(text: string): [string, string] | null {
  const t = text.trim();
  const m = /\n{2,}/.exec(t);
  if (!m) return null;
  const lead = t.slice(0, m.index);
  if (lead.includes("```")) return null;
  const rest = t.slice(m.index).trim();
  return rest ? [lead, rest] : null;
}

const INLINE_CODE_PAT = "`[^`\\n]+`";
const INLINE_MATH_PAT = String.raw`(?<!\\)\$(?=[^\s$])(?:\\\$|[^$\n])*?(?:\\\$|[^\s$\\])\$(?!\d)`;
const BOLD_PAT = String.raw`\*\*(?:${INLINE_MATH_PAT}|${INLINE_CODE_PAT}|[^*\n])+?\*\*`;
const EMPH_STAR_PAT = String.raw`(?<![\w*])\*(?:${INLINE_MATH_PAT}|${INLINE_CODE_PAT}|[^*\s\n])(?:${INLINE_MATH_PAT}|${INLINE_CODE_PAT}|[^*\n])*?\*(?![\w*])`;
const EMPH_UNDER_PAT = String.raw`(?<![\w_])_(?:${INLINE_MATH_PAT}|${INLINE_CODE_PAT}|[^_\s\n])(?:${INLINE_MATH_PAT}|${INLINE_CODE_PAT}|[^_\n])*?_(?![\w_])`;

export const INLINE = new RegExp(
  `(${INLINE_CODE_PAT}|\\$\\$[^$\\n]+?\\$\\$|\\\\\\$|${INLINE_MATH_PAT}|${BOLD_PAT}|${EMPH_STAR_PAT}|${EMPH_UNDER_PAT})`,
  "g",
);

const MATH_ONLY = /(\$\$[^$\n]+?\$\$|(?<!\\)\$(?=[^\s$])(?:\\\$|[^$\n])*?(?:\\\$|[^\s$\\])\$(?!\d))/g;

/**
 * Renders only $...$ and $$...$$ math inside learner-written beats while leaving underscores
 * (like `x_1`, `1_i`) and asterisks (like `sigma**2`) completely untouched as literal text.
 */
export function mathOnly(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  for (const [i, piece] of text.split(MATH_ONLY).entries()) {
    if (!piece) continue;
    if (i % 2 === 0) out.push(piece);
    else if (piece.startsWith("$$")) {
      const tex = piece.slice(2, -2).trim();
      out.push(<span class="myl-math app-math-display" data-tex={tex} innerHTML={mathHtml(tex, true)} />);
    } else {
      const tex = piece.slice(1, -1);
      out.push(<span class="myl-math" data-tex={tex} innerHTML={mathHtml(tex, false)} />);
    }
  }
  return out;
}

export function inlineCodeClass(code: string): string {
  if (code.length <= 3) return "app-code is-bare";
  if (code.length <= 24) return "app-code is-nowrap";
  return "app-code";
}

export function inline(text: string, depth = 0): JSX.Element[] {
  const out: JSX.Element[] = [];
  text.split("\n").forEach((line, li) => {
    if (li > 0) out.push(<br />);
    for (const [i, piece] of line.split(INLINE).entries()) {
      if (!piece) continue;
      if (i % 2 === 0) out.push(piece);
      else if (piece === "\\$") out.push("$");
      else if (piece.startsWith("`")) {
        const code = piece.slice(1, -1);
        out.push(<code class={inlineCodeClass(code)}>{code}</code>);
      } else if (piece.startsWith("$$")) {
        const tex = piece.slice(2, -2).trim();
        out.push(<span class="myl-math app-math-display" data-tex={tex} innerHTML={mathHtml(tex, true)} />);
      } else if (piece.startsWith("$")) {
        const tex = piece.slice(1, -1);
        out.push(<span class="myl-math" data-tex={tex} innerHTML={mathHtml(tex, false)} />);
      } else if (piece.startsWith("**")) {
        const inner = piece.slice(2, -2);
        out.push(<strong>{depth < 3 ? inline(inner, depth + 1) : inner}</strong>);
      } else {
        const inner = piece.slice(1, -1);
        out.push(<em>{depth < 3 ? inline(inner, depth + 1) : inner}</em>);
      }
    }
  });
  return out;
}

function CodeBlock(props: { text: string }) {
  let preEl: HTMLPreElement | undefined;
  const [overflowLeft, setOverflowLeft] = createSignal(false);
  const [overflowRight, setOverflowRight] = createSignal(false);

  const syncOverflow = () => {
    if (!preEl) return;
    const maxScroll = preEl.scrollWidth - preEl.clientWidth;
    if (maxScroll <= 2) {
      setOverflowLeft(false);
      setOverflowRight(false);
      return;
    }
    setOverflowLeft(preEl.scrollLeft > 2);
    setOverflowRight(preEl.scrollLeft < maxScroll - 2);
  };

  onSettled(() => {
    syncOverflow();
    if (!preEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncOverflow);
    ro.observe(preEl);
    return () => ro.disconnect();
  });

  return (
    <div
      class="myl-code"
      data-overflow-left={overflowLeft() ? "true" : undefined}
      data-overflow-right={overflowRight() ? "true" : undefined}
    >
      <pre ref={preEl} onScroll={syncOverflow}>
        {props.text}
      </pre>
    </div>
  );
}

export function Body(props: { text: string }) {
  return (
    <>
      {blocks(props.text).map((b) => {
        switch (b.kind) {
          case "code":
            return <CodeBlock text={b.text} />;
          case "math":
            return <div class="myl-math app-math-display" data-tex={b.tex} innerHTML={mathHtml(b.tex, true)} />;
          case "h":
            return <h3 class="v2-msg-heading">{inline(b.text)}</h3>;
          case "quote":
            return <blockquote class="v2-msg-quote">{inline(b.text)}</blockquote>;
          case "ul":
            return (
              <ul class="v2-msg-list">
                {b.items.map((it) => (
                  <li>{inline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol class="v2-msg-list">
                {b.items.map((it) => (
                  <li>{inline(it)}</li>
                ))}
              </ol>
            );
          default:
            return <p>{inline(b.text)}</p>;
        }
      })}
    </>
  );
}
