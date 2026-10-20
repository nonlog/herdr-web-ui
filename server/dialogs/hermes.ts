import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type AnswerStep, KEY, type ParsedPrompt, findLastIndex, finishPrompt, keySteps, navigationKeys } from "./shared.ts";

/**
 * Hermes's clarify question, as its Ink TUI draws it (ui-tui/src/components/prompts.tsx):
 *
 *   ask 1 question
 *   ▸ Pick a colour
 *     ▸ 1. Red (Recommended)
 *       2. Blue
 *       3. Other (type your answer)
 *   0/1 answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel
 *
 * An open question, or "Other" once picked, shows a `> ` line instead of the rows. A batch of
 * questions shows each one's line (✓ answered, · waiting) and expands only the active (▸) one,
 * so the card is that question; the next one becomes the next card.
 */
export const HERMES_HINT_RE = /^(\d+)\/(\d+) answered · /;

const HERMES_ASK_RE = /^ask \d+ questions?$/;

const HERMES_ROW_RE = /^(▸ )?(\[[ x]\] )?(\d+)\. (.+)$/;

const HERMES_OTHER = "Other (type your answer)";

function parseHermesClarify(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const hintIndex = findLastIndex(lines, (line) => HERMES_HINT_RE.test(line.trim()));
  if (hintIndex < 0) return null;
  const askIndex = findLastIndex(lines.slice(0, hintIndex), (line) => HERMES_ASK_RE.test(line.trim()));
  if (askIndex < 0) return null;
  const block = lines.slice(askIndex + 1, hintIndex).filter((line) => line.trim());
  const indent = (line: string) => line.length - line.trimStart().length;
  const at = block.findIndex((line) => line.trimStart().startsWith("▸ ") && !HERMES_ROW_RE.test(line.trim()));
  if (at < 0) return null;
  const base = indent(block[at]!);
  // the question wraps at its own indent; its rows (or `> ` line) sit deeper
  let end = at + 1;
  while (end < block.length && indent(block[end]!) === base && !/^[▸·✓] /.test(block[end]!.trim())) end += 1;
  const question = block.slice(at, end).map((line) => line.trim()).join(" ").slice(2);
  const member: string[] = [];
  for (let i = end; i < block.length && indent(block[i]!) > base; i += 1) member.push(block[i]!.trim());
  const [answered, total] = lines[hintIndex]!.trim().match(HERMES_HINT_RE)!.slice(1).map(Number);
  const body = total! > 1 ? `${answered}/${total} answered` : null;
  // text already on the `>` line (typed in the terminal, or a typed answer Tab brought back)
  // would join the answer: the line is emptied first, after the cursor and before it (its
  // TextInput's ctrl+k and ctrl+u, on every platform)
  const typed = (text: string): AnswerStep[] => [...keySteps(["ctrl+k", "ctrl+u"]), { text }, ...keySteps([KEY.enter])];
  if (member[0]?.startsWith(">")) {
    return finishPrompt("hermes", {
      kind: "question", title: "Question", question, body,
      options: [{ label: "Type your answer", description: null }], multi_select: false, custom_option_index: 0,
    }, {
      responder: "hermes-input", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0,
      rejectWithEscapeIndex: null, customSteps: typed,
    });
  }
  const rows: { label: string; selected: boolean; box: boolean; checked: boolean }[] = [];
  for (const line of member) {
    const row = line.match(HERMES_ROW_RE);
    if (row && Number(row[3]) === rows.length + 1) rows.push({ label: row[4]!, selected: Boolean(row[1]), box: Boolean(row[2]), checked: row[2] === "[x] " });
    else if (rows.length) rows.at(-1)!.label += ` ${line}`; // a label wrapped onto the next line
    else return null;
  }
  if (rows.length < 2 || rows.at(-1)!.label !== HERMES_OTHER) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (selectedIndex < 0) return null;
  const choices = rows.slice(0, -1);
  // a multi-select question draws a box on every choice; its Other row has none
  const multi = choices.every((row) => row.box);
  if (!multi && choices.some((row) => row.box)) return null;
  const checked = choices.flatMap((row, index) => row.checked ? [index] : []);
  return finishPrompt("hermes", {
    kind: "question", title: "Question", question, body,
    options: choices.map((row) => ({ label: row.label.replace(/ \(Recommended\)$/i, ""), description: null })),
    // typed text on a multi-select question joins the ticks, which the card has no way to say
    multi_select: multi, custom_option_index: multi ? null : choices.length,
  }, {
    responder: "hermes-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    checkedOptionIndices: checked, customMenuIndex: multi ? null : choices.length, rejectWithEscapeIndex: null,
    // Enter on the Other row opens its `>` line
    ...(multi ? {} : { customSteps: (text: string) => [...keySteps([...navigationKeys(choices.length - selectedIndex), KEY.enter]), ...typed(text)] }),
    // Space ticks the row under the cursor; Enter then locks the ticked rows
    ...(multi ? { multiSteps: (picked: number[]) => {
      const want = new Set(picked);
      let cursor = selectedIndex;
      const keys: string[] = [];
      for (const index of choices.keys()) {
        if (want.has(index) === checked.includes(index)) continue;
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      // Enter on the Other row opens its text line instead of locking the ticks
      if (cursor === choices.length) keys.push(KEY.up);
      return keySteps([...keys, KEY.enter]);
    } } : {}),
  });
}

export const readers: readonly DialogReader[] = [
  {
    id: "hermes-question", agents: ["hermes"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseHermesClarify(screen);
      return parsed?.responder === "hermes-question" ? parsed : null;
    },
  },
  {
    id: "hermes-input", agents: ["hermes"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseHermesClarify(screen);
      return parsed?.responder === "hermes-input" ? parsed : null;
    },
  },
];
