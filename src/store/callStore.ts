import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useSettingsStore } from './settingsStore';

export type CallStateEnum =
  | 'idle'
  | 'requesting'
  | 'waiting'
  | 'ringing'
  | 'accepted'
  | 'active'
  | 'ended';

export interface CallInfo {
  callId: number;
  accessHash: number;
  peerId: number;
  peerName: string;
  isVideo: boolean;
  isOutgoing: boolean;
  state: CallStateEnum;
  startTime?: number;
  duration?: number;
}

export interface IncomingCallInfo {
  callId: number;
  accessHash: number;
  userId: number;
  userName: string;
  isVideo: boolean;
  accountId: string;
}

interface CallStore {
  activeCall: CallInfo | null;
  incomingCall: IncomingCallInfo | null;
  callError: string | null;
  isMuted: boolean;
  volume: number;
  audioLevel: number;
  networkQuality: number;

  requestCall: (accountId: string, userId: number, peerName: string, isVideo: boolean) => Promise<void>;
  acceptCall: (accountId: string) => Promise<void>;
  discardCall: (accountId: string, reason?: string) => Promise<void>;
  toggleMute: (accountId: string) => Promise<void>;
  setVolume: (accountId: string, volume: number) => Promise<void>;
  setIncomingCall: (call: IncomingCallInfo | null) => void;
  updateCallState: (state: CallStateEnum) => void;
  clearCall: () => void;
  setupListeners: () => () => void;
}

