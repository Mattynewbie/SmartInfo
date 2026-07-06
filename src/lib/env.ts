declare const process:
  | {
      env: Record<string, string | undefined>;
    }
  | undefined;

const runtimeEnv = typeof process === 'undefined' ? {} : process.env;

export const env = {
  supabaseUrl: runtimeEnv.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: runtimeEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  aiProxyUrl: runtimeEnv.EXPO_PUBLIC_AI_PROXY_URL ?? '',
  voiceProxyUrl: runtimeEnv.EXPO_PUBLIC_VOICE_PROXY_URL ?? '',
  adminAccessCode: runtimeEnv.EXPO_PUBLIC_ADMIN_ACCESS_CODE ?? 'admin123',
};

export const isSupabaseConfigured = Boolean(env.supabaseUrl && env.supabaseAnonKey);
