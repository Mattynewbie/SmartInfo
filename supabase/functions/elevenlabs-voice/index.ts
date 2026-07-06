const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'Missing ELEVENLABS_API_KEY secret.' }, 500);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');

  try {
    if (path.endsWith('/stt')) {
      const incomingForm = await request.formData();
      const file = incomingForm.get('file');

      if (!(file instanceof File)) {
        return jsonResponse({ error: 'Audio file is required.' }, 400);
      }

      const upstreamForm = new FormData();
      upstreamForm.append('file', file, file.name || 'voice-note.m4a');
      upstreamForm.append('model_id', 'scribe_v2');

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
        body: upstreamForm,
      });

      const payload = await upstream.json();
      if (!upstream.ok) {
        return jsonResponse({ error: payload }, upstream.status);
      }

      return jsonResponse({ text: payload.text ?? '' });
    }

    if (path.endsWith('/tts')) {
      const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') ?? 'JBFqnCBsd6RMkjVDRZzb';
      const body = (await request.json()) as { text?: string };

      if (!body.text?.trim()) {
        return jsonResponse({ error: 'Text is required.' }, 400);
      }

      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: body.text,
            model_id: 'eleven_multilingual_v2',
          }),
        },
      );

      if (!upstream.ok) {
        const error = await upstream.text();
        return jsonResponse({ error }, upstream.status);
      }

      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'audio/mpeg',
        },
      });
    }

    return jsonResponse({ error: 'Use /stt or /tts.' }, 404);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Voice proxy failed.' }, 500);
  }
});