export const useCallStore = create<CallStore>()((set, get) => ({
  activeCall: null,
  incomingCall: null,
  callError: null,
  isMuted: false,
  volume: 1.0,
  audioLevel: 0,
  networkQuality: 5,

  requestCall: async (accountId, userId, peerName, isVideo) => {
    console.log('[CallStore] requestCall', { accountId, userId, peerName, isVideo });
    try {
      set({ callError: null });
      set({
        activeCall: {
          callId: 0,
          accessHash: 0,
          peerId: userId,
          peerName,
          isVideo,
          isOutgoing: true,
          state: 'requesting',
        },
      });

      const result = await invoke<{ callId: number; accessHash: number; peerUserId: number; isVideo: boolean; state: string }>('request_call', {
        accountId,
        userId,
        isVideo,
      });

      console.log('[CallStore] request_call result:', result);

      set({
        activeCall: {
          callId: result.callId,
          accessHash: result.accessHash,
          peerId: result.peerUserId,
          peerName,
          isVideo: result.isVideo,
          isOutgoing: true,
          state: 'waiting',
        },
      });
    } catch (err) {
      console.error('[CallStore] request_call error:', err);
      set({
        activeCall: null,
        callError: String(err),
      });
    }
  },

  acceptCall: async (accountId) => {
    const { incomingCall } = get();
    if (!incomingCall) return;

    try {
      set({ callError: null });
      const result = await invoke<{ callId: number; accessHash: number; peerUserId: number; isVideo: boolean; state: string }>('accept_call', {
        accountId,
        callId: incomingCall.callId,
      });

      set({
        activeCall: {
          callId: result.callId,
          accessHash: result.accessHash,
          peerId: incomingCall.userId,
          peerName: incomingCall.userName,
          isVideo: incomingCall.isVideo,
          isOutgoing: false,
          state: 'accepted',
          startTime: Date.now(),
        },
        incomingCall: null,
      });
    } catch (err) {
      set({ callError: String(err) });
    }
  },

  discardCall: async (accountId, reason = 'hangup') => {
    const { activeCall, incomingCall } = get();
    const callId = (activeCall?.callId && activeCall.callId !== 0) ? activeCall.callId : incomingCall?.callId;
    console.log('[CallStore] discardCall', { accountId, callId, activeCallId: activeCall?.callId, incomingCallId: incomingCall?.callId, reason });

    // Always clear local state first
    set({
      activeCall: null,
      incomingCall: null,
      callError: null,
      isMuted: false,
      volume: 1.0,
      audioLevel: 0,
      networkQuality: 5,
    });

    // Only send discard to server if we have a real callId
    if (callId && callId !== 0) {
      try {
        await invoke('discard_call', {
          accountId,
          callId,
          reason,
        });
      } catch (err) {
        console.error('[CallStore] Failed to discard call:', err);
      }
    }
  },

  toggleMute: async (_accountId) => {
    const { activeCall, isMuted } = get();
    if (!activeCall) return;

    const newMuted = !isMuted;
    try {
      await invoke('toggle_call_mute', {
        callId: activeCall.callId,
        muted: newMuted,
      });
      set({ isMuted: newMuted });
    } catch (err) {
      console.error('Failed to toggle mute:', err);
    }
  },

  setVolume: async (_accountId, volume) => {
    const { activeCall } = get();
    if (!activeCall) return;

    try {
      await invoke('set_call_volume', {
        callId: activeCall.callId,
        volume,
      });
      set({ volume });
    } catch (err) {
      console.error('Failed to set volume:', err);
    }
  },

  setIncomingCall: (call) => set({ incomingCall: call }),

  updateCallState: (state) => {
    const { activeCall } = get();
    if (!activeCall) return;

    if (state === 'ended') {
      set({ activeCall: null });
      return;
    }

    set({
      activeCall: {
        ...activeCall,
        state,
        startTime: state === 'active' ? Date.now() : activeCall.startTime,
      },
    });
  },

  clearCall: () => set({ activeCall: null, incomingCall: null, callError: null, isMuted: false, volume: 1.0, audioLevel: 0, networkQuality: 5 }),

  setupListeners: () => {
    console.log('[CallStore] Setting up call event listeners');
    const unlisteners: Promise<UnlistenFn>[] = [];

    // Audio level arrives dozens of times per second; coalesce to one store
    // update per animation frame so the whole call UI doesn't re-render per event.
    let pendingAudioLevel: number | null = null;
    let audioLevelRaf = 0;

    // Incoming call
    unlisteners.push(
      listen<{ callId: number; accessHash: number; userId: number; userName: string; isVideo: boolean; accountId: string }>('telegram:incoming-call', (event) => {
        console.log('[CallStore] telegram:incoming-call', event.payload);
        // Calls are experimental (VoIP encryption is a stub). With the flag off
        // we don't surface the incoming-call UI at all — the call keeps ringing
        // on the user's other Telegram clients.
        if (!useSettingsStore.getState().experimentalCalls) return;
        set({
          incomingCall: {
            callId: event.payload.callId,
            accessHash: event.payload.accessHash,
            userId: event.payload.userId,
            userName: event.payload.userName || 'Unknown',
            isVideo: event.payload.isVideo,
            accountId: event.payload.accountId,
          },
        });
      })
    );

    // Call state changed
    unlisteners.push(
      listen<{ callId: number; state: string; reason?: string; gB?: number[]; accountId: string }>('telegram:call-state-changed', (event) => {
        console.log('[CallStore] telegram:call-state-changed', event.payload);
        const { activeCall } = get();
        const stateMap: Record<string, CallStateEnum> = {
          waiting: 'waiting',
          ringing: 'ringing',
          accepted: 'accepted',
          active: 'active',
          discarded: 'ended',
        };

        const newState = stateMap[event.payload.state] || 'ended';

        if (newState === 'ended') {
          set({ activeCall: null, incomingCall: null });
          return;
        }

        if (activeCall && activeCall.callId === event.payload.callId) {
          set({
            activeCall: {
              ...activeCall,
              state: newState,
              startTime: newState === 'active' ? Date.now() : activeCall.startTime,
            },
          });

          // Auto-confirm: when caller receives "accepted" with g_b, complete DH handshake
          if (newState === 'accepted' && activeCall.isOutgoing && event.payload.gB) {
            invoke('confirm_call', {
              accountId: event.payload.accountId,
              callId: event.payload.callId,
              gB: event.payload.gB,
            }).catch((err) => {
              console.error('Failed to confirm call:', err);
              set({ callError: String(err) });
            });
          }
        }
      })
    );

    // Audio level from VoIP sidecar (throttled to one update per frame)
    unlisteners.push(
      listen<{ level: number }>('telegram:call-audio-level', (event) => {
        pendingAudioLevel = event.payload.level;
        if (!audioLevelRaf) {
          audioLevelRaf = requestAnimationFrame(() => {
            audioLevelRaf = 0;
            if (pendingAudioLevel !== null) set({ audioLevel: pendingAudioLevel });
          });
        }
      })
    );

    // Network quality from VoIP sidecar
    unlisteners.push(
      listen<{ quality: number }>('telegram:call-network-quality', (event) => {
        set({ networkQuality: event.payload.quality });
      })
    );

    // Call connected (sidecar audio flowing)
    unlisteners.push(
      listen('telegram:call-connected', () => {
        const { activeCall } = get();
        if (activeCall) {
          set({
            activeCall: {
              ...activeCall,
              state: 'active',
              startTime: activeCall.startTime || Date.now(),
            },
          });
        }
      })
    );

    // Sidecar stopped
    unlisteners.push(
      listen<{ reason?: string; code?: number }>('telegram:call-sidecar-stopped', () => {
        set({ activeCall: null, isMuted: false, volume: 1.0, audioLevel: 0, networkQuality: 5 });
      })
    );

    // Call error from sidecar
    unlisteners.push(
      listen<{ message: string }>('telegram:call-error', (event) => {
        set({ callError: event.payload.message });
      })
    );

    return () => {
      unlisteners.forEach(p => p.then(unlisten => unlisten()));
    };
  },
}));
