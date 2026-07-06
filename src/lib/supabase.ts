import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import { env, isSupabaseConfigured } from './env';

export const supabase = isSupabaseConfigured
  ? createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export async function upsertRecord(table: string, payload: Record<string, unknown>) {
  if (!supabase) {
    return;
  }

  const { error } = await supabase.from(table).upsert(payload);
  if (error) {
    console.warn(`Supabase upsert failed for ${table}:`, error.message);
  }
}

export async function deleteRecord(table: string, id: string) {
  if (!supabase) {
    return;
  }

  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) {
    console.warn(`Supabase delete failed for ${table}:`, error.message);
  }
}
