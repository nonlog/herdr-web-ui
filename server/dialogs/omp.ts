import type { DialogReader } from "./registry.ts";
import { type InteractivePromptAnswer } from "../../shared/protocol.ts";
import { ANSI_RE, KEY, type MenuRow, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, nearestQuestion, normalizeText, wrapped } from "./shared.ts";

const OMP_OPTION_MARKER_RE = /^([ \t]*)(?:[❯›>]\s*)?([○●◉◯☐☑☒✓])/;

export const OMP_SINGLE_HINT_RE = /(?:enter|⏎)\s+select.*↑\/↓\s*move.*(?:esc|⎋)\s*cancel/i;

// A legacy single-question footer can clip after the Tab keys or inside the cancel label.
export const OMP_SINGLE_CLIPPED_HINT_RE = /enter select.*n note.*↑\/↓ move.*(?:tab\/←\/→|esc(?: c(?:a(?:n(?:c(?:e(?:l)?)?)?)?)?)?)(?:…|\.{3})$/i;

// A narrow footer can cut the question-navigation word at any letter, followed by an ellipsis.
export const OMP_CLIPPED_SINGLE_HINT_RE = /(?:enter|⏎)\s+select.*\bn\s+note.*↑\/↓\s*move.*(?:tab|⇥).*\b(?:question…?|(?:q|qu|que|ques|quest|questi|questio)…)(?=\s|$)/i;

export const OMP_MULTI_HINT_RE = /(?:space\/enter toggle|(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next)).*↑\/↓\s*move.*(?:esc|⎋)\s*cancel/i;

export const OMP_REVIEW_HINT_RE = /(?:enter|⏎)\s+submit.*↑\/↓\s*scroll.*(?:esc|⎋)\s*cancel/i;

const OMP_TABS_HINT_RE = /(?:tab|⇥).*?(?:←|left).*?(?:→|right)|(?:←|left).*?(?:→|right).*?(?:tab|⇥)/i;

/** OMP options have a marker; their descriptions and wrapped labels are indented below them. */
function parseOmpRows(lines: string[], startDivider: number, endDivider: number): MenuRow[] | null {
  const rows: MenuRow[] = [];
  const marker = "○●◉◯☐☑☒✓";
  const selectedRows = lines.slice(startDivider + 1, endDivider).map((line, index) => {
    const raw = line.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
    const match = raw.match(/^\s*(?:❯|›|>)\s*[○●◉◯☐☑☒✓]/);
    return match ? { raw, lineIndex: startDivider + 1 + index, markerColumn: match[0].search(/[○●◉◯☐☑☒✓]/) } : null;
  }).filter((row): row is { raw: string; lineIndex: number; markerColumn: number } => row !== null);
  if (selectedRows.length !== 1) return null;
  const markerColumn = selectedRows[0]!.markerColumn;
  for (let index = startDivider + 1; index < endDivider; index += 1) {
    const raw = lines[index]!.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
    const prefix = raw.slice(0, markerColumn);
    const glyph = raw[markerColumn] ?? "";
    const option = marker.includes(glyph) && (/^\s*$/.test(prefix) || /^\s*(?:❯|›|>)\s*$/.test(prefix));
    if (option) {
      const label = normalizeText(raw.slice(markerColumn + 1));
      if (label) rows.push({
        label, selected: /(?:❯|›|>)\s*$/.test(prefix), checked: /^[☑☒✓]/.test(glyph), lineIndex: index,
      });
      continue;
    }
    const row = rows.at(-1);
    if (!row) continue;
    const description = raw.match(/^\s*↳\s*(.*)$/);
    const indentation = raw.match(/^\s*/)?.[0].length ?? 0;
    const continuation = raw.trim();
    if (description) row.description = normalizeText([row.description, description[1]!].filter(Boolean).join(" "));
    else if (row.description && indentation >= markerColumn + 4 && continuation) row.description = normalizeText(`${row.description} ${continuation}`);
    else if (!row.description && indentation >= markerColumn + 4 && continuation) row.description = normalizeText(continuation);
    else if (!row.description && indentation >= markerColumn + 2 && continuation) row.label = normalizeText(`${row.label} ${continuation}`);
    else if (continuation) return null;
  }
  return rows;
}

