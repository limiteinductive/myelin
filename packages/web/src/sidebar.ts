// Pure sidebar helpers: clean plain-text single-line labels (no KaTeX/code pill jank)
// and priority-preserving topic grouping so large drill queues stay calm and scannable.
import type { QueueUnit } from "./drillApi.js";

export interface TopicGroup {
  /** Stable normalized key for collapse/expand state. */
  key: string;
  /** Display title for the group header (e.g. "Borzoi genomics" or "General"). */
  title: string;
  /** Due units in this topic, in scheduler priority order. */
  items: QueueUnit[];
}

const TEX_COMMANDS: Record<string, string> = {
  "\\alpha": "α",
  "\\beta": "β",
  "\\gamma": "γ",
  "\\delta": "δ",
  "\\epsilon": "ε",
  "\\varepsilon": "ε",
  "\\zeta": "ζ",
  "\\eta": "η",
  "\\theta": "θ",
  "\\vartheta": "θ",
  "\\iota": "ι",
  "\\kappa": "κ",
  "\\lambda": "λ",
  "\\mu": "μ",
  "\\nu": "ν",
  "\\xi": "ξ",
  "\\pi": "π",
  "\\rho": "ρ",
  "\\sigma": "σ",
  "\\tau": "τ",
  "\\phi": "φ",
  "\\varphi": "φ",
  "\\chi": "χ",
  "\\psi": "ψ",
  "\\omega": "ω",
  "\\Gamma": "Γ",
  "\\Delta": "Δ",
  "\\Theta": "Θ",
  "\\Lambda": "Λ",
  "\\Pi": "Π",
  "\\Sigma": "Σ",
  "\\Phi": "Φ",
  "\\Psi": "Ψ",
  "\\Omega": "Ω",
  "\\sum": "∑",
  "\\prod": "∏",
  "\\int": "∫",
  "\\infty": "∞",
  "\\partial": "∂",
  "\\nabla": "∇",
  "\\approx": "≈",
  "\\neq": "≠",
  "\\ne": "≠",
  "\\le": "≤",
  "\\leq": "≤",
  "\\ge": "≥",
  "\\geq": "≥",
  "\\pm": "±",
  "\\times": "×",
  "\\cdot": "·",
  "\\to": "→",
  "\\rightarrow": "→",
  "\\leftarrow": "←",
  "\\Rightarrow": "⇒",
  "\\iff": "⇔",
  "\\in": "∈",
  "\\notin": "∉",
  "\\subset": "⊂",
  "\\subseteq": "⊆",
  "\\forall": "∀",
  "\\exists": "∃",
  "\\ell": "ℓ",
};

const BLACKBOARD: Record<string, string> = {
  R: "ℝ",
  N: "ℕ",
  Z: "ℤ",
  Q: "ℚ",
  C: "ℂ",
  E: "𝔼",
  P: "ℙ",
};

