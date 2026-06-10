import { create } from 'zustand';
import { invoke, subscribe } from '../transport';

export interface GroupCallParticipant {
  userId: number;
  name?: string;
  isMuted: boolean;
  isSelf: boolean;
  isSpeaking: boolean;
  volume?: number;
  canSelfUnmute: boolean;
  videoJoined: boolean;
  raiseHandRating?: number;
  source: number;
}

export interface GroupCallInfo {
  callId: number;
  accessHash: number;
  chatId: number;
  title?: string;
  state: 'idle' | 'creating' | 'joining' | 'active' | 'leaving';
  participantsCount: number;
}

interface GroupCallStore {
  activeGroupCall: GroupCallInfo | null;
  participants: GroupCallParticipant[];
  isMuted: boolean;
  error: string | null;

  createGroupCall: (accountId: string, chatId: number, title?: string) => Promise<void>;
  joinGroupCall: (accountId: string, callId: number, accessHash: number, chatId: number) => Promise<void>;
  leaveGroupCall: (accountId: string) => Promise<void>;
  toggleMute: (accountId: string) => Promise<void>;
  loadParticipants: (accountId: string) => Promise<void>;
  clearGroupCall: () => void;
  setupListeners: () => () => void;
}

export const useGroupCallStore = create<GroupCallStore>()((set, get) => ({
  activeGroupCall: null,
  participants: [],
  isMuted: false,
  error: null,

  createGroupCall: async (accountId, chatId, title) => {
    try {
      set({
        error: null,
        activeGroupCall: {
          callId: 0,
          accessHash: 0,
          chatId,
          title,
          state: 'creating',
          participantsCount: 0,
        },
      });

      const result = await invoke<{ callId: number; accessHash: number; chatId: number; title?: string }>('create_group_call', {
        accountId,
        chatId,
        title,
      });

      set({
        activeGroupCall: {
          callId: result.callId,
          accessHash: result.accessHash,
          chatId: result.chatId,
          title: result.title || title,
          state: 'active',
          participantsCount: 1,
        },
      });
    } catch (err) {
      set({
        activeGroupCall: null,
        error: String(err),
      });
    }
  },

  joinGroupCall: async (accountId, callId, accessHash, chatId) => {
    try {
      set({
        error: null,
        activeGroupCall: {
          callId,
          accessHash,
          chatId,
          state: 'joining',
          participantsCount: 0,
        },
      });

      await invoke('join_group_call', {
        accountId,
        callId,
        accessHash,
        chatId,
      });

      set((state) => ({
        activeGroupCall: state.activeGroupCall
          ? { ...state.activeGroupCall, state: 'active' as const }
          : null,
      }));

      // Load participants after joining
      await get().loadParticipants(accountId);
    } catch (err) {
      set({
        activeGroupCall: null,
        error: String(err),
      });
    }
  },

  leaveGroupCall: async (accountId) => {
    const { activeGroupCall } = get();
    if (!activeGroupCall) return;

    try {
      set((state) => ({
        activeGroupCall: state.activeGroupCall
          ? { ...state.activeGroupCall, state: 'leaving' as const }
          : null,
      }));

      await invoke('leave_group_call', {
        accountId,
        callId: activeGroupCall.callId,
      });
    } catch (err) {
      console.error('Failed to leave group call:', err);
    }

    set({
      activeGroupCall: null,
      participants: [],
      isMuted: false,
      error: null,
    });
  },

  toggleMute: async (accountId) => {
    const { activeGroupCall, isMuted } = get();
    if (!activeGroupCall) return;

    const newMuted = !isMuted;
    try {
      await invoke('toggle_group_call_mute', {
        accountId,
        callId: activeGroupCall.callId,
        muted: newMuted,
      });
      set({ isMuted: newMuted });
    } catch (err) {
      console.error('Failed to toggle group call mute:', err);
    }
  },

  loadParticipants: async (accountId) => {
    const { activeGroupCall } = get();
    if (!activeGroupCall) return;

    try {
      const result = await invoke<{ participants: GroupCallParticipant[]; count: number }>('get_group_call_participants', {
        accountId,
        callId: activeGroupCall.callId,
      });

      set({
        participants: result.participants,
        activeGroupCall: {
          ...activeGroupCall,
          participantsCount: result.count,
        },
      });
    } catch (err) {
      console.error('Failed to load group call participants:', err);
    }
  },

  clearGroupCall: () => set({
    activeGroupCall: null,
    participants: [],
    isMuted: false,
    error: null,
  }),

  setupListeners: () => {
    const unlisteners: Promise<() => void>[] = [];

    // Group call state update
    unlisteners.push(
      subscribe<{ callId: number; accessHash: number; chatId: number; title?: string; state: string; participantsCount: number }>('telegram:group-call-update', (payload) => {
        const { activeGroupCall } = get();

        if (payload.state === 'ended' || payload.state === 'discarded') {
          set({
            activeGroupCall: null,
            participants: [],
            isMuted: false,
          });
          return;
        }

        const stateMap: Record<string, GroupCallInfo['state']> = {
          creating: 'creating',
          joining: 'joining',
          active: 'active',
          leaving: 'leaving',
        };

        const newState = stateMap[payload.state] || 'active';

        if (activeGroupCall && activeGroupCall.callId === payload.callId) {
          set({
            activeGroupCall: {
              ...activeGroupCall,
              state: newState,
              title: payload.title || activeGroupCall.title,
              participantsCount: payload.participantsCount || activeGroupCall.participantsCount,
            },
          });
        }
      })
    );

    // Group call participants update
    unlisteners.push(
      subscribe<{ callId: number; participants: GroupCallParticipant[]; count: number }>('telegram:group-call-participants', (payload) => {
        const { activeGroupCall } = get();
        if (activeGroupCall && activeGroupCall.callId === payload.callId) {
          set({
            participants: payload.participants,
            activeGroupCall: {
              ...activeGroupCall,
              participantsCount: payload.count,
            },
          });
        }
      })
    );

    return () => {
      unlisteners.forEach(p => p.then(unlisten => unlisten()));
    };
  },
}));
