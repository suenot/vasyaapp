import { useEffect, useRef } from 'react';
import { subscribe } from '../transport';

export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
  enabled = true,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;

    let unlisten: (() => void) | null = null;
    let mounted = true;

    subscribe<T>(eventName, (payload) => {
      if (mounted) {
        handlerRef.current(payload);
      }
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [eventName, enabled]);
}
