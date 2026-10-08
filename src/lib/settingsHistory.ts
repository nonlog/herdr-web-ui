/**
 * Settings in the browser's history. The system Back button (Android's, a swipe from the screen's
 * edge) traverses history, and a dialog that is no entry of it is skipped: Back left the app
 * instead of the page. So each step into Settings is an entry above the app: the dialog, the
 * page a phone opens from its list, the key bar editor. Back takes them off one at a time.
 *
 * The dialog says what is shown as a list of levels (`recordSettings`); this module makes the
 * history hold exactly those entries, pushing the missing ones and stepping back over the ones
 * no longer shown (a Back control in the dialog, its X, Escape). It tells its listeners when a
 * traversal lands, and whether it was one of its own.
 */

const KEY = "herdr-web-ui:settings";
/** how long a traversal this module asked for may take to land before it is given up */
const LANDING_MS = 1000;

/** One step into Settings: the page shown (null: a phone's list of pages) and the key bar editor over it. */
export interface SettingsLevel {
  page: string | null;
  keyBar: boolean;
}

export interface SettingsEntry extends SettingsLevel {
  /** how many entries of Settings the history holds up to this one */
  depth: number;
}

/**
 * What the dialog shows, as the steps that led there. A phone lists the pages first, so its
 * list is a step of its own; a wider dialog opens on a page, and turning to another replaces it.
 */
export function settingsLevels(narrow: boolean, page: string | null, keyBar: boolean): SettingsLevel[] {
  const levels: SettingsLevel[] = narrow ? [{ page: null, keyBar: false }] : [];
  if (page !== null) levels.push({ page, keyBar: false });
  if (page !== null && keyBar) levels.push({ page, keyBar: true });
  return levels;
}

/** The Settings entry a history state holds, or null: state is whatever another script left there. */
export function settingsEntry(state: unknown): SettingsEntry | null {
  if (state === null || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[KEY];
  if (entry === null || typeof entry !== "object") return null;
  const { page, keyBar, depth } = entry as Record<string, unknown>;
  if ((page !== null && typeof page !== "string") || typeof keyBar !== "boolean") return null;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 3) return null;
  return { page, keyBar, depth };
}

type Listener = (entry: SettingsEntry | null, own: boolean) => void;
const listeners = new Set<Listener>();
let wanted: readonly SettingsLevel[] = [];
/** the steps this module knows the history holds for Settings, by depth; null for one it did not push and cannot see */
let held: Array<SettingsLevel | null> = [];
const same = (a: SettingsLevel | null, b: SettingsLevel): boolean => a !== null && a.page === b.page && a.keyBar === b.keyBar;
/** traversals asked for here that have not landed yet: nothing is pushed while one is under way */
let rewinding = 0;
let landing: ReturnType<typeof setTimeout> | undefined;

function rewind(by: number): void {
  rewinding += 1;
  clearTimeout(landing);
  // a traversal that never lands (the entries are gone) must not hold the history forever
  landing = setTimeout(() => { rewinding = 0; reconcile(); }, LANDING_MS);
  window.history.go(-by);
}

function reconcile(): void {
  if (rewinding > 0) return;
  const state: unknown = window.history.state;
  const current = settingsEntry(state);
  const have = current?.depth ?? 0;
  // what the history holds up to here: a Back landed under what was recorded; the step shown is
  // read from the state; one this module did not push (a reload or a Forward landed on entries
  // of an earlier opening) is unknown, never taken on trust, and rebuilt like a differing one
  held = held.slice(0, have);
  while (held.length < have) held.push(null);
  if (have > 0 && current) held[have - 1] = { page: current.page, keyBar: current.keyBar };
  if (have > wanted.length) { rewind(have - wanted.length); return; }
  // the first step that differs from what is wanted. An earlier one (the window changed width:
  // a phone's list belongs under a page a wider dialog had opened directly, or no longer does)
  // is stepped back to and the steps above it are made anew
  let differs = 0;
  while (differs < have && differs < wanted.length && same(held[differs]!, wanted[differs]!)) differs++;
  if (differs < have - 1) { rewind(have - differs - 1); return; }
  const base = state !== null && typeof state === "object" ? state : {};
  if (have > 0 && differs === have - 1) {
    // the step shown is another: a wider dialog turned its page, or the list took a page's place
    window.history.replaceState({ ...base, [KEY]: { ...wanted[have - 1], depth: have } }, "");
    held[have - 1] = wanted[have - 1]!;
  }
  for (let depth = have + 1; depth <= wanted.length; depth++) {
    window.history.pushState({ ...base, [KEY]: { ...wanted[depth - 1], depth } }, "");
    held.push(wanted[depth - 1]!);
  }
}

/** Makes the history hold these steps into Settings, in order; none when the dialog is closed. */
export function recordSettings(levels: readonly SettingsLevel[]): void {
  wanted = levels;
  if (typeof window !== "undefined") reconcile();
}

/**
 * Tells when the history moved: the Settings entry it landed on (null: under the dialog), and
 * whether the move was this module's own stepping back, which the dialog already shows.
 */
export function onSettingsHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", (event) => {
    const own = rewinding > 0;
    if (own) {
      rewinding -= 1;
      if (rewinding === 0) clearTimeout(landing);
    }
    const entry = settingsEntry(event.state);
    for (const listener of [...listeners]) listener(entry, own);
    // what was asked for while the traversal was under way is done now
    if (own) reconcile();
  });
  // a reload keeps the history and not the dialog: step out of the entries it left
  const left = settingsEntry(window.history.state);
  if (left !== null) rewind(left.depth);
}
