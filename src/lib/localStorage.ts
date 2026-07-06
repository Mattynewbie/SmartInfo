import AsyncStorage from '@react-native-async-storage/async-storage';

const SELECTED_VOICE_KEY = 'smart-companion.selected-voice';

export async function loadSelectedVoiceId() {
  return AsyncStorage.getItem(SELECTED_VOICE_KEY);
}

export async function saveSelectedVoiceId(voiceId: string) {
  await AsyncStorage.setItem(SELECTED_VOICE_KEY, voiceId);
}
