const KEY = 'latent.promptDraft';

/**
 * The prompt text currently on the Generate screen, readable from other tabs.
 *
 * The Random tab previews draws by asking the server what a real submit would
 * produce, and with "keep what I typed" on that includes the typed prompt. Since
 * the two live on different screens now, the text has to survive leaving one —
 * a preview built on an empty base would quietly show the wrong thing.
 *
 * localStorage rather than a store because it should also survive a reload, and
 * wrapped because Safari throws on it in private browsing.
 */
export function savePromptDraft(text: string): void {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* Not worth failing a keystroke over. */
  }
}

export function readPromptDraft(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}
