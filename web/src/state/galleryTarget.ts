import { create } from 'zustand';

import type { GenerationImage } from '@latent/shared';

/**
 * "Open this exact picture in the gallery."
 *
 * A one-shot handoff, like the Generate screen's. Routing state would survive a
 * back navigation and re-open the viewer every time you returned to the tab,
 * which is the sort of thing that makes a back button feel broken — so this is
 * consumed once and forgotten.
 *
 * It carries the image rather than only an id because the gallery addresses a
 * picture by run *and* file: two runs can hold the same file name, and the id
 * alone would land on whichever the gallery happened to list first.
 */
export interface GalleryTarget {
  generationId: string;
  image: GenerationImage;
}

interface GalleryTargetStore {
  target: GalleryTarget | null;
  show: (generationId: string, image: GenerationImage) => void;
  consume: () => GalleryTarget | null;
}

export const useGalleryTargetStore = create<GalleryTargetStore>((set, get) => ({
  target: null,
  show: (generationId, image) => set({ target: { generationId, image } }),
  consume: () => {
    const current = get().target;
    if (current) set({ target: null });
    return current;
  },
}));

/** Ask the gallery to open a picture, from wherever you are. */
export function showInGallery(generationId: string, image: GenerationImage): void {
  useGalleryTargetStore.getState().show(generationId, image);
}
