import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';

dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = Number(process.env.VOICE_PROXY_PORT ?? 8787);
const minimumAudioBytes = 128;
const mimeTypeByExtension = {
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
const extensionByMimeType = {
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

function getElevenLabsApiKey() {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  return apiKey && apiKey !== 'PASTE_YOUR_ELEVENLABS_KEY_HERE' ? apiKey : '';
}

function getGroqApiKey() {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  return apiKey && apiKey !== 'PASTE_YOUR_FREE_GROQ_KEY_HERE' ? apiKey : '';
}

function getSttProvider() {
  return (process.env.STT_PROVIDER ?? 'groq').trim().toLowerCase();
}

function getGroqChatModel() {
  return (process.env.GROQ_CHAT_MODEL ?? 'groq/compound').trim();
}

function getGroqChatFallbackModel() {
  return (process.env.GROQ_CHAT_FALLBACK_MODEL ?? 'groq/compound-mini').trim();
}

app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'smart-companion-voice-proxy',
    sttProvider: getSttProvider(),
    chatModel: getGroqChatModel(),
    hasGroqKey: Boolean(getGroqApiKey()),
    hasElevenLabsKey: Boolean(getElevenLabsApiKey()),
  });
});

app.post('/chat', async (request, response) => {
  const apiKey = getGroqApiKey();
  const question = String(request.body?.question ?? '').trim();

  if (!apiKey) {
    response.status(500).json({
      error: 'Missing GROQ_API_KEY. Add it to .env.local and restart npm run voice-proxy.',
    });
    return;
  }

  if (!question) {
    response.status(400).json({ error: 'Question is required.' });
    return;
  }

  const primaryModel = getGroqChatModel();
  const fallbackModel = getGroqChatFallbackModel();
  const primaryResult = await answerWithGroqChat({
    apiKey,
    model: primaryModel,
    body: request.body,
  });

  if (primaryResult.ok) {
    response.json(primaryResult.body);
    return;
  }

  if (fallbackModel && fallbackModel !== primaryModel) {
    const fallbackResult = await answerWithGroqChat({
      apiKey,
      model: fallbackModel,
      body: request.body,
    });

    if (fallbackResult.ok) {
      response.json({
        ...fallbackResult.body,
        model: fallbackModel,
        fallbackFrom: primaryModel,
      });
      return;
    }
  }

  response.status(primaryResult.status).json(primaryResult.body);
});

app.post('/stt', upload.single('file'), async (request, response) => {
  const audioFile = createAudioFile(request);

  if (!audioFile) {
    response.status(400).json({ error: 'Audio file is required or the recording was empty.' });
    return;
  }

  const provider = getSttProvider();

  if (provider === 'groq' || provider === 'auto') {
    const groqApiKey = getGroqApiKey();

    if (!groqApiKey && provider === 'groq') {
      response.status(500).json({
        error:
          'Missing GROQ_API_KEY for free Groq Whisper STT. Keep ELEVENLABS_API_KEY for TTS, then add GROQ_API_KEY to .env.local and restart npm run voice-proxy.',
      });
      return;
    }

    if (groqApiKey) {
      await transcribeWithGroq(audioFile, response, groqApiKey);
      return;
    }
  }

  if (provider === 'elevenlabs' || provider === 'auto') {
    const elevenLabsApiKey = getElevenLabsApiKey();

    if (!elevenLabsApiKey) {
      response.status(500).json({
        error:
          'Missing ELEVENLABS_API_KEY. Add it to .env.local or set STT_PROVIDER=groq with GROQ_API_KEY.',
      });
      return;
    }

    await transcribeWithElevenLabs(audioFile, response, elevenLabsApiKey);
    return;
  }

  response.status(400).json({
    error: `Unsupported STT_PROVIDER "${provider}". Use "groq", "elevenlabs", or "auto".`,
  });
});

function createAudioFile(request) {
  let buffer;
  let originalName;
  let rawMimeType;

  if (request.file) {
    buffer = request.file.buffer;
    originalName = request.file.originalname;
    rawMimeType = request.file.mimetype;
  } else {
    const audioBase64 = request.body?.audioBase64;
    if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
      return null;
    }

    const cleanBase64 = audioBase64.includes(',')
      ? audioBase64.split(',').pop()
      : audioBase64;

    buffer = Buffer.from(cleanBase64.replace(/\s/g, ''), 'base64');
    originalName = request.body?.fileName;
    rawMimeType = request.body?.mimeType;
  }

  if (!buffer || buffer.byteLength < minimumAudioBytes) {
    return null;
  }

  const { fileName, mimeType } = normalizeAudioMetadata(originalName, rawMimeType);

  return new File([buffer], fileName, { type: mimeType });
}