function ompQuestionText(lines: string[], startDivider: number, hasQuestionTabs: boolean): string | null {
  const panelTop = findLastIndex(lines, (_, index) => index < startDivider && /^\s*╭/.test(lines[index]!));
  const headerDivider = panelTop >= 0 ? panelTop
    : findLastIndex(lines, (_, index) => index < startDivider && isDivider(lines[index]!));
  if (headerDivider < 0) return nearestQuestion(lines, startDivider);
  const headerRows = lines.slice(headerDivider + 1, startDivider);
  // With question navigation, OMP draws its tab bar before the question title. Drop its leading
  // rows by position and the tab cells' extra left padding, not by their text: the strip can wrap
  // to one cell per row or clip its final tab, and the question can itself end in `Submit`.
  const firstHeaderRow = headerRows.findIndex((line) => cleanLine(line));
  let tabRows = 0;
  if (hasQuestionTabs) {
    for (let index = firstHeaderRow; index >= 0 && index < headerRows.length; index += 1) {
      if (!isOmpTabStripRow(headerRows[index]!)) break;
      tabRows += 1;
      if (isOmpSubmitTabRow(headerRows[index]!)) break;
    }
  }
  const header = headerRows.map((line, index) => ({ line: cleanLine(line), index })).filter(({ line, index }) => line
    && !(hasQuestionTabs && index >= firstHeaderRow && index < firstHeaderRow + tabRows)
    && !/^[←→].*Submit/i.test(line) && !/^[☐☑✔]\s+\S/.test(line) && !/^Question \d+\/\d+/i.test(line)).map(({ line }) => line);
  return header.length > 0 ? normalizeText(header.join(" ")) : nearestQuestion(lines, startDivider);
}

/** The panel adds one space; TabBar cells start with one space, plus a wrapped separator when present. */
function isOmpTabStripRow(rawLine: string): boolean {
  const raw = ompTabRowText(rawLine);
  const indentation = raw.match(/^\s*/)?.[0].length ?? 0;
  return (indentation === 2 || indentation === 4) && Boolean(raw.trim());
}

/** Stop at the final visible tab so following indented question text is never consumed as tabs. */
function isOmpSubmitTabRow(rawLine: string): boolean {
  const cells = ompTabRowText(rawLine).trim().split(/\s{2,}/).map((cell) => cell.trim());
  return cells.at(-1) === "Submit";
}

function ompTabRowText(rawLine: string): string {
  return rawLine.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
}

const OMP_REVIEW_ROW_RE = /^\d+\.\s+(.*?):(?:\s+(.*))?$/;

const OMP_REVIEW_NOTE_RE = /^Note:\s*(.*)$/;

/**
 * omp's review: a row per question (`1. Transport: Remote relay`), a `Note: …` under an answer
 * given one. omp cuts a long row at the pane's edge instead of wrapping it. Null when a line is
 * neither, so the panel is shown as drawn.
 */
function ompReviewAnswers(panel: string[]): InteractivePromptAnswer[] | null {
  const answers: InteractivePromptAnswer[] = [];
  for (const line of panel) {
    const row = OMP_REVIEW_ROW_RE.exec(line);
    const note = OMP_REVIEW_NOTE_RE.exec(line);
    if (row) answers.push({ question: row[1]!.trim(), answer: row[2]?.trim() || null });
    else if (note && answers.length > 0 && answers.at(-1)!.note === undefined) answers.at(-1)!.note = note[1]!.trim();
    // the warning over the rows ("1 unanswered question; Enter still submits.") stays the body
    else if (answers.length > 0) return null;
  }
  return answers.length > 0 ? answers : null;
}

/** The Submit tab is a separate review state: Enter submits, Esc cancels the native dialog. */
function parseOmpSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMP_REVIEW_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const panelTop = findLastIndex(lines, (_, index) => index < hintIndex && /^\s*╭/.test(lines[index]!));
  if (panelTop < 0) return null;
  const heading = findLastIndex(lines, (line, index) => index > panelTop && index < hintIndex && cleanLine(line) === "Review answers");
  if (heading < 0) return null;
  const submitRows = lines.flatMap((line, index) => {
    if (index <= heading || index >= hintIndex) return [];
    return /^\s*[❯›>]\s*Submit\s*$/i.test(cleanLine(line)) ? [index] : [];
  });
  if (submitRows.length !== 1) return null;
  const submitRow = submitRows[0]!;
  const panel = lines.slice(heading + 1, submitRow).map(cleanLine).filter((line) => line && !isDivider(line));
  const answers = ompReviewAnswers(panel);
  // without answers read, the panel as it is drawn; with them, only what is not an answer (the
  // unanswered-questions warning)
  const body = (answers ? panel.filter((line) => !OMP_REVIEW_ROW_RE.test(line) && !OMP_REVIEW_NOTE_RE.test(line)) : panel).join("\n");
  return finishPrompt("omp", {
    kind: "menu", title: "Review answers", question: "Submit these answers?", body: body || null,
    ...(answers ? { answers } : {}),
    options: [{ label: "Submit", description: null }, { label: "Cancel", description: null }],
    multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-submit", menuLabels: ["Submit", "Cancel"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: 1,
  });
}

/** A clipped legacy footer is enough to identify a menu only when every parsed row
 * starts with an option marker in the cursor row's physical column. */
