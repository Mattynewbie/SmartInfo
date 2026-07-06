import AsyncStorage from '@react-native-async-storage/async-storage';

import type { VoiceUsage } from '../types';

const VOICE_USAGE_KEY = 'smart-companion.voice-usage';
const GUEST_USER_KEY = 'smart-companion.guest-user';

export const GUEST_FREE_VOICE_SECONDS = 2 * 60;
export const MEMBER_FREE_VOICE_SECONDS = GUEST_FREE_VOICE_SECONDS;
export const FREE_VOICE_SECONDS = MEMBER_FREE_VOICE_SECONDS;

export const defaultVoiceUsage: VoiceUsage = {
  freeSeconds: GUEST_FREE_VOICE_SECONDS,
  purchasedSeconds: 0,
  usedSeconds: 0,
};

export const memberVoiceUsage: VoiceUsage = {
  freeSeconds: MEMBER_FREE_VOICE_SECONDS,
  purchasedSeconds: 0,
  usedSeconds: 0,
};

export function getRemainingVoiceSeconds(usage: VoiceUsage) {
  return Math.max(0, usage.freeSeconds + usage.purchasedSeconds - usage.usedSeconds);
}

export function formatVoiceTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export async function loadVoiceUsage() {
  const saved = await AsyncStorage.getItem(VOICE_USAGE_KEY);
  if (!saved) {
    return defaultVoiceUsage;
  }

  try {
    const parsed = JSON.parse(saved) as VoiceUsage;
    return {
      freeSeconds: parsed.freeSeconds ?? GUEST_FREE_VOICE_SECONDS,
      purchasedSeconds: parsed.purchasedSeconds ?? 0,
      usedSeconds: parsed.usedSeconds ?? 0,
    };
  } catch {
    return defaultVoiceUsage;
  }
}

export async function saveVoiceUsage(usage: VoiceUsage) {
  await AsyncStorage.setItem(VOICE_USAGE_KEY, JSON.stringify(usage));
}

export async function getOrCreateGuestUserId() {
  const saved = await AsyncStorage.getItem(GUEST_USER_KEY);
  if (saved) {
    return saved;
  }

  const next = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await AsyncStorage.setItem(GUEST_USER_KEY, next);
  return next;
}
