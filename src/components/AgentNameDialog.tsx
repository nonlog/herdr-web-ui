/**
 * The live name of the agent in a pane, as `herdr agent rename` sets it: what other tools address
 * the agent by (`herdr agent prompt <name>`). herdr's rule (shared/agent-name.ts) is checked as the
 * name is typed, and a refusal of herdr's own (a name another live agent holds, an agent that has
 * since gone) is shown in its words. Clear takes the name away. Escape and the scrim close the
 * dialog, Tab stays inside it, and focus goes back to what opened it.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import "./AgentNameDialog.css";

import { AGENT_NAME_MAX_LENGTH, isAgentName } from "../../shared/agent-name.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

interface Props {
  paneId: string;
  /** what the row calls the pane: the dialog's title names it */
  title: string;
  /** the agent's name now, or null */
  current: string | null;
  onClose: () => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export function AgentNameDialog({ paneId, title, current, onClose }: Props) {
  const t = useT();
  const id = useId();
  const { renameAgent } = useMachineApi();
  const [name, setName] = useState(current ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLFormElement>(true, { initialFocus: field });

  // the name there now is selected, so typing a new one replaces it
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => field.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending, surface]);

  const typed = name.trim();
  const invalid = typed !== "" && !isAgentName(typed);
  const unchanged = typed === (current ?? "");

  const apply = async (next: string | null): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await renameAgent(paneId, next);
      onClose();
    } catch (reason: unknown) {
      setError(said(reason));
      setPending(false);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (typed === "" || invalid || unchanged) return;
    void apply(typed);
  };
  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal agent-name-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Agent name · {name}", { name: title })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close agent name dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <p className="agent-name-lead">{t("The name other tools address this agent by, unique among the running agents and gone when the agent exits.")}</p>
          <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              ref={field}
              className="input agent-name-input"
              value={name}
              disabled={pending}
              maxLength={AGENT_NAME_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${id}-rule` : `${id}-hint`}
              placeholder="reviewer"
              onChange={(event) => { setName(event.target.value); setError(null); }}
            />
            {invalid
              ? <span className="field-hint agent-name-error" id={`${id}-rule`} role="alert">{t("A name starts with a lowercase letter and goes on with lowercase letters, digits, - or _, up to 32 characters.")}</span>
              : <span className="field-hint" id={`${id}-hint`}>{t("Other tools reach it with:")} <code className="agent-name-command">herdr agent prompt {typed || "<name>"}</code></span>}
          </label>
          {error && <p className="field-hint agent-name-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          {current !== null && <button type="button" className="btn" disabled={pending} onClick={() => void apply(null)}>{t("Clear name")}</button>}
          <button type="submit" className="btn btn-primary" disabled={pending || typed === "" || invalid || unchanged}>{t("Save name")}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
