import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { Keyboard } from "lucide-react";

import "./KeyBar.css";

import type { KeyBarExtra, KeyBarKey, StickyModifiers } from "../lib/keys.ts";
import { keyBarItemId, keyBarItemLabel, type KeyBarItem, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { useT } from "../lib/i18n.ts";

export type { KeyBarKey };

export interface KeyBarProps {
  disabled?: boolean;
  /** Modifier buttons toggle; other keys go to the terminal. */
  onKey: (item: KeyBarKeyItem) => void;
  modifiers: StickyModifiers;
  onToggleModifier: (modifier: keyof StickyModifiers) => void;
  items: readonly KeyBarItem[];
  /** on a touch screen: whether the keyboard types straight into the terminal (else the input line) */
  directTyping?: boolean;
  onToggleDirect?: () => void;
}

/**
 * Cancelling pointerdown AND mousedown keeps focus, and with it the soft
 * keyboard, on xterm's textarea; the click still fires.
 */
function keepFocus(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

interface KeyProps {
  disabled?: boolean;
  dataKey: string;
  label?: string;
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
}

function Key({ dataKey, label, pressed, onPress, children, disabled }: KeyProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`key${pressed ? " is-armed" : ""}`}
      data-key={dataKey}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

type Direction = "up" | "down" | "left" | "right";

const CHEVRON: Record<Direction, string> = {
  up: "M5 12.5l5-5 5 5",
  down: "M5 7.5l5 5 5-5",
  left: "M12.5 5l-5 5 5 5",
  right: "M7.5 5l5 5-5 5",
};

function Chevron({ direction }: { direction: Direction }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHEVRON[direction]} />
    </svg>
  );
}

export const ARROWS: ReadonlyArray<{ key: KeyBarKey; label: string; direction: Direction }> = [
  { key: "ArrowUp", label: "Up", direction: "up" },
  { key: "ArrowDown", label: "Down", direction: "down" },
  { key: "ArrowLeft", label: "Left", direction: "left" },
  { key: "ArrowRight", label: "Right", direction: "right" },
];

/** Legacy single-key aliases: their caps and spoken names where a cap does not read as one. */
export const EXTRA_KEY_CAPS: Partial<Record<KeyBarExtra, { cap: string; label?: string }>> = {
  "ctrl-d": { cap: "^D", label: "Control D" },
  "ctrl-z": { cap: "^Z", label: "Control Z" },
  pipe: { cap: "|" },
  tilde: { cap: "~" },
  slash: { cap: "/" },
};

/**
 * Touch key bar under the terminal. Keys are tabIndex -1 on purpose: they exist
 * for touch, a hardware keyboard already has all of them. Hence role="group", not
 * toolbar: a toolbar promises arrow-key navigation between items, which these skip.
 */
export function KeyBar({ onKey, modifiers, onToggleModifier, items, directTyping, onToggleDirect, disabled }: KeyBarProps) {
  const t = useT();
  return (
    <div className="key-bar" role="group" aria-label={t("Terminal keys")}>
      {/* first: on a narrow cover screen the row scrolls, and the mode toggle must not be the key cut off */}
      {onToggleDirect && (
        <Key disabled={disabled} dataKey="direct" label={t("Type straight into the terminal")} pressed={directTyping} onPress={onToggleDirect}>
          <Keyboard aria-hidden="true" />
        </Key>
      )}
      {items.map((item) => {
        if (item.type === "modifier") {
          const cap = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" }[item.modifier];
          const dataKey = { ctrl: "Control", alt: "Alt", shift: "Shift" }[item.modifier];
          return <Key key={keyBarItemId(item)} disabled={disabled} dataKey={dataKey} pressed={modifiers[item.modifier]} onPress={() => onToggleModifier(item.modifier)}>{cap}</Key>;
        }
        const arrow = ARROWS.find((candidate) => candidate.key === item.key);
        const extra = EXTRA_KEY_CAPS[item.key as KeyBarExtra];
        const label = item.modifiers !== undefined ? t("Press {key}", { key: keyBarItemLabel(item) })
          : arrow ? t(arrow.label)
          : item.key === "ctrl-c" ? t("Control C")
          : item.key === "BackTab" ? t("Shift Tab")
          : item.key === "PageUp" ? t("Page up")
          : item.key === "PageDown" ? t("Page down")
          : extra?.label ? t(extra.label) : undefined;
        return <Key key={keyBarItemId(item)} disabled={disabled} dataKey={item.modifiers === undefined ? item.key : keyBarItemId(item)} label={label} onPress={() => onKey(item)}>
          {arrow && item.modifiers === undefined ? <Chevron direction={arrow.direction} /> : keyBarItemLabel(item)}
        </Key>;
      })}
    </div>
  );
}
