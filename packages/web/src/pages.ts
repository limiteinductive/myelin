// The pages, folded from their events with the same code the server uses, so both agree on every
// document, revision and passage. A refused edit never reaches the log, so one that fails here is a
// bug: it is skipped and logged, as the server's reducer records it as an anomaly.
import { applyPageEdit, applyPageRun, newPage, pageLines, type MyelinEvent, type PageState } from "@myelin/core";

export function foldPages(events: readonly MyelinEvent[], into: Record<string, PageState> = {}): Record<string, PageState> {
  for (const e of events) {
    if (e.type === "page.created") {
      const p = e.payload;
      into[p.page_id] ??= newPage(p.page_id, p.title, p.starter ?? null, e.ts, p.probe ?? null);
    } else if (e.type === "page.edited") {
      const page = into[e.payload.page_id];
      if (!page) continue;
      try {
        applyPageEdit(page, e.payload.base_rev, e.payload.steps, e.ts);
      } catch (err) {
        console.warn(`page edit ${e.id} skipped: ${(err as Error).message}`);
      }
    } else if (e.type === "page.ran") {
      const page = into[e.payload.page_id];
      if (page) applyPageRun(page, { rev: e.payload.rev, blocks: e.payload.blocks ?? [], timed_out: e.payload.timed_out ?? false }, e.ts);
    }
  }
  return into;
}

/** A page is in progress while it is the one being worked on: the latest touched, within half an hour. */
export const IN_PROGRESS_MS = 30 * 60_000;

export function pageStatus(page: PageState, pages: Readonly<Record<string, PageState>>, now: number, open: string | null): "in progress" | "kept" {
  if (open === page.id) return "in progress";
  const latest = Object.values(pages).reduce<PageState | null>((a, p) => (!a || p.edited_at > a.edited_at ? p : a), null);
  return latest?.id === page.id && now - page.edited_at < IN_PROGRESS_MS ? "in progress" : "kept";
}

/** One or two plain facts for the page link. No time: time is shown only in timed runs and debriefs. */
export function pageFacts(page: PageState, asked = 0): string {
  const written = pageLines(page).filter((l) => l.kind !== "problem" && l.text.trim() !== "").length;
  if (written === 0) return page.starter ? "A problem, not started" : "Nothing written yet";
  const lines = `${written} ${written === 1 ? "line" : "lines"}`;
  if (asked > 0) return `${lines}, ${asked} ${asked === 1 ? "question" : "questions"} from the tutor`;
  return lines;
}
