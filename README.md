# Smart Public Information Companion

AI-powered public assistance companion for schools, government offices, public places, and other institutions.

## Run The App

```bash
npm install
npm run android
```

You can also use `npm run ios` on macOS or `npm run web` for a browser preview.

## Environment

Copy `.env.example` to `.env.local` and add Supabase public values:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
EXPO_PUBLIC_VOICE_PROXY_URL=https://your-project.functions.supabase.co/elevenlabs-voice
```

Do not put the ElevenLabs API key in Expo client code. Store it as a Supabase Edge Function secret:

```bash
supabase secrets set ELEVENLABS_API_KEY=your-rotated-elevenlabs-key
supabase secrets set ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
```

Because an API key was shared in chat, rotate it before using it in a real deployment.

## Supabase

Run `supabase/schema.sql` in the Supabase SQL editor. It creates:

- `users`
- `categories`
- `public_information`
- `faqs`
- `conversations`
- `messages`
- `announcements`
- `feedback`
- `voice_usage`
- `voice_packages`
- `voice_transactions`

The payment gateway is intentionally marked pending/for future integration. The UI shows the packages and the pending alert, but no real payment is charged.

### Auth And Email Verification

The login/register page is the Account tab in the app. New accounts are created through Supabase Auth and must verify email before they can use the 10-minute verified-user voice allowance.

In Supabase, enable email confirmations and configure SMTP:

1. Open Supabase Dashboard.
2. Go to Authentication > Emails > SMTP Settings.
3. Add SMTP host, port, username, password, and sender details.
4. Go to Authentication settings and enable Confirm email.
5. Set the Site URL and Redirect URLs for your Expo/dev/prod app.

Do not put SMTP passwords in Expo client code. The Admin > SMTP page in the app shows the setup checklist only; secrets must stay in Supabase or a server-only admin tool.

To make your first admin, sign up, verify email, log in once so the app creates the profile row, then run this in Supabase SQL editor:

```sql
update public.users
set role = 'admin'
where email = 'your-admin-email@example.com';
```

## Roles

The app opens in guest/student mode. Each device gets 2 free minutes of voice time. Verified users can sync their recent questions across devices. Admin users have no voice time limit.

The Admin tab only appears for verified accounts whose `public.users.role` is `admin`. Admins can add/edit/delete FAQs, public information, announcements, categories, read feedback, view registered users, and add voice minutes to a specific user account.

`EXPO_PUBLIC_ADMIN_ACCESS_CODE` is only a local fallback when Supabase is not configured. It is not a production security feature.

## Voice

With Supabase configured, the app tracks 2 free voice minutes per device in `device_voice_usage` using a hashed platform device identifier. Recent questions are stored in `recent_questions` by authenticated `user_id`, so signed-in users only see their own questions and can sync them across devices. Text chat remains usable after voice time reaches zero.

Voice transcription is routed through a server-side proxy. For local development, speech-to-text uses Groq Whisper because it has a free developer tier. ElevenLabs is still kept for text-to-speech and can be used for STT later if the API key has that permission.

The same local proxy also exposes `/chat` for AI answers. The app checks saved FAQs/public information first. If nothing matches strongly, it calls Groq through the server-side proxy so the companion can still answer like an AI assistant instead of only saying that no saved answer exists.

The Home screen includes assistant voice choices:

- Filipino: ElevenLabs multilingual TTS tuned for Tagalog responses.
- Taglish: ElevenLabs multilingual TTS tuned for mixed Tagalog-English.
- English: ElevenLabs multilingual TTS for clearer English guidance.
- Device Filipino / Device English: fallback voices from the phone or emulator.

If the emulator does not have a Filipino system voice installed, use the ElevenLabs Filipino or Taglish options for better Tagalog pronunciation.

### Local LDPlayer Voice Test

For local emulator testing, the app automatically tries `http://127.0.0.1:8787/stt` in development. Put a free Groq API key in ignored `.env.local`:

```bash
STT_PROVIDER=groq
GROQ_API_KEY=your-free-groq-key
GROQ_STT_MODEL=whisper-large-v3-turbo
GROQ_STT_LANGUAGE=tl
GROQ_CHAT_MODEL=groq/compound
GROQ_CHAT_FALLBACK_MODEL=groq/compound-mini
```

Keep the ElevenLabs key too if you want ElevenLabs TTS:

```bash
ELEVENLABS_API_KEY=your-elevenlabs-key
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
```

Start the local proxy:

```bash
npm run voice-proxy
```

In another terminal, start Metro for LDPlayer:

```bash
npm run ldplayer
```

Then open it in LDPlayer with the helper, which forwards Metro and voice proxy ports:

```bash
npm run ldplayer:open
```

Groq's transcription endpoint is `https://api.groq.com/openai/v1/audio/transcriptions`; Groq AI answers use `https://api.groq.com/openai/v1/chat/completions`; ElevenLabs remains available at `/tts` and `/tts-json` in the local proxy.
