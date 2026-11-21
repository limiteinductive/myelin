// Replying to a passage of a thread message: the learner selects it, and the composer quotes it.

/** A selected passage of a thread message. */
export interface Quote {
  message_id: string;
  text: string;
}

/** The thread message a node sits in, by its `data-line`. */
export function lineOf(n: Node | null): HTMLElement | null {
  const el = n instanceof Element ? n : (n?.parentElement ?? null);
  return el?.closest<HTMLElement>("[data-line]") ?? null;
}

/**
 * The selected text as the message wrote it: math goes back to its TeX between dollar signs, and a
 * selection that cuts into a formula takes the whole formula.
 */
export function quoteText(range: Range): string {
  const r = range.cloneRange();
  const formula = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest(".katex") ?? null;
  const first = formula(r.startContainer);
  if (first) r.setStartBefore(first);
  const last = formula(r.endContainer);
  if (last) r.setEndAfter(last);
  const frag = r.cloneContents();
  for (const k of Array.from(frag.querySelectorAll(".katex"))) {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const display = k.parentElement?.classList.contains("katex-display") ?? false;
    const dollars = display ? "$$" : "$";
    k.replaceWith(tex == null ? (k.querySelector(".katex-html")?.textContent ?? "") : dollars + tex + dollars);
  }
  for (const b of Array.from(frag.querySelectorAll("p, li, pre, blockquote, h1, h2, h3, h4"))) b.append(" ");
  return (frag.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

/** Marks the quoted passage while the composer replies to it, without touching the message's DOM. */
export function markQuote(range: Range | null): void {
  try {
    if (range) CSS.highlights.set("myl-quote", new Highlight(range));
    else CSS.highlights.delete("myl-quote");
  } catch {
    // No highlight API: the line above the composer still says what is quoted.
  }
}
