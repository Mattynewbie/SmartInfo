import * as FileSystem from 'expo-file-system/legacy';

import { env } from './env';

export type AssistantVoiceId =
  | 'filipino-elevenlabs'
  | 'taglish-elevenlabs'
  | 'english-elevenlabs'
  | 'device-filipino'
  | 'device-english';

export type AssistantVoiceOption = {
  id: AssistantVoiceId;
  label: string;
  description: string;
  provider: 'elevenlabs' | 'device';
  language: string;
  voiceId?: string;
  rate: number;
  pitch: number;
};

const devVoiceProxyUrl =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://127.0.0.1:8787' : '';

export const assistantVoiceOptions: AssistantVoiceOption[] = [
  {
    id: 'filipino-elevenlabs',
    label: 'Filipino',
    description: 'Mas natural sa Tagalog.',
    provider: 'elevenlabs',
    language: 'fil-PH',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    rate: 0.92,
    pitch: 1,
  },
  {
    id: 'taglish-elevenlabs',
    label: 'Taglish',
    description: 'Tagalog-English companion.',
    provider: 'elevenlabs',
    language: 'fil-PH',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
    rate: 0.9,
    pitch: 1.02,
  },
  {
    id: 'english-elevenlabs',
    label: 'English',
    description: 'Clear English guide.',
    provider: 'elevenlabs',
    language: 'en-PH',
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    rate: 0.94,
    pitch: 1,
  },
  {
    id: 'device-filipino',
    label: 'Device Filipino',
    description: 'Uses installed phone voice.',
    provider: 'device',
    language: 'fil-PH',
    rate: 0.84,
    pitch: 1.04,
  },
  {
    id: 'device-english',
    label: 'Device English',
    description: 'Offline fallback voice.',
    provider: 'device',
    language: 'en-PH',
    rate: 0.92,
    pitch: 1.04,
  },
];

export const defaultAssistantVoiceId: AssistantVoiceId = 'filipino-elevenlabs';

export function getAssistantVoiceOption(id: string) {
  return (
    assistantVoiceOptions.find((option) => option.id === id) ??
    assistantVoiceOptions.find((option) => option.id === defaultAssistantVoiceId) ??
    assistantVoiceOptions[0]
  );
}

type SynthesizeSpeechOptions = {
  signal?: AbortSignal;
};

export async function synthesizeAssistantSpeech(
  text: string,
  voice: AssistantVoiceOption,
  options: SynthesizeSpeechOptions = {},
) {
  const voiceProxyUrl = env.voiceProxyUrl || devVoiceProxyUrl;

  if (!voiceProxyUrl) {
    throw new Error('Voice proxy URL is not configured.');
  }

  throwIfAborted(options.signal);
  let response: Response;
  try {
    response = await fetch(`${voiceProxyUrl.replace(/\/$/, '')}/tts-json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voiceId: voice.voiceId,
        stability: voice.id === 'filipino-elevenlabs' ? 0.42 : 0.48,
        similarityBoost: 0.82,
        style: voice.id === 'taglish-elevenlabs' ? 0.32 : 0.18,
      }),
      signal: options.signal,
    });
  } catch (error) {
    throw normalizeAbortError(error);
  }

  if (!response.ok) {
    const errorText = await response.text();
    try {
      const payload = JSON.parse(errorText) as { error?: string; details?: string };
      throw new Error(payload.error ?? payload.details ?? errorText);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(errorText);
      }
      throw error;
    }
  }

  throwIfAborted(options.signal);
  const payload = (await response.json()) as { audioBase64?: string; mimeType?: string };
  if (!payload.audioBase64) {
    throw new Error('Voice proxy did not return audio.');
  }
  throwIfAborted(options.signal);

  const fileName = `assistant-${Date.now()}-${voice.id}.mp3`;
  if (!FileSystem.cacheDirectory) {
    throw new Error('Expo cache directory is not available for voice playback.');
  }

  const audioUri = `${FileSystem.cacheDirectory}${fileName}`;

  await FileSystem.writeAsStringAsync(audioUri, payload.audioBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  throwIfAborted(options.signal);

  return audioUri;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Assistant speech was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function normalizeAbortError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.name === 'AbortError') {
    return error;
  }
  const msg = error.message.toLowerCase();
  const isCancellation =
    msg.includes('fetch request has been canceled') ||
    msg.includes('aborted') ||
    msg.includes('cancelled') ||
    msg.includes('canceled');
  if (isCancellation) {
    const abortError = new Error('Assistant speech was cancelled.');
    abortError.name = 'AbortError';
    return abortError;
  }
  return error;
}
