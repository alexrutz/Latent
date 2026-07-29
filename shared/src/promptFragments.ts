/**
 * Adding and removing saved fragments from a comma-separated prompt.
 *
 * A prompt block only makes sense once per prompt, so tapping its chip is a
 * toggle: the first tap appends the fragment, the second takes it back out.
 * That means the code has to *recognise* a fragment that is already present,
 * across the whitespace and ordering differences that creep in once someone
 * edits the prompt by hand.
 *
 * Pure: no I/O, no React.
 */

/** Split on commas, drop empties, and normalise the spacing of each part. */
export function splitPrompt(prompt: string): string[] {
  return prompt
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function joinPrompt(parts: string[]): string {
  return parts.join(', ');
}

/** Case- and whitespace-insensitive comparison of two prompt fragments. */
function sameFragment(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Is every part of `fragment` already in `prompt`?
 *
 * A block can itself hold several comma-separated instructions, and it counts as
 * present only when all of them are — otherwise a half-removed block could never
 * be toggled back off.
 */
export function promptContainsFragment(prompt: string, fragment: string): boolean {
  const wanted = splitPrompt(fragment);
  if (wanted.length === 0) return false;

  const present = splitPrompt(prompt);
  return wanted.every((part) => present.some((candidate) => sameFragment(candidate, part)));
}

export function addFragment(prompt: string, fragment: string): string {
  const parts = splitPrompt(prompt);
  for (const part of splitPrompt(fragment)) {
    // Never duplicate something already there, even mid-prompt.
    if (!parts.some((candidate) => sameFragment(candidate, part))) parts.push(part);
  }
  return joinPrompt(parts);
}

export function removeFragment(prompt: string, fragment: string): string {
  const unwanted = splitPrompt(fragment);
  const parts = splitPrompt(prompt).filter(
    (part) => !unwanted.some((candidate) => sameFragment(candidate, part)),
  );
  return joinPrompt(parts);
}

/** Add the fragment if absent, remove it if present. */
export function toggleFragment(prompt: string, fragment: string): string {
  return promptContainsFragment(prompt, fragment)
    ? removeFragment(prompt, fragment)
    : addFragment(prompt, fragment);
}