function normalizeAudioMetadata(originalName, rawMimeType) {
  const mimeType = normalizeMimeType(rawMimeType);
  const extensionFromName = getSupportedExtension(originalName);
  const extension = extensionFromName ?? getExtensionForMimeType(mimeType) ?? 'm4a';
  const fileName = ensureSupportedAudioFileName(originalName, extension);
  const knownMimeType = mimeTypeByExtension[extension] || 'audio/mp4';

  return {
    fileName,
    mimeType: knownMimeType,
  };
}

function normalizeMimeType(value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

function getSupportedExtension(fileName) {
  if (typeof fileName !== 'string') {
    return null;
  }

  const extension = fileName.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  return extension && supportedAudioExtensions.has(extension) ? extension : null;
}

function getExtensionForMimeType(mimeType) {
  if (!mimeType) {
    return null;
  }

  return extensionByMimeType[mimeType] ?? null;
}

function ensureSupportedAudioFileName(originalName, fallbackExtension) {
  const safeName =
    typeof originalName === 'string'
      ? originalName.split(/[\\/]/).pop()?.replace(/[^\w.-]/g, '_').trim()
      : '';

  if (safeName && getSupportedExtension(safeName)) {
    return safeName;
  }

  const baseName = safeName?.replace(/\.[^.]*$/, '') || 'voice-note';
  return `${baseName}.${fallbackExtension}`;
}

async function transcribeWithGroq(audioFile, response, apiKey) {
  try {
    const formData = new FormData();
    formData.append('file', audioFile, audioFile.name);
    formData.append('model', process.env.GROQ_STT_MODEL ?? 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    formData.append('temperature', '0');

    if (process.env.GROQ_STT_LANGUAGE?.trim()) {
      formData.append('language', process.env.GROQ_STT_LANGUAGE.trim());
    }

    const sttPrompt = [
      process.env.GROQ_STT_PROMPT?.trim(),
      'Transcribe only the actual spoken user question. If the audio is silent, unclear, or only background noise, return an empty text instead of guessing common phrases like thank you.',
    ].filter(Boolean).join(' ');
    formData.append('prompt', sttPrompt);

    console.log(
      `Forwarding STT audio to Groq: ${audioFile.name} (${audioFile.type || 'unknown'}, ${audioFile.size} bytes)`,
    );

    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    const payloadText = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = { text: payloadText };
    }

    if (!upstream.ok) {
      response.status(upstream.status).json({
        error: 'Groq Whisper speech-to-text request failed.',
        details: payload,
        file: {
          name: audioFile.name,
          type: audioFile.type,
          size: audioFile.size,
        },
      });
      return;
    }

    response.json({ text: payload.text ?? '' });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Groq voice transcription failed.',
    });
  }
}

async function transcribeWithElevenLabs(audioFile, response, apiKey) {
  try {
    const formData = new FormData();
    formData.append('file', audioFile, audioFile.name);
    formData.append('model_id', process.env.ELEVENLABS_STT_MODEL_ID ?? 'scribe_v2');
    formData.append('language_code', process.env.ELEVENLABS_LANGUAGE_CODE ?? 'fil');

    const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
    });

    const payloadText = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = { raw: payloadText };
    }

    if (!upstream.ok) {
      response.status(upstream.status).json({
        error: 'ElevenLabs speech-to-text request failed.',
        details: payload,
      });
      return;
    }

    response.json({ text: payload.text ?? '' });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Voice transcription failed.',
    });
  }
}

