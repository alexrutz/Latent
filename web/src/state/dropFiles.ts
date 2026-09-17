import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dropping a picture onto the thing that wants one.
 *
 * The gesture a desktop has and a phone does not, and its absence is the kind
 * of gap you notice by *trying*: the reference photo is in a folder, the folder
 * is open beside the browser, you drag it across — and nothing happens, so you
 * go and find the file picker instead. Every program that takes an image has
 * accepted a drop for thirty years; an app that does not reads as a web page.
 *
 * Three things it has to get right, and the last is the one that is usually
 * wrong:
 *
 * 1. **Say it is a target before the drop.** A drag that gives no feedback is a
 *    drag you abort, because there is nothing to tell you it will land.
 * 2. **Take only what it can use.** A dropped `.txt` should leave the field
 *    exactly as it was rather than clearing it or erroring.
 * 3. **Count the enters and leaves.** `dragleave` fires when the pointer
 *    crosses onto a *child* element, so a target that flips off at every leave
 *    flickers the whole time the pointer is over anything inside it. A depth
 *    counter is the only version of this that does not flicker.
 *
 * The page as a whole must also refuse a drop, or missing the target replaces
 * the app with the picture in a browser tab — see `refuseStrayDrops`.
 */
export function useFileDrop(
  onFiles: (files: File[]) => void,
  { accept = 'image/' }: { accept?: string } = {},
) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setOver(false);
  }, []);

  /** Spread onto the element that should accept the drop. */
  const props = {
    onDragEnter: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the browser keeps its own "no drop" cursor and never
      // fires `drop` at all — the one line that makes any of this work.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      reset();
      const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith(accept));
      if (files.length > 0) onFiles(files);
    },
  };

  return { props, over };
}

/** Whether this drag is carrying files rather than selected text or a link. */
function hasFiles(event: React.DragEvent): boolean {
  return [...event.dataTransfer.types].includes('Files');
}

/**
 * The images on the clipboard, if any.
 *
 * Pasting a screenshot is how a picture most often arrives at a desk — you crop
 * something, or a chat client hands you one — and the alternative is saving it
 * to disk first purely so a file picker has something to point at.
 *
 * Returns nothing for a paste carrying text, which is the overwhelmingly common
 * case and must go where it was typed.
 */
export function pastedImages(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * The rest of the window refuses what it is handed.
 *
 * A browser's default for a file dropped on a page is to *navigate to it* —
 * so missing the target by twenty pixels replaces the app with a PNG in a tab,
 * and everything set up on the form is gone. That is a far worse outcome than
 * the drop simply not working, and one line at the top prevents it.
 *
 * The real targets call `preventDefault` themselves and never see this, because
 * their handlers run first and the event stops being defaulted at all.
 */
export function useRefuseStrayDrops(): void {
  useEffect(() => {
    const refuse = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.type === 'drop' && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);
}
