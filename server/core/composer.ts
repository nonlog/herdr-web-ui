/**
 * The screen work behind a chat send that reads no server state: clearing a Claude or Hermes
 * input box before a message, the message's own shape, and the refusal a draft earns. Pending
 * delivery and the immediate send share them.
 */
import type { HerdrPane } from "../../shared/protocol.ts";
import { HerdrError, paneGet, paneRead, paneScrollInfo, paneSendKeys } from "../herdr/client.ts";
import { claudeClearableDraft, claudeInputBoxContent, claudeInputDraft, claudeRestoredDraft, codexQuestionsCollapsed, hermesInputDraft, lastChatSubmitted, viewportShowsLive } from "../prompt.ts";
import { type PendingIdentity, PendingInputError } from "../pending-input.ts";

const CLAUDE_INPUT_DRAFT_MESSAGE = "Claude Code's input box is not empty (a draft, bash mode, or a box that could not be read); send or clear it in the terminal, then send this message";

const HERMES_INPUT_DRAFT_MESSAGE = "Hermes' input in the terminal is not empty (a draft, or an input that could not be read); send or clear it there, then send this message";

/**
 * input_draft, naming the one-row draft the chat may offer to clear (claudeClearableDraft), or none.
 * `box`: the input box as read, whole (claudeInputBoxContent; the client is shown it cut), which a refusal naming no draft shows so the
 * user may send anyway; null where the refusal offers nothing (after a clear began).
 */
export class InputDraftError extends HerdrError {
  readonly draft: string | null;
  constructor(draft: string | null, readonly identity?: PendingIdentity, readonly box: string | null = null, message = CLAUDE_INPUT_DRAFT_MESSAGE) {
    super("input_draft", message);
    this.draft = draft;
  }
}

/** between the two Esc presses that empty Claude Code's restored copy of the chat's message */
const RESTORED_CLEAR_GAP_MS = 200;

/** after them, before the box is read again */
const RESTORED_CLEAR_SETTLE_MS = 300;

/** what a send must still have of its deadline before the copy is cleared: the clear, the box read again, then the send */
const RESTORED_CLEAR_RESERVE_MS = 2_000;

/**
 * A message whose last word is an `@file` mention leaves the agent's file suggestions open over
 * it, and the Enter after the paste takes the suggestion instead of sending: the message stays in
 * the input box (Claude Code 2.1.295, #404). A space after the mention closes them first; a
 * payload already in bracketed-paste markers gets it inside them.
 */
export const closeMention = (text: string): string => {
  const open = text.startsWith("\u001b[200~") ? "\u001b[200~" : "";
  const close = open && text.endsWith("\u001b[201~") ? "\u001b[201~" : "";
  const body = text.slice(open.length, text.length - close.length);
  return /(?:^|\s)@\S+$/.test(body) ? `${open}${body} ${close}` : text;
};

/** Is this pane's agent Codex, blocked only by questions waiting collapsed in its queue (codexQuestionsCollapsed)? */
export async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
  const pane = await paneGet(paneId).catch((error: unknown) => {
    if (error instanceof HerdrError && error.code === "pane_not_found") return undefined;
    throw error;
  });
  if ((pane?.agent ?? pane?.agent_session?.agent) !== "codex") return false;
  // A collapsed queue in scrollback must not bypass an approval on the live screen.
  return codexQuestionsCollapsed((await paneRead({ paneId, source: "detection", format: "text" })).text);
}

export const pendingIdentity = (pane: HerdrPane): PendingIdentity => ({
  agent: pane.agent ?? pane.agent_session?.agent ?? null, terminalId: pane.terminal_id,
  session: pane.agent_session ? `${pane.agent_session.kind}:${pane.agent_session.source}:${pane.agent_session.value}` : null,
});

export const pendingText = (text: string): string => {
  const normalized = text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim() || normalized.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new HerdrError("invalid_submit_text", "A pending chat message must be nonempty text, at most 20000 characters, without terminal control characters");
  }
  return normalized;
};

export const pendingFault = (error: unknown) => ({
  code: error instanceof HerdrError || error instanceof PendingInputError ? error.code : "submit_failed",
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Hermes' input, refused with input_draft unless hermesInputDraft knows it empty. As claudeBoxReads,
 * the viewport's colors are read only for an input row with text, and count only once
 * viewportShowsLive verifies them; the live read comes last, so text typed meanwhile is in it.
 * Hermes offers nothing to clear from here: the user sends or clears it in the terminal.
 */
export async function freeHermesInput(paneId: string, identity?: PendingIdentity): Promise<void> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!hermesInputDraft(before, null)) return;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (hermesInputDraft(live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null)) {
    throw new InputDraftError(null, identity, null, HERMES_INPUT_DRAFT_MESSAGE);
  }
}

export async function claudeBoxReads(paneId: string): Promise<[string, string | null]> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!claudeInputDraft(before, null)) return [before, null];
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  return [live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null];
}

/**
 * The box check both chat sends share: a Claude Code input box that is not known to be empty is
 * refused, except the chat's own last message, which Claude puts back as typed text when the send
 * right after it is cancelled. That copy, while the agent is not working, two Esc presses empty
 * again — never Ctrl+C, which would arm "press Ctrl-C again to exit" — then the box is read once
 * more before the send. Every other draft, and a box still not empty after them, refuses as before.
 * `authorize` throws once the sender may no longer send: it is asked before each Esc, and again
 * right before herdr is written to. A send with less than RESTORED_CLEAR_RESERVE_MS left before its
 * `deadline` clears nothing: it would erase the copy, then time out without sending.
 */
export async function freeClaudeBox(paneId: string, working: boolean, authorize: () => void, deadline: number): Promise<void> {
  const allowed = (): boolean => { try { authorize(); return true; } catch { return false; } };
  const [live, colors] = await claudeBoxReads(paneId);
  if (!claudeInputDraft(live, colors)) return;
  if (working || claudeRestoredDraft(live, colors, lastChatSubmitted(paneId)) === null) {
    throw new InputDraftError(claudeClearableDraft(live, colors), undefined, claudeInputBoxContent(live));
  }
  if (deadline - Date.now() < RESTORED_CLEAR_RESERVE_MS) throw new HerdrError("submit_timeout", "Too little time was left to clear Claude Code's input box and send; nothing was typed");
  // the read proved the box holds the copy: a lone Esc on an EMPTY box would open Claude's
  // rewind dialog instead
  authorize();
  await paneSendKeys(paneId, ["esc"], undefined, allowed);
  // fixed wait: Claude Code takes the second Esc only after a gap
  await Bun.sleep(RESTORED_CLEAR_GAP_MS);
  authorize();
  await paneSendKeys(paneId, ["esc"], undefined, allowed);
  // fixed wait: the box redraws after the two Esc presses before it reads empty
  await Bun.sleep(RESTORED_CLEAR_SETTLE_MS);
  if (claudeInputDraft(...await claudeBoxReads(paneId))) throw new HerdrError("input_draft", CLAUDE_INPUT_DRAFT_MESSAGE);
}
