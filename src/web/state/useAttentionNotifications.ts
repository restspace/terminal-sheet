import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { shouldNotifyForAttentionEvent, type AttentionEvent } from '../../shared/events';

const MAX_NOTIFIED_EVENT_IDS = 256;
const BROWSER_NOTIFICATIONS_STORAGE_KEY = 'tc-browser-notifications';
const SOUND_NOTIFICATIONS_STORAGE_KEY = 'tc-sound-notifications';

interface AttentionNotificationsState {
  browserNotificationsEnabled: boolean;
  soundEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  toggleBrowserNotifications: () => Promise<void>;
  toggleSound: () => void;
}

export function useAttentionNotifications(
  attentionEvents: AttentionEvent[],
): AttentionNotificationsState {
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] =
    useState(() => readStoredBoolean(BROWSER_NOTIFICATIONS_STORAGE_KEY));
  const [soundEnabled, setSoundEnabled] = useState(() =>
    readStoredBoolean(SOUND_NOTIFICATIONS_STORAGE_KEY),
  );
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? window.Notification.permission
      : 'unsupported',
  );
  const notifiedEventIdsRef = useRef(new Set<string>());
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    writeStoredBoolean(
      BROWSER_NOTIFICATIONS_STORAGE_KEY,
      browserNotificationsEnabled,
    );
  }, [browserNotificationsEnabled]);

  useEffect(() => {
    writeStoredBoolean(SOUND_NOTIFICATIONS_STORAGE_KEY, soundEnabled);
  }, [soundEnabled]);

  useEffect(() => {
    return () => {
      const context = audioContextRef.current;
      audioContextRef.current = null;

      if (!context) {
        return;
      }

      void context.close().catch(() => {
        // Ignore browser-specific close races during teardown.
      });
    };
  }, []);

  useEffect(() => {
    if (notifiedEventIdsRef.current.size > MAX_NOTIFIED_EVENT_IDS) {
      const retainedEventIds = new Set(attentionEvents.map((event) => event.id));

      for (const eventId of notifiedEventIdsRef.current) {
        if (!retainedEventIds.has(eventId)) {
          notifiedEventIdsRef.current.delete(eventId);
        }
      }
    }

    for (const event of attentionEvents) {
      if (notifiedEventIdsRef.current.has(event.id)) {
        continue;
      }

      notifiedEventIdsRef.current.add(event.id);

      if (!shouldNotifyForAttentionEvent(event)) {
        continue;
      }

      if (
        browserNotificationsEnabled &&
        notificationPermission === 'granted' &&
        'Notification' in window
      ) {
        new Notification(event.title, {
          body: event.detail,
        });
      }

      if (soundEnabled) {
        void playNotificationTone(audioContextRef);
      }
    }
  }, [
    attentionEvents,
    browserNotificationsEnabled,
    notificationPermission,
    soundEnabled,
  ]);

  const toggleBrowserNotifications = useCallback(async () => {
    if (notificationPermission === 'unsupported' || !('Notification' in window)) {
      return;
    }

    if (!browserNotificationsEnabled) {
      const permission = await window.Notification.requestPermission();
      setNotificationPermission(permission);

      if (permission !== 'granted') {
        setBrowserNotificationsEnabled(false);
        return;
      }
    }

    setBrowserNotificationsEnabled((current) => !current);
  }, [browserNotificationsEnabled, notificationPermission]);

  const toggleSound = useCallback(() => {
    setSoundEnabled((current) => !current);
  }, []);

  return {
    browserNotificationsEnabled,
    soundEnabled,
    notificationPermission,
    toggleBrowserNotifications,
    toggleSound,
  };
}

function readStoredBoolean(key: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(key) === 'true';
}

function writeStoredBoolean(key: string, value: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(key, String(value));
}

async function playNotificationTone(
  audioContextRef: RefObject<AudioContext | null>,
): Promise<void> {
  const audioContextConstructor = getAudioContextConstructor();

  if (!audioContextConstructor) {
    return;
  }

  if (!audioContextRef.current) {
    audioContextRef.current = new audioContextConstructor();
  }

  const context = audioContextRef.current;

  if (context.state === 'suspended') {
    await context.resume();
  }

  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const startAt = context.currentTime;

  oscillator.type = 'triangle';
  oscillator.frequency.value = 784;
  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.exponentialRampToValueAtTime(0.06, startAt + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.16);
  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.18);
}

function getAudioContextConstructor():
  | (new () => AudioContext)
  | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const extendedWindow = window as Window & {
    webkitAudioContext?: new () => AudioContext;
  };

  return window.AudioContext ?? extendedWindow.webkitAudioContext;
}