function simplifyTex(expr: string): string {
  let s = expr;
  // Remove sizing/style wrappers first
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, "");
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\mathbb\{([A-Z])\}/g, (_, ch: string) => BLACKBOARD[ch] ?? ch);
  s = s.replace(/\\hat\{([a-zA-Z])\}/g, "$1\u0302");
  s = s.replace(/\\bar\{([a-zA-Z])\}/g, "$1\u0304");
  s = s.replace(/\\tilde\{([a-zA-Z])\}/g, "$1\u0303");
  s = s.replace(/\\vec\{([a-zA-Z])\}/g, "$1");
  // Simple fractions & roots
  for (let i = 0; i < 2; i++) {
    s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2");
    s = s.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  }
  // Drop verbose summation bounds so sidebar labels stay crisp
  s = s.replace(/\\sum(?:_\{[^{}]*\}|_[a-zA-Z0-9])?(?:\^\{[^{}]*\}|\^[a-zA-Z0-9])?/g, "∑");
  s = s.replace(/\\prod(?:_\{[^{}]*\}|_[a-zA-Z0-9])?(?:\^\{[^{}]*\}|\^[a-zA-Z0-9])?/g, "∏");
  // Named math functions
  s = s.replace(/\\(tanh|sinh|cosh|sin|cos|tan|exp|log|ln|min|max|arg\s*max|arg\s*min|softmax|sigmoid|dim|det|tr)\b/g, "$1");
  // Greek & symbols
  s = s.replace(/\\[a-zA-Z]+/g, (cmd) => TEX_COMMANDS[cmd] ?? "");
  // Clean remaining TeX braces & spacing commands
  s = s.replace(/\\[,;:! ]/g, " ");
  s = s.replace(/[{}]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Converts markdown + inline/display TeX into crisp single-line plain text suitable for
 * narrow sidebar rows and tooltips (no jagged KaTeX heights or inline code boxes).
 */
export function plainSidebarText(raw: string): string {
  if (!raw) return "";
  let s = raw.replace(/\r?\n+/g, " ");
  // Display and inline TeX blocks
  s = s.replace(/\$\$([^$]+)\$\$/g, (_, inner: string) => simplifyTex(inner));
  s = s.replace(/(?<!\\)\$([^$\n]+)\$/g, (_, inner: string) => simplifyTex(inner));
  // Inline code & emphasis
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

const LEADIN_PATTERNS: readonly RegExp[] = [
  /^you want to\s+/i,
  /^suppose you want to\s+/i,
  /^suppose you have\s+/i,
  /^suppose that\s+/i,
  /^imagine you(?:'re| are)\s+/i,
];

/**
 * Builds a concise, spoiler-free plain-text label for a drill item in the sidebar.
 * Strips noisy markdown/KaTeX and trims empty meta-lead-ins while keeping full context.
 */
export function formatSidebarDrillLabel(
  prompt: string | null | undefined,
  fallback: string,
): string {
  const clean = plainSidebarText(prompt ?? "");
  if (!clean) return plainSidebarText(fallback);
  for (const re of LEADIN_PATTERNS) {
    if (re.test(clean)) {
      const trimmed = clean.replace(re, "");
      if (trimmed.length >= 12) {
        return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
      }
    }
  }
  return clean;
}

/**
 * Groups due queue items by topic (case-insensitive, preserving scheduler priority order:
 * whichever group holds the highest-priority item appears first).
 */
export function groupQueueByTopic(items: readonly QueueUnit[]): TopicGroup[] {
  const byKey = new Map<string, TopicGroup>();
  const order: TopicGroup[] = [];
  for (const item of items) {
    const rawTitle = (item.topic ?? "").replace(/\s+/g, " ").trim();
    const title = rawTitle || "General";
    const key = title.toLowerCase();
    let group = byKey.get(key);
    if (!group) {
      group = { key, title, items: [] };
      byKey.set(key, group);
      order.push(group);
    }
    group.items.push(item);
  }
  return order;
}

export interface SidebarCounts {
  /** Cards in the current sitting. */
  due: number;
  /** Due cards waiting behind the current sitting. */
  backlog: number;
  /** Cards finished this session. */
  done: number;
  archived: number;
  briefings: number;
}

export interface SidebarLayout {
  /** Practice section: shown for live work, or to keep the Done fold reachable. */
  practice: boolean;
  /** Done fold, closing the Practice section. */
  done: boolean;
  /** Archived fold, closing the always-present Explorations section. */
  archived: boolean;
  /** Briefings, a section of its own after Explorations. */
  briefings: boolean;
}

/**
 * Which optional parts of the sidebar render. Finished things live with their kind:
 * Done belongs to Practice and Archived to Explorations, never in a shared footer.
 */
export function sidebarLayout(c: SidebarCounts): SidebarLayout {
  const done = c.done > 0;
  return {
    practice: c.due > 0 || c.backlog > 0 || done,
    done,
    archived: c.archived > 0,
    briefings: c.briefings > 0,
  };
}
