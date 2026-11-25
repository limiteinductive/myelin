// Lightweight, zero-chrome code-typing ergonomics for the unified Myelin pad:
//   - Tab: inserts 4 spaces (or indents all selected lines when multi-line)
//   - Shift+Tab: dedents the current line (or all selected lines) by up to 4 spaces / 1 tab
//   - Enter: carries leading indentation and adds +4 spaces after `:`, `{`, `(`, or `[`

export interface TextEditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const INDENT = "    ";

export function applyTabIndent(
  value: string,
  start: number,
  end: number,
  shiftKey: boolean,
): TextEditResult | null {
  const hasNewlineInSel = value.slice(start, end).includes("\n");

  if (!shiftKey && !hasNewlineInSel) {
    const next = value.slice(0, start) + INDENT + value.slice(end);
    const pos = start + INDENT.length;
    return { value: next, selectionStart: pos, selectionEnd: pos };
  }

  // Operate on the full lines touched by [start, end]
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEndIdx = value.indexOf("\n", effectiveEnd);
  const blockEnd = lineEndIdx === -1 ? value.length : lineEndIdx;

  const block = value.slice(lineStart, blockEnd);
  const lines = block.split("\n");

  let firstDelta = 0;
  let totalDelta = 0;
  const nextLines = lines.map((line, idx) => {
    if (!shiftKey) {
      if (idx === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    }
    let remove = 0;
    if (line.startsWith("\t")) {
      remove = 1;
    } else {
      while (remove < INDENT.length && line[remove] === " ") remove++;
    }
    if (idx === 0) firstDelta = -remove;
    totalDelta -= remove;
    return line.slice(remove);
  });

  if (totalDelta === 0) return null;

  const nextValue = value.slice(0, lineStart) + nextLines.join("\n") + value.slice(blockEnd);
  const nextStart = Math.max(lineStart, start + firstDelta);
  const nextEnd = Math.max(nextStart, end + totalDelta);
  return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
}

export function applyAutoIndentEnter(value: string, start: number, end: number): TextEditResult | null {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const beforeCursor = value.slice(lineStart, start);
  const leadingMatch = beforeCursor.match(/^[ \t]*/);
  const baseIndent = leadingMatch ? leadingMatch[0] : "";
  const trimmedBefore = beforeCursor.trimEnd();
  const opensBlock = /[:{([\[]$/.test(trimmedBefore);
  const indent = opensBlock ? baseIndent + INDENT : baseIndent;
  if (!indent) return null;

  const insert = "\n" + indent;
  const nextValue = value.slice(0, start) + insert + value.slice(end);
  const pos = start + insert.length;
  return { value: nextValue, selectionStart: pos, selectionEnd: pos };
}

/**
 * Handles Tab / Shift+Tab / Enter auto-indent on a textarea. Returns true if the event was handled.
 */
export function handlePadIndentKey(
  e: KeyboardEvent & { currentTarget: HTMLTextAreaElement },
  onChange: (nextValue: string) => void,
): boolean {
  const el = e.currentTarget;
  if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const res = applyTabIndent(el.value, el.selectionStart, el.selectionEnd, e.shiftKey);
    if (res) {
      el.value = res.value;
      el.setSelectionRange(res.selectionStart, res.selectionEnd);
      onChange(res.value);
    }
    return true;
  }
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    const res = applyAutoIndentEnter(el.value, el.selectionStart, el.selectionEnd);
    if (res) {
      e.preventDefault();
      el.value = res.value;
      el.setSelectionRange(res.selectionStart, res.selectionEnd);
      onChange(res.value);
      return true;
    }
  }
  return false;
}
