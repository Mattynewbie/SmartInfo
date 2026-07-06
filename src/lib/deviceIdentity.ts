import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { DeviceIdentity } from '../types';

const DEVICE_FALLBACK_KEY = 'smart-companion.device-fallback-id';
const DEVICE_SECURE_KEY = 'smart-companion.device-secure-id';

export async function getPersistentDeviceIdentity(): Promise<DeviceIdentity> {
  const { rawId, source, stableAcrossAppDataClear, stabilityNote } = await getRawDeviceIdentifier();
  const applicationId = Application.applicationId ?? 'smartcompanion';
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${applicationId}:${source}:${rawId}`,
  );

  return {
    hash,
    source,
    stableAcrossAppDataClear,
    stabilityNote,
  };
}

async function getRawDeviceIdentifier() {
  if (Platform.OS === 'android') {
    return {
      rawId: Application.getAndroidId(),
      source: 'android_id',
      stableAcrossAppDataClear: true,
      stabilityNote: 'Android ID is scoped to the app signing key, user, and device.',
    };
  }

  if (Platform.OS === 'ios') {
    const secureId = await getOrCreateSecureDeviceId();
    if (secureId) {
      return {
        rawId: secureId,
        source: 'ios_secure_store',
        stableAcrossAppDataClear: true,
        stabilityNote: 'Stored in iOS Keychain; usually survives reinstall with the same bundle ID.',
      };
    }

    const iosId = await Application.getIosIdForVendorAsync();
    if (iosId) {
      return {
        rawId: iosId,
        source: 'ios_idfv',
        stableAcrossAppDataClear: true,
        stabilityNote: 'iOS IDFV can reset if all apps from the same vendor are uninstalled.',
      };
    }
  }

  const fallbackId = await getOrCreateFallbackDeviceId();
  return {
    rawId: fallbackId,
    source: `${Platform.OS}_local_fallback`,
    stableAcrossAppDataClear: false,
    stabilityNote: 'Platform device ID was unavailable; fallback storage can reset when app data is cleared.',
  };
}

async function getOrCreateSecureDeviceId() {
  try {
    if (!(await SecureStore.isAvailableAsync())) {
      return null;
    }

    const saved = await SecureStore.getItemAsync(DEVICE_SECURE_KEY);
    if (saved) {
      return saved;
    }

    const vendorId = await Application.getIosIdForVendorAsync();
    const next = vendorId ?? `secure-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    await SecureStore.setItemAsync(DEVICE_SECURE_KEY, next, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return next;
  } catch (error) {
    console.warn('Secure device ID unavailable:', error);
    return null;
  }
}

async function getOrCreateFallbackDeviceId() {
  const saved = await AsyncStorage.getItem(DEVICE_FALLBACK_KEY);
  if (saved) {
    return saved;
  }

  const next = `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  await AsyncStorage.setItem(DEVICE_FALLBACK_KEY, next);
  return next;
}
