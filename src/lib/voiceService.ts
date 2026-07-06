import * as FileSystem from 'expo-file-system/legacy';

import { env } from './env';

const devVoiceProxyUrl =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://127.0.0.1:8787' : '';
const minimumAudioBytes = 128;
const voiceProxyTimeoutMs = 30000;

const mimeTypeByExtension: Record<string, string> = {
  '3gp': 'audio/3gpp',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

const extensionByMimeType: Record<string, string> = {
  'audio/3gpp': '3gp',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
};

const supportedAudioExtensions = new Set(Object.keys(mimeTypeByExtension));

type TranscribeRecordingOptions = {
  signal?: AbortSignal;
};

export async function transcribeRecording(recordingUri: string, options: TranscribeRecordingOptions = {}) {
  const voiceProxyUrl = env.voiceProxyUrl || devVoiceProxyUrl;

  if (!voiceProxyUrl) {
    throw new Error('Voice proxy URL is not configured.');
  }

  throwIfAborted(options.signal);
  const recordingFile = await readRecordingFile(recordingUri);
  throwIfAborted(options.signal);

  try {
    const response = await fetchWithTimeout(`${voiceProxyUrl.replace(/\/$/, '')}/stt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audioBase64: recordingFile.audioBase64,
        fileName: recordingFile.fileName,
        mimeType: recordingFile.mimeType,
        byteLength: recordingFile.byteLength,
      }),
    }, voiceProxyTimeoutMs, options.signal);

    if (!response.ok) {
      const errorText = await response.text();
      console.warn('Voice proxy transcription failed:', errorText);

      try {
        const payload = JSON.parse(errorText) as {
          error?: string;
          details?: { detail?: { message?: string } };
        };
        throw new Error(payload.details?.detail?.message ?? payload.error ?? errorText);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(errorText);
        }
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(errorText);
      }
    }

    throwIfAborted(options.signal);
    const payload = (await response.json()) as { text?: string };
    throwIfAborted(options.signal);
    return payload.text?.trim() || null;
  } catch (error) {
    const normalized = normalizeAbortError(error);
    if (normalized instanceof Error && normalized.name === 'AbortError') {
      throw normalized;
    }
    console.warn('Voice proxy unavailable:', normalized);
    throw normalized instanceof Error ? normalized : new Error('Voice proxy unavailable.');
  }
}

async function readRecordingFile(recordingUri: string) {
  if (recordingUri.startsWith('blob:')) {
    return readBlobRecordingFile(recordingUri);
  }

  await waitForReadableRecording(recordingUri);

  const audioBase64 = await FileSystem.readAsStringAsync(recordingUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const byteLength = estimateBase64ByteLength(audioBase64);
  if (byteLength < minimumAudioBytes) {
    throw new Error('Recording file was empty. Please try recording again.');
  }

  return buildRecordingPayload(recordingUri, audioBase64, byteLength);
}

async function readBlobRecordingFile(recordingUri: string) {
  const response = await fetch(recordingUri);
  const blob = await response.blob();
  const audioBase64 = arrayBufferToBase64(await blob.arrayBuffer());
  const mimeType = blob.type || 'audio/webm';
  const extension = getExtensionForMimeType(mimeType) ?? 'webm';

  if (blob.size < minimumAudioBytes) {
    throw new Error('Recording file was empty. Please try recording again.');
  }

  return {
    audioBase64,
    byteLength: blob.size,
    fileName: `voice-note.${extension}`,
    mimeType,
  };
}

function buildRecordingPayload(recordingUri: string, audioBase64: string, byteLength: number) {
  const rawFileName = getFileNameFromUri(recordingUri);
  const extension = getSupportedExtension(rawFileName) ?? 'm4a';
  const fileName = getSupportedExtension(rawFileName) ? rawFileName : `voice-note.${extension}`;

  return {
    audioBase64,
    byteLength,
    fileName,
    mimeType: mimeTypeByExtension[extension] ?? 'audio/mp4',
  };
}

function getFileNameFromUri(uri: string) {
  const withoutQuery = uri.split('?')[0]?.split('#')[0] ?? '';
  const fileName = withoutQuery.split('/').pop()?.trim();

  return fileName ? decodeURIComponent(fileName) : 'voice-note.m4a';
}

function getSupportedExtension(fileName: string) {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return extension && supportedAudioExtensions.has(extension) ? extension : null;
}

function getExtensionForMimeType(mimeType: string) {
  const normalizedMimeType = mimeType.split(';')[0]?.trim().toLowerCase();

  return extensionByMimeType[normalizedMimeType] ?? null;
}

function estimateBase64ByteLength(value: string) {
  const normalized = value.replace(/\s/g, '');
  if (!normalized) {
    return 0;
  }

  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function waitForReadableRecording(recordingUri: string) {
  let exists = false;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const fileInfo = await FileSystem.getInfoAsync(recordingUri);
    if (fileInfo.exists && !fileInfo.isDirectory) {
      exists = true;
      if (fileInfo.size >= minimumAudioBytes) {
        return;
      }
    }

    await delay(120);
  }

  throw new Error(exists ? 'Recording file was empty. Please try recording again.' : 'Recording file was not found.');
}

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Voice transcription was cancelled.');
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
    const abortError = new Error('Voice transcription was cancelled.');
    abortError.name = 'AbortError';
    return abortError;
  }
  return error;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortRequest, { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    throw normalizeAbortError(error);
  } finally {
    signal?.removeEventListener('abort', abortRequest);
    clearTimeout(timeoutId);
  }
}
