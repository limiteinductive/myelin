// Message text to elements. Only a small, safe subset: paragraphs, line breaks, fenced code,
// inline code, math, bold and italic. Everything else shows as typed. No HTML is ever parsed; math
// is KaTeX's own output for the TeX between the dollar signs.
import type { JSX } from "@solidjs/web";
import { mathHtml } from "./math.js";

type Block = { kind: "p"; text: string } | { kind: "code"; text: string };

export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const parts = text.split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/\n$/, "");
      if (code) out.push({ kind: "code", text: code });
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      const t = para.trim();
      if (t) out.push({ kind: "p", text: t });
    }
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

const INLINE = /(`[^`\n]+`|\$\$[^$\n]+?\$\$|\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?!\d)|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*])|(?<![\w_])_[^_\s][^_\n]*?_(?![\w_]))/g;

export function inline(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  text.split("\n").forEach((line, li) => {
    if (li > 0) out.push(<br />);
    for (const [i, piece] of line.split(INLINE).entries()) {
      if (!piece) continue;
      if (i % 2 === 0) out.push(piece);
      else if (piece.startsWith("`")) out.push(<code class="app-code">{piece.slice(1, -1)}</code>);
      else if (piece.startsWith("$$")) out.push(<span class="myl-math app-math-display" innerHTML={mathHtml(piece.slice(2, -2).trim(), true)} />);
      else if (piece.startsWith("$")) out.push(<span class="myl-math" innerHTML={mathHtml(piece.slice(1, -1), false)} />);
      else if (piece.startsWith("**")) out.push(<strong>{piece.slice(2, -2)}</strong>);
      else out.push(<em>{piece.slice(1, -1)}</em>);
    }
  });
  return out;
}

export function Body(props: { text: string }) {
  return (
    <>
      {blocks(props.text).map((b) =>
        b.kind === "code" ? (
          <div class="myl-code">
            <pre>{b.text}</pre>
          </div>
        ) : (
          <p>{inline(b.text)}</p>
        ),
      )}
    </>
  );
}
