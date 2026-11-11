import { create } from 'zustand';

/** Multi-select state for the chat list (bulk leave). Separate from the
 *  message selection store: different list, different lifetime. */
interface ChatSelectionState {
  active: boolean;
  ids: Set<number>;
  anchor: number | null;

  enter: (initialId?: number) => void;
  exit: () => void;
  toggle: (id: number) => void;
  /** Select every id between the anchor and `id` (inclusive) in list order. */
  rangeTo: (orderedIds: number[], id: number) => void;
  selectMany: (ids: number[]) => void;
  clear: () => void;
  remove: (ids: number[]) => void;
}

export const useChatSelectionStore = create<ChatSelectionState>((set, get) => ({
  active: false,
  ids: new Set(),
  anchor: null,

  enter: (initialId) =>
    set({
      active: true,
      ids: initialId == null ? new Set() : new Set([initialId]),
      anchor: initialId ?? null,
    }),
  exit: () => set({ active: false, ids: new Set(), anchor: null }),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.ids);
      if (!next.delete(id)) next.add(id);
      return { ids: next, anchor: id };
    }),
  rangeTo: (orderedIds, id) => {
    const { anchor, ids } = get();
    const from = anchor == null ? -1 : orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(id);
    if (from < 0 || to < 0) {
      get().toggle(id);
      return;
    }
    const [a, b] = from < to ? [from, to] : [to, from];
    const next = new Set(ids);
    for (let i = a; i <= b; i++) next.add(orderedIds[i]);
    set({ ids: next, anchor: id });
  },
  selectMany: (list) => set((s) => ({ ids: new Set([...s.ids, ...list]) })),
  clear: () => set({ ids: new Set(), anchor: null }),
  remove: (list) =>
    set((s) => {
      const next = new Set(s.ids);
      list.forEach((id) => next.delete(id));
      return { ids: next };
    }),
}));

/** Only channels and groups can be bulk-left; private chats hold history. */
export const isBulkLeavable = (chatType: string | undefined) =>
  chatType === 'channel' || chatType === 'group';
