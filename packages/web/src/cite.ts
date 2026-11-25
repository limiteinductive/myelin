// Text-selection citation helpers for citing parts of prompts or coach responses.

export interface Citation {
  id: string;
  /** Exact quoted passage (preserving TeX math delimiters like $...$ when KaTeX nodes are selected). */
  text: string;
  /** Optional learner-authored comment or question attached to this quote. */
  comment: string;
}

function texOfMathEl(el: Element): string | null {
  const attr = el.getAttribute("data-tex");
  if (attr && attr.trim()) return attr.trim();
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  const t = ann?.textContent?.trim();
  return t || null;
}

function closestMath(node: Node | null): Element | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1) {
      const el = cur as Element;
      if (el.classList.contains("myl-math") || el.classList.contains("katex")) {
        return el.closest(".myl-math") ?? el;
      }
    }
    cur = cur.parentNode;
  }
  return null;
}

/** Returns true if a DOM Range touches or contains any rendered KaTeX math element. */
export function selectionHasMath(range: Range): boolean {
  if (closestMath(range.startContainer) || closestMath(range.endContainer)) return true;
  const frag = range.cloneContents();
  return Boolean(frag.querySelector(".myl-math, .katex"));
}

/**
 * Extracts clean text from a DOM selection Range, turning KaTeX spans back into $...$ / $$...$$
 * instead of duplicating MathML + HTML glyphs.
 */
export function extractSelectionText(range: Range): string {
  const startMath = closestMath(range.startContainer);
  const endMath = closestMath(range.endContainer);

  // Selection lies wholly inside a single rendered KaTeX formula
  if (startMath && startMath === endMath) {
    const tex = texOfMathEl(startMath);
    if (tex) {
      const isDisplay = startMath.classList.contains("app-math-display");
      return isDisplay ? `$$${tex}$$` : `$${tex}$`;
    }
  }

  // Clone a copy of the range, snapping partial math endpoints outward so formulas aren't mangled.
  const expanded = range.cloneRange();
  if (startMath) expanded.setStartBefore(startMath);
  if (endMath) expanded.setEndAfter(endMath);

  const frag = expanded.cloneContents();
  const wrap = document.createElement("div");
  wrap.appendChild(frag);

  // Replace every rendered math span with its clean TeX source
  const mathEls = Array.from(wrap.querySelectorAll(".myl-math, .katex"));
  for (const el of mathEls) {
    if (!wrap.contains(el)) continue;
    const tex = texOfMathEl(el);
    if (tex) {
      const isDisplay = el.classList.contains("app-math-display");
      el.replaceWith(document.createTextNode(isDisplay ? `$$${tex}$$` : `$${tex}$`));
    } else {
      // Fallback: strip invisible MathML duplicate if annotation wasn't present
      el.querySelectorAll(".katex-mathml").forEach((n) => n.remove());
    }
  }

  // Preserve explicit line breaks and block boundaries when copying multi-paragraph passages
  wrap.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
  wrap.querySelectorAll("p, li, h1, h2, h3, blockquote, pre").forEach((el) => {
    if (el.previousSibling) el.before(document.createTextNode("\n"));
  });

  return normalizeCitedText(wrap.textContent ?? "");
}

export function normalizeCitedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Short label shown on a composer citation chip (comment when present, otherwise clipped quote). */
export function citationLabel(c: Pick<Citation, "text" | "comment">, maxLen = 40): string {
  const comment = c.comment.replace(/\s+/g, " ").trim();
  const base = comment || c.text.replace(/\s+/g, " ").trim();
  if (base.length <= maxLen) return base;
  const sliced = base.slice(0, maxLen - 1).trimEnd();
  // Avoid leaving an unclosed $ delimiter when truncating a quoted formula
  const dollars = (sliced.match(/(?<!\\)\$/g) ?? []).length;
  return `${dollars % 2 === 1 ? sliced.replace(/\$[^$]*$/, "").trimEnd() : sliced}…`;
}

/**
 * Formats citations + optional message body into a clean text payload for the coach LLM.
 * Each quote is rendered as a markdown blockquote with its optional comment right below it.
 */
export function formatCitedMessage(citations: readonly Citation[], body: string): string {
  const parts: string[] = [];
  for (const c of citations) {
    const q = c.text.trim();
    if (!q) continue;
    const quoted = q
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const comment = c.comment.trim();
    parts.push(comment ? `${quoted}\n${comment}` : quoted);
  }
  const rest = body.trim();
  if (rest) parts.push(rest);
  return parts.join("\n\n");
}
