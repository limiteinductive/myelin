// Code in the composer: the plus button starts a fenced block, and inside one Enter starts a new line.

const FENCE = /^```/;

/** Whether a caret at `at` sits inside a fenced code block: an odd number of fence lines start before it. */
export function inFence(text: string, at: number): boolean {
  let open = false;
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const stop = end < 0 ? text.length : end;
    // A fence line counts once the caret is past its backticks.
    if (start + 3 > at) break;
    if (FENCE.test(text.slice(start, stop))) open = !open;
    if (end < 0 || end >= at) break;
    start = end + 1;
  }
  return open;
}

/**
 * The edit that starts a code block at the selection: the selected text goes inside it, and the
 * fences sit on lines of their own. `caret` is where the cursor goes after the edit.
 */
export function insertFence(text: string, from: number, to: number): { from: number; to: number; insert: string; caret: number } {
  const inside = text.slice(from, to).replace(/^\n+|\n+$/g, "");
  const before = from > 0 && text[from - 1] !== "\n" ? "\n" : "";
  const after = to < text.length && text[to] !== "\n" ? "\n" : "";
  const insert = `${before}\`\`\`\n${inside}\n\`\`\`${after}`;
  const caret = from + before.length + 4 + inside.length;
  return { from, to, insert, caret };
}