function ompRowsHaveAlignedMarkers(lines: string[], rows: MenuRow[]): boolean {
  const markerColumn = (lineIndex: number): number | null => {
    let line = lines[lineIndex]?.replace(ANSI_RE, "") ?? "";
    if (line.startsWith("│")) line = line.slice(1);
    const match = OMP_OPTION_MARKER_RE.exec(line);
    return match ? match[1]!.length + (match[0].length - match[1]!.length - match[2]!.length) : null;
  };
  const selected = rows.filter((row) => row.selected);
  if (selected.length !== 1) return false;
  const selectedColumn = markerColumn(selected[0]!.lineIndex);
  return selectedColumn !== null && rows.every((row) => markerColumn(row.lineIndex) === selectedColumn);
}

function findMenuDividers(lines: string[], hintIndex: number): [number, number] | null {
  let end = -1;
  for (let index = hintIndex - 1; index >= 0; index -= 1) {
    if (!isDivider(lines[index]!)) continue;
    if (end < 0) end = index;
    else return [index, end];
  }
  return null;
}

function parseOmpQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const clippedHintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_CLIPPED_HINT_RE.test(wrapped(lines, index)));
  const hintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_HINT_RE.test(wrapped(lines, index))
    || OMP_CLIPPED_SINGLE_HINT_RE.test(wrapped(lines, index)) || OMP_SINGLE_CLIPPED_HINT_RE.test(wrapped(lines, index)) || OMP_MULTI_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const dividers = findMenuDividers(lines, hintIndex);
  if (!dividers) return null;
  const [startDivider, endDivider] = dividers;
  const rows = parseOmpRows(lines, startDivider, endDivider);
  if (!rows) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^Other \(type your own\)$/i.test(row.label));
  const optionRows = rows.filter((_, index) => index !== customIndex);
  const hint = wrapped(lines, hintIndex);
  const multiSelect = OMP_MULTI_HINT_RE.test(hint);
  const currentMulti = /(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next)/i.test(hint);
  const question = ompQuestionText(lines, startDivider, OMP_TABS_HINT_RE.test(hint));
  if (!question || selectedIndex < 0 || optionRows.length === 0 || customIndex !== rows.length - 1
    || (hintIndex === clippedHintIndex && !ompRowsHaveAlignedMarkers(lines, rows))) return null;
  return finishPrompt("omp", {
    kind: "question", title: multiSelect ? "Multiple choice" : "Question", question, body: null,
    options: optionRows.map((row) => ({ label: row.label.replace(/ \(Recommended\)$/i, ""), description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : optionRows.length,
  }, {
    responder: "omp-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex, rejectWithEscapeIndex: null,
    // OMP's Other row opens its own text prompt on Enter. The ordinary Enter in
    // the question dialog selects an option, so keep the activation step explicit.
    ...(!multiSelect ? { customSteps: (text: string) => [
      ...keySteps(navigationKeys(customIndex - selectedIndex)),
      ...keySteps([KEY.enter]), { text }, ...keySteps([KEY.enter]),
    ] } : {}),
    ...(currentMulti ? { multiSteps: (choices: number[]) => {
      const desired = new Set(choices);
      const checked = new Set(optionRows.flatMap((row, index) => row.checked ? [index] : []));
      const toggles = optionRows.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
      let cursor = selectedIndex;
      const keys: string[] = [];
      for (const index of toggles) {
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      // Current OMP advances/finishes the active question on Enter. Tab changes
      // the active question and would make that Enter answer a different row.
      // Enter on the Other row opens its text editor instead of advancing.
      if (cursor === customIndex) keys.push(KEY.up);
      keys.push(KEY.enter);
      return keySteps(keys);
    } } : {}),
  });
}

function parseOmpApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => /^\s*Allow tool:\s*\S+/i.test(cleanLine(line)));
  if (headerIndex < 0) return null;
  const rows: MenuRow[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const match = cleanLine(lines[index]!).match(/^([›>❯•])?\s*(Approve|Deny)$/i);
    if (match) rows.push({ label: match[2]!, selected: Boolean(match[1]), checked: false, lineIndex: index });
  }
  if (rows.length !== 2 || rows.filter((row) => row.selected).length !== 1) return null;
  return finishPrompt("omp", {
    kind: "approval", title: cleanLine(lines[headerIndex]!), question: cleanLine(lines[headerIndex]!),
    body: lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine).filter(Boolean).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

export const readers: readonly DialogReader[] = [
  {
    id: "omp-question", agents: ["omp"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpQuestion(screen);
      return parsed?.responder === "omp-question" ? parsed : null;
    },
  },
  {
    id: "omp-submit", agents: ["omp"], priority: 20,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpSubmit(screen);
      return parsed?.responder === "omp-submit" ? parsed : null;
    },
  },
  {
    id: "omp-approval", agents: ["omp"], priority: 30,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpApproval(screen);
      return parsed?.responder === "omp-approval" ? parsed : null;
    },
  },
];
