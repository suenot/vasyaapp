import { create } from 'zustand';

interface ComposerDraft { text: string; file: File | null; error: string | null; sending: boolean; revision: number }
export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: '', file: null, error: null, sending: false, revision: 0 };
/** Memory-only: pending translation must not erase a draft when its chat unmounts. */
export const useComposerDraftStore = create<{
  drafts: Record<string, ComposerDraft>;
  update: (context: string, patch: Partial<Omit<ComposerDraft, 'revision'>>) => void;
}>((set) => ({
  drafts: {},
  update: (context, patch) => set(state => {
    const old = state.drafts[context] ?? EMPTY_COMPOSER_DRAFT;
    const edited = ('text' in patch && patch.text !== old.text) || ('file' in patch && patch.file !== old.file);
    return { drafts: { ...state.drafts, [context]: { ...old, ...patch, revision: old.revision + Number(edited) } } };
  }),
}));