async function answerWithGroqChat({ apiKey, model, body }) {
  const question = String(body?.question ?? '').trim();
  const category = String(body?.category ?? 'Public assistance').slice(0, 80);
  const intent = String(body?.intent ?? 'general').slice(0, 40);
  const replyLanguage = body?.replyLanguage === 'english' ? 'english' : 'taglish';
  const simpleMode = Boolean(body?.simpleMode);

  try {
    const requestBody = {
      model,
      messages: [
        {
          role: 'system',
          content: buildCompanionSystemPrompt({ category, intent, replyLanguage, simpleMode }),
        },
        {
          role: 'user',
          content: question,
        },
      ],
      temperature: 0.35,
      max_completion_tokens: simpleMode ? 300 : 420,
      top_p: 0.9,
      stream: false,
    };

    if (model.startsWith('groq/compound')) {
      requestBody.search_settings = { country: 'philippines' };
    }

    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const payloadText = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = { raw: payloadText };
    }

    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        body: {
          error: 'Groq AI chat request failed.',
          details: payload,
        },
      };
    }

    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return {
        ok: false,
        status: 502,
        body: { error: 'Groq AI did not return an answer.', details: payload },
      };
    }

    return {
      ok: true,
      body: {
        answer: cleanCompanionAnswer(answer),
        provider: 'groq',
        model,
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: { error: error instanceof Error ? error.message : 'AI chat failed.' },
    };
  }
}

function buildCompanionSystemPrompt({ category, intent, replyLanguage, simpleMode }) {
  const languageInstruction =
    replyLanguage === 'taglish'
      ? 'Reply in natural Filipino/Taglish. Match the user. Do not default to English.'
      : 'Reply in clear, friendly English.';
  const simplicityInstruction = simpleMode
    ? 'Use very simple words, short sentences, and beginner-friendly steps.'
    : 'Use friendly public-service wording with practical next steps.';

  return [
    'You are Smart Public Information Companion, a friendly digital guide for schools, government offices, public places, and other institutions.',
    languageInstruction,
    simplicityInstruction,
    `Current category: ${category}. User intent: ${intent}.`,
    'Answer like a helpful companion, not a robotic FAQ.',
    'Use plain text only. No markdown, no bold markers, no emojis.',
    'Assume the user is in the Philippines unless they say otherwise.',
    'When the model supports web search/tools and the question is about current public procedures, directions, offices, requirements, fees, schedules, or forms, use search instead of relying only on memory.',
    'If the user asks how to do a process, give clear steps. If they ask where to go, suggest the likely office/location. If they ask what to bring, give a checklist.',
    'For commute or directions questions, do not invent exact routes if uncertain. Give the likely route, then tell the user to verify with the driver, guard, or a live map before riding.',
    'For public/government procedures, be careful with details that can change. Mention the official website, official office, or help desk when confirmation is needed.',
    'Do not give exact fees, hotlines, processing days, deadlines, or office hours unless you are confident from current official information. Otherwise say to confirm the current amount/schedule with the official office or website.',
    'Never say you only know saved answers. If you are unsure, say what is likely and how to verify it.',
    'Keep the answer concise enough for a mobile chat bubble. Use at most 5 short steps, then one short verification tip.',
  ].join('\n');
}

function cleanCompanionAnswer(answer) {
  return answer
    .replace(/^assistant:\s*/i, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

app.post('/tts', async (request, response) => {
  const result = await synthesizeWithElevenLabs(request.body);

  if (!result.ok) {
    response.status(result.status).json(result.body);
    return;
  }

  response.setHeader('Content-Type', 'audio/mpeg');
  response.send(result.audioBuffer);
});

app.post('/tts-json', async (request, response) => {
  const result = await synthesizeWithElevenLabs(request.body);

  if (!result.ok) {
    response.status(result.status).json(result.body);
    return;
  }

  response.json({
    audioBase64: result.audioBuffer.toString('base64'),
    mimeType: 'audio/mpeg',
  });
});

async function synthesizeWithElevenLabs(body) {
  const apiKey = getElevenLabsApiKey();
  const voiceId = body?.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';

  if (!apiKey) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Missing ELEVENLABS_API_KEY. Add it to .env.local and restart npm run voice-proxy.' },
    };
  }

  if (!body?.text?.trim()) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Text is required.' },
    };
  }

  try {
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
          model_id: process.env.ELEVENLABS_TTS_MODEL_ID ?? 'eleven_multilingual_v2',
          voice_settings: {
            stability: body.stability ?? 0.48,
            similarity_boost: body.similarityBoost ?? 0.78,
            style: body.style ?? 0.2,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        body: {
          error: 'ElevenLabs text-to-speech request failed.',
          details: await upstream.text(),
        },
      };
    }

    return {
      ok: true,
      audioBuffer: Buffer.from(await upstream.arrayBuffer()),
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: { error: error instanceof Error ? error.message : 'Voice synthesis failed.' },
    };
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Smart Companion voice proxy running at http://127.0.0.1:${port}`);
});
