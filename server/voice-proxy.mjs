import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import {
  createCrawlJob,
  getWriteToken,
  isCrawlRunning,
  loadSourceById,
  requestStopCrawl,
  requireSuperAdminFromAuthHeader,
  runWebsiteCrawl,
} from './website-crawler.mjs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
// DigitalOcean App Platform injects PORT; local dev uses 8787.
const port = Number(process.env.PORT || process.env.VOICE_PROXY_PORT || 8787);
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
  const hasSupabaseUrl = Boolean(
    process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL,
  );
  const hasSupabaseKey = Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  );
  response.json({
    ok: true,
    service: 'smartinfo-voice-proxy',
    sttProvider: getSttProvider(),
    chatModel: getGroqChatModel(),
    hasGroqKey: Boolean(getGroqApiKey()),
    hasElevenLabsKey: Boolean(getElevenLabsApiKey()),
    hasCrawlRoutes: true,
    hasSupabaseEnv: hasSupabaseUrl && hasSupabaseKey,
  });
});

/**
 * Mobile email-confirmation bridge.
 * Supabase redirects here after verify (must be in Auth → Redirect URLs).
 * This page forwards tokens/errors into the SmartInfo app deep link.
 *
 * Register both of these in Supabase Dashboard → Authentication → URL Configuration:
 *   - Site URL: https://smartinfo-voice-d8vsi.ondigitalocean.app/auth/callback
 *   - Redirect URLs: https://smartinfo-voice-d8vsi.ondigitalocean.app/auth/callback
 *                    smartinfo://auth/callback
 */
app.get('/auth/callback', (request, response) => {
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '';
  const deepLinkBase = 'smartinfo://auth/callback';
  const deepLink = query ? `${deepLinkBase}?${query}` : deepLinkBase;

  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SmartInfo – Confirm email</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0B0B0F; color: #F5F5F7; padding: 24px;
    }
    .card {
      width: min(420px, 100%); background: #1C1C1E; border: 1px solid #2C2C2E;
      border-radius: 18px; padding: 28px 22px; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,.35);
    }
    h1 { font-size: 1.25rem; margin: 0 0 10px; }
    p { color: #A1A1A6; line-height: 1.45; margin: 0 0 14px; font-size: .95rem; }
    .err { color: #FF8A80; }
    .ok { color: #63E6BE; }
    a.btn {
      display: inline-block; margin-top: 8px; padding: 12px 18px; border-radius: 12px;
      background: #0A84FF; color: #fff; text-decoration: none; font-weight: 600;
    }
    code { font-size: .8rem; color: #8E8E93; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1 id="title">Opening SmartInfo…</h1>
    <p id="msg">Returning you to the app to finish email confirmation.</p>
    <p id="detail"></p>
    <a class="btn" id="open" href="${deepLink.replace(/"/g, '&quot;')}">Open SmartInfo</a>
    <p style="margin-top:18px"><code id="linkText"></code></p>
  </div>
  <script>
    (function () {
      var hash = window.location.hash ? window.location.hash.slice(1) : '';
      var search = window.location.search ? window.location.search.slice(1) : '';
      var raw = hash || search || ${JSON.stringify(query)};
      var params = new URLSearchParams(raw);
      var err = params.get('error_description') || params.get('error') || params.get('error_code');
      var code = params.get('code');
      var access = params.get('access_token');
      var type = params.get('type');
      var deep = 'smartinfo://auth/callback';
      if (raw) deep += (deep.indexOf('?') >= 0 ? '&' : '?') + raw;
      // Prefer hash tokens when present (implicit fragments)
      if (hash && !search) deep = 'smartinfo://auth/callback#' + hash;

      var title = document.getElementById('title');
      var msg = document.getElementById('msg');
      var detail = document.getElementById('detail');
      var open = document.getElementById('open');
      open.href = deep;
      document.getElementById('linkText').textContent = deep;

      if (err) {
        title.textContent = 'Confirmation link issue';
        title.className = 'err';
        var lower = String(err).toLowerCase();
        if (lower.indexOf('expired') >= 0 || lower.indexOf('invalid') >= 0) {
          msg.innerHTML = 'This email link is <strong>invalid or expired</strong> (often because it was already opened, or your mail app pre-scanned it).';
          detail.innerHTML = 'Open the <strong>SmartInfo app</strong> → Account → <strong>Resend confirmation</strong>, request a new email, then open the <em>newest</em> link once. Or enter the 6-digit code from the email if shown.';
        } else {
          msg.textContent = decodeURIComponent(String(err).replace(/\\+/g, ' '));
          detail.textContent = 'Use Resend confirmation in the app, then try again.';
        }
      } else if (code || access || type) {
        title.textContent = 'Email confirmed';
        title.className = 'ok';
        msg.textContent = 'Opening SmartInfo so you can log in.';
        detail.textContent = 'If the app does not open, tap the button below.';
        setTimeout(function () { window.location.replace(deep); }, 250);
      } else {
        title.textContent = 'Continue in SmartInfo';
        msg.textContent = 'Tap below to open the app. If you already confirmed, just log in.';
        setTimeout(function () { window.location.replace(deep); }, 400);
      }
    })();
  </script>
</body>
</html>`);
});

app.post('/chat', async (request, response) => {
  const apiKey = getGroqApiKey();
  const question = String(request.body?.question ?? '').trim();
  const categoryId = String(request.body?.categoryId ?? request.body?.categoryKey ?? '').trim().toLowerCase();

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

  // ── HARD GATE (server): never call Groq on category mismatch ──
  // categoryId is required for specialized modes. If missing, treat as block-safe general.
  // Editor mode is exempt: the client already retrieved a confident stored match,
  // so we only reformat that admin text — no category re-validation needed.
  const isEditorMode = String(request.body?.mode ?? '') === 'editor';
  if (!isEditorMode && categoryId && categoryId !== 'general_chat' && categoryId !== 'general chat') {
    const gate = validateCategoryServer(question, categoryId);
    if (!gate.isMatch) {
      response.status(200).json({
        blocked: true,
        recommendedCategory: gate.recommendedCategory,
        recommendedCategoryId: gate.recommendedCategoryId,
        currentCategoryId: categoryId,
        confidence: gate.confidence,
        answer: '',
      });
      return;
    }
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

    // Only force language when explicitly set to a real ISO code.
    // Do NOT default to Tagalog/tl — that makes English speech get Tagalog answers.
    // Values "auto", "detect", or empty = let Whisper auto-detect.
    const groqLanguage = (process.env.GROQ_STT_LANGUAGE ?? '').trim().toLowerCase();
    if (groqLanguage && groqLanguage !== 'auto' && groqLanguage !== 'detect' && groqLanguage !== 'none') {
      formData.append('language', groqLanguage);
    }

    const sttPrompt = [
      process.env.GROQ_STT_PROMPT?.trim(),
      'Transcribe the spoken words in the original language (English, Filipino/Tagalog, or Taglish). Do not translate. If silent or unclear, return empty text.',
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
    // Prefer auto language detection so English speech is not forced into Filipino.
    const elevenLang = (process.env.ELEVENLABS_LANGUAGE_CODE ?? '').trim().toLowerCase();
    if (elevenLang && elevenLang !== 'auto' && elevenLang !== 'detect' && elevenLang !== 'none') {
      formData.append('language_code', elevenLang);
    }

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

function normalizeReplyLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'english' || raw === 'en') {
    return 'english';
  }
  if (raw === 'tagalog' || raw === 'filipino' || raw === 'fil' || raw === 'tl') {
    return 'tagalog';
  }
  if (raw === 'taglish' || raw === 'auto') {
    return 'taglish';
  }
  return 'taglish';
}

/** Server-side category gate — mirrors client strict rules (no LLM). */
const SERVER_CATEGORY_KEYWORDS = {
  school: [
    'school', 'student', 'teacher', 'enrollment', 'enroll', 'registrar', 'campus', 'class', 'homework',
    'assignment', 'thesis', 'research', 'study', 'exam', 'quiz', 'grades', 'tuition', 'scholarship',
    'math', 'science', 'biology', 'chemistry', 'physics', 'essay', 'university', 'college', 'module',
    'lesson', 'classroom', 'eskwela', 'paaralan', 'guro', 'takdang', 'capstone', 'subject',
  ],
  government: [
    'government', 'gobyerno', 'philippine', 'philippines', 'law', 'legal', 'constitution', 'barangay',
    'nbi', 'psa', 'sss', 'pagibig', 'philhealth', 'bir', 'dti', 'lto', 'dole', 'comelec', 'election',
    'tax', 'passport', 'clearance', 'permit', 'license', 'philsys', 'due process', 'ordinance',
    'mayor', 'congress', 'senate', 'court', 'police', 'pnp', 'affidavit', 'cedula', 'voter', 'batas',
  ],
  technology: [
    'technology', 'computer', 'laptop', 'programming', 'code', 'coding', 'software', 'hardware',
    'javascript', 'typescript', 'python', 'java', 'react', 'html', 'css', 'sql', 'database', 'api',
    'cybersecurity', 'network', 'wifi', 'router', 'server', 'bug', 'debug', 'website', 'android',
    'ios', 'ai', 'github', 'git', 'frontend', 'backend', 'login page', 'pc', 'gpu', 'cpu', 'ram',
    'tech', 'app', 'browser', 'password',
  ],
  general_chat: [
    'joke', 'funny', 'movie', 'music', 'song', 'game', 'hobby', 'food', 'weather', 'dog', 'cat',
    'aso', 'pusa', 'story', 'random', 'bored', 'chat', 'love', 'friend', 'family', 'bakit may',
  ],
};

function serverScoreCategory(question, categoryId) {
  const lower = question.toLowerCase();
  let score = 0;
  for (const keyword of SERVER_CATEGORY_KEYWORDS[categoryId] ?? []) {
    if (lower.includes(keyword)) {
      score += keyword.length > 6 ? 2.2 : 1.6;
    }
  }
  return score;
}

function validateCategoryServer(question, categoryId) {
  const raw = String(categoryId || '').toLowerCase().replace(/\s+/g, '_');
  const normalized =
    raw === 'general' || raw === 'generalchat' ? 'general_chat' : raw;
  const greeting =
    /^(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|magandang\s+(umaga|hapon|gabi)|kamusta|kumusta|musta|hello po|hi po|thanks|thank you|salamat)[\s!.?]*$/i;

  if (greeting.test(question.trim())) {
    return { isMatch: true, recommendedCategory: 'General Chat', recommendedCategoryId: 'general_chat', confidence: 0.99 };
  }

  if (normalized === 'general_chat' || normalized === 'others' || normalized === 'public_places') {
    return { isMatch: true, recommendedCategory: 'General Chat', recommendedCategoryId: 'general_chat', confidence: 0.9 };
  }

  const scores = {
    school: serverScoreCategory(question, 'school'),
    government: serverScoreCategory(question, 'government'),
    technology: serverScoreCategory(question, 'technology'),
    general_chat: serverScoreCategory(question, 'general_chat'),
  };
  const currentScore = scores[normalized] ?? 0;
  const specialized = ['school', 'government', 'technology']
    .map((id) => ({ id, score: scores[id] }))
    .sort((a, b) => b.score - a.score);
  const top = specialized[0];

  if (currentScore >= 1.4) {
    return {
      isMatch: true,
      recommendedCategory: normalized,
      recommendedCategoryId: normalized,
      confidence: 0.9,
    };
  }

  let recommendedCategoryId = 'general_chat';
  if (top.score >= 1.4) {
    recommendedCategoryId = top.id;
  }

  const names = {
    school: 'School',
    government: 'Government',
    technology: 'Technology',
    general_chat: 'General Chat',
  };

  return {
    isMatch: false,
    recommendedCategory: names[recommendedCategoryId] ?? 'General Chat',
    recommendedCategoryId,
    confidence: 0.9,
    scores,
  };
}

async function answerWithGroqChat({ apiKey, model, body }) {
  const question = String(body?.question ?? '').trim();
  const category = String(body?.category ?? 'Public assistance').slice(0, 80);
  const categoryScope = String(body?.categoryScope ?? '').trim().slice(0, 500);
  const schoolName = String(body?.schoolName ?? '').trim().slice(0, 120);
  const intent = String(body?.intent ?? 'general').slice(0, 40);
  const replyLanguage = normalizeReplyLanguage(body?.replyLanguage);
  const simpleMode = Boolean(body?.simpleMode);
  const forceAnswerOutsideCategory = Boolean(body?.forceAnswerOutsideCategory);
  // Editor mode: rewrite ONLY the supplied stored content, never add facts.
  const isEditorMode = String(body?.mode ?? '') === 'editor';
  const broadOverview = Boolean(body?.broadOverview);
  // Broad multi-program answers need a large grounded window (was 4000 — too small).
  const groundedLimit = isEditorMode ? (broadOverview ? 14000 : 6000) : 4000;
  const groundedContent = String(body?.groundedContent ?? '').trim().slice(0, groundedLimit);

  try {
    const systemContent =
      isEditorMode && groundedContent
        ? buildKnowledgeEditorSystemPrompt({ schoolName, replyLanguage, simpleMode, broadOverview })
        : buildCompanionSystemPrompt({
            category,
            categoryScope,
            schoolName,
            intent,
            replyLanguage,
            simpleMode,
            forceAnswerOutsideCategory,
          });

    const userContent =
      isEditorMode && groundedContent
        ? buildKnowledgeEditorUserPrompt({ question, groundedContent, broadOverview })
        : question;

    // Broad scholarship/program overviews need high output budget (was 600 — truncated lists).
    const editorMaxTokens = broadOverview ? 3200 : 1600;
    const chatMaxTokens = simpleMode ? 500 : 900;

    const requestBody = {
      model,
      messages: [
        {
          role: 'system',
          content: systemContent,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      // Editor mode stays low-temperature so the model reorganizes rather than
      // invents. Give it a bit more room for headings/steps than a chat reply.
      temperature: isEditorMode ? 0.15 : 0.35,
      max_completion_tokens: isEditorMode ? editorMaxTokens : chatMaxTokens,
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
        answer:
          isEditorMode && groundedContent
            ? cleanKnowledgeEditorAnswer(answer)
            : cleanCompanionAnswer(answer),
        groundingMode: isEditorMode && groundedContent ? 'editor-v2' : undefined,
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

function buildCompanionSystemPrompt({
  category,
  categoryScope,
  schoolName,
  intent,
  replyLanguage,
  simpleMode,
  forceAnswerOutsideCategory,
}) {
  const languageInstruction =
    replyLanguage === 'english'
      ? 'Reply in clear, friendly English only. Do not switch to Tagalog or Taglish unless the user explicitly asks to change language.'
      : replyLanguage === 'tagalog'
        ? 'Reply in natural Filipino/Tagalog only. Do not use full English sentences unless a proper noun, form name, office name, or acronym needs English. Do not switch language unless the user explicitly asks.'
        : 'Reply in natural Taglish (Filipino + English mix) matching everyday Philippine conversation. Do not answer in pure English only, and do not answer in pure formal Tagalog only, unless the user explicitly asks.';
  const simplicityInstruction = simpleMode
    ? 'Use very simple words, short sentences, and beginner-friendly steps.'
    : 'Use friendly public-service wording with practical next steps.';
  const schoolInstruction = schoolName
    ? `The user selected school: ${schoolName}. Answer for that campus/institution when category is School. Do not invent campus-specific fees or schedules; direct them to Registrar, Student Affairs, or the official school office when unsure.`
    : '';
  const boundaryInstruction = forceAnswerOutsideCategory
    ? `The user chose to stay in ${category} even though the topic may be outside it. Give a short, careful answer, then gently remind them that a better category may exist.`
    : categoryScope ||
      `Stay strictly inside the ${category} category. If the question is outside this category, refuse to give a full answer and say which category fits better.`;

  return [
    'You are SmartInfo, a friendly digital guide with strict category knowledge boundaries.',
    languageInstruction,
    'Match the user language style strictly. Do not randomly switch languages mid-conversation.',
    simplicityInstruction,
    `Current category: ${category}. User intent: ${intent}.`,
    boundaryInstruction,
    schoolInstruction,
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

/**
 * Editor-mode system prompt. The model is a copy-editor for stored school
 * knowledge: it reorganizes and polishes the admin's exact text into a clean,
 * handbook-style answer, but must NEVER add, guess, or replace any fact.
 */
function buildKnowledgeEditorSystemPrompt({ schoolName, replyLanguage, simpleMode, broadOverview }) {
  const languageInstruction =
    replyLanguage === 'english'
      ? 'Write the response in clear, professional English.'
      : replyLanguage === 'tagalog'
        ? 'Write the response in natural, professional Filipino/Tagalog. Keep proper nouns, office names, form names, and acronyms as-is.'
        : 'Write the response in natural Taglish (Filipino + English mix) as used in everyday Philippine student services. Keep proper nouns, office names, form names, and acronyms as-is.';
  const simplicity = simpleMode
    ? 'Use very simple words and short sentences a first-time student can follow.'
    : 'Use clear, formal, student-friendly wording, like an official university FAQ or student handbook.';
  const schoolLine = schoolName ? `The information belongs to: ${schoolName}.` : '';

  const broadRules = broadOverview
    ? [
        'BROAD OVERVIEW MODE (list / explain all programs, scholarships, discounts, courses, services, requirements, or policies):',
        '- Review ALL sections in the SOURCE before answering. Do not stop after the first matching section.',
        '- Include EVERY distinct relevant program, option, or section found in the source.',
        '- Organize with numbered headings for each program, then short bullets for eligibility, benefits, GWA/percentages, and requirements.',
        '- A concise overview of every program is required — never give full detail for only the first two programs.',
        '- Preserve exact percentages, GWA ranges, eligibility rules, fee coverage (tuition only vs tuition + miscellaneous), and disclaimers.',
        '- Include important notes such as "subject to change without prior notice" when present in the source.',
        '- Never claim information is unavailable when it appears later in the provided source.',
      ]
    : [
        'SPECIFIC QUESTION MODE:',
        '- Focus on the named program or detail the student asked about.',
        '- Include that program’s full related details (eligibility, benefits, requirements, notes) from the source.',
        '- Do not omit requirements that appear next to the program in the source.',
      ];

  return [
    'You answer using the approved SmartInfo knowledge base (SOURCE INFORMATION only).',
    'You rewrite and explain like a helpful AI — not a raw database dump — but you NEVER invent facts outside the source.',
    schoolLine,
    languageInstruction,
    simplicity,
    'CRITICAL — ANSWER THE QUESTION:',
    '- Read the student question carefully and answer THAT specific question.',
    '- Use ONLY the SOURCE INFORMATION provided. Do not add, infer, or supplement from outside knowledge.',
    '- If the source does not contain enough detail to fully answer, say so honestly — do not invent.',
    ...broadRules,
    'YOU MAY: fix grammar, rephrase for clarity, organize into headings + bullets/steps.',
    'YOU MUST NEVER: invent requirements, offices, fees, or policies not in the source; use general web knowledge; or add topics not in the source.',
    'NEVER use hedging like "usually", "typically", "most schools", "generally", "normally". State only what the source says.',
    'Preserve every fact, number, percentage, office name, and location exactly as written in the source.',
    'FORMAT RULES FOR MOBILE CHAT (professional knowledge-base style):',
    '- Do NOT write conversational openers. Forbidden starts: "Sure,", "Certainly,", "Of course,", "Absolutely,", "Okay,", "Here is...", "Here\'s...", "I can help...", "Let me explain...".',
    '- Do NOT write a second introduction. The app already adds an official-info header. Start directly with the answer body.',
    '- Start with the actual content (e.g. "The following scholarship programs are currently available:" or the first program heading).',
    '- Section labels on their own lines (Eligibility, Benefits, Requirements, Important).',
    '- Use "- " for bullets and "1. 2. 3." for numbered programs. Blank lines between sections.',
    '- NEVER use markdown **bold** or *italics* or code fences.',
    '- Write like an official student handbook / FAQ, not like ChatGPT chat.',
    'Do not mention that you are an AI or that you reorganized text.',
    broadOverview
      ? 'Completeness beats extreme brevity: cover every distinct program in the source, even if the answer is longer.'
      : 'Keep focused on the named item, but include all of its related details from the source.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Editor-mode user message: the question plus the exact stored source text. */
function buildKnowledgeEditorUserPrompt({ question, groundedContent, broadOverview }) {
  return [
    question
      ? `Student question (answer THIS, using only the source below):\n"${question}"`
      : 'The student asked about the topic below.',
    '',
    'SOURCE INFORMATION (the ONLY facts you may use — do not add anything outside this):',
    '"""',
    groundedContent,
    '"""',
    '',
    'Rules:',
    '- Answer ONLY the student question using ONLY the source above.',
    '- Start immediately with the answer content. No "Sure", "Certainly", "Here is an overview", or similar fillers.',
    '- Do not add an official-info header; the app adds that separately.',
    broadOverview
      ? '- This is a broad overview: include every distinct program/section in the source that relates to the question. Do not stop after the first two.'
      : '- Focus on the named program or detail; include its complete related eligibility, benefits, and requirements from the source.',
    '- Do NOT add, infer, or supplement from outside knowledge.',
    '- Rewrite for clarity and natural flow. Preserve every fact, number, percentage, name, and location exactly.',
    '- If the source does not answer the question, say so honestly.',
  ].join('\n');
}

/**
 * Editor-mode cleaner. Strips conversational fillers and raw markdown noise.
 */
function cleanKnowledgeEditorAnswer(answer) {
  let text = String(answer || '')
    .replace(/^assistant:\s*/i, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    // Strip markdown bold/italic so chat never shows raw ****
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\*{2,}/g, '')
    .trim();

  // Drop model-emitted official headers (app adds one).
  text = text
    .replace(/^according to the school'?s official information:\s*/i, '')
    .replace(/^according to the available information:\s*/i, '')
    .replace(/^based on the (official records|stored knowledge|school'?s official information):\s*/i, '')
    .replace(/^base sa (opisyal na impormasyon|official info) ng school:\s*/i, '')
    .trim();

  // Drop conversational openers (first paragraph / first lines).
  for (let i = 0; i < 2; i++) {
    const before = text;
    text = text
      .replace(
        /^(sure|certainly|of course|absolutely|okay|ok|alright)[,!.]?\s+(here('s| is)|i can|let me)[^\n]*\n*/i,
        '',
      )
      .replace(/^here('s| is)\s+(an?\s+)?(overview|summary|list|information|details?)[^\n]*\n*/i, '')
      .replace(/^i can help[^\n]*\n*/i, '')
      .replace(/^let me (help|explain|share|provide)[^\n]*\n*/i, '')
      .trim();
    // Whole first paragraph is a short filler
    const paras = text.split(/\n\s*\n/);
    if (
      paras.length > 1 &&
      paras[0].length < 140 &&
      /^(sure|certainly|of course|here('s| is)|i can)\b/i.test(paras[0]) &&
      /overview|summary|programs?|scholarships?|help|obtain/i.test(paras[0])
    ) {
      text = paras.slice(1).join('\n\n').trim();
    }
    if (text === before) break;
  }

  return text.replace(/\n{3,}/g, '\n\n').trim();
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
  const voiceId = body?.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? 'pNInz6obpgDQGcFmaJgB';

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
            stability: body.stability ?? 0.4,
            similarity_boost: body.similarityBoost ?? 0.86,
            style: body.style ?? 0.35,
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

// ---------------------------------------------------------------------------
// Website Knowledge Import — Super Admin only (RBAC enforced here + RLS)
// ---------------------------------------------------------------------------
async function withSuperAdmin(request, response, handler) {
  try {
    const auth = await requireSuperAdminFromAuthHeader(request.headers.authorization);
    await handler(auth);
  } catch (error) {
    const status = error?.status || 500;
    response.status(status).json({
      error: error instanceof Error ? error.message : 'Request failed.',
    });
  }
}

app.post('/crawl/start', async (request, response) => {
  await withSuperAdmin(request, response, async (auth) => {
    const sourceId = String(request.body?.sourceId || '').trim();
    if (!sourceId) {
      response.status(400).json({ error: 'sourceId is required.' });
      return;
    }
    const writeToken = getWriteToken(auth.accessToken);
    const source = await loadSourceById(sourceId, writeToken);
    if (!source) {
      response.status(404).json({ error: 'Website source not found.' });
      return;
    }
    if (source.status === 'crawling') {
      response.status(409).json({ error: 'A crawl is already running for this source.' });
      return;
    }
    const job = await createCrawlJob(sourceId, auth.userId, writeToken);
    if (!job?.id) {
      response.status(500).json({ error: 'Could not create crawl job.' });
      return;
    }
    // Fire-and-forget; client polls job status via Supabase.
    void runWebsiteCrawl({
      source,
      jobId: job.id,
      writeToken,
      createdBy: auth.userId,
    });
    response.json({ ok: true, jobId: job.id, sourceId });
  });
});

app.post('/crawl/stop', async (request, response) => {
  await withSuperAdmin(request, response, async () => {
    const jobId = String(request.body?.jobId || '').trim();
    if (!jobId) {
      response.status(400).json({ error: 'jobId is required.' });
      return;
    }
    const stopped = requestStopCrawl(jobId);
    response.json({
      ok: true,
      stopped,
      running: isCrawlRunning(jobId),
      message: stopped
        ? 'Stop signal sent. Crawl will halt after the current page.'
        : 'Job was not running on this server instance (it may already be finished).',
    });
  });
});

app.get('/crawl/status/:jobId', async (request, response) => {
  await withSuperAdmin(request, response, async (auth) => {
    const jobId = String(request.params.jobId || '').trim();
    const writeToken = getWriteToken(auth.accessToken);
    const url = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    const res = await fetch(
      `${url}/rest/v1/website_crawl_jobs?id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${writeToken}`,
        },
      },
    );
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      response.status(404).json({ error: 'Job not found.' });
      return;
    }
    response.json({
      ok: true,
      job: row,
      runningOnThisServer: isCrawlRunning(jobId),
    });
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`SmartInfo voice proxy running at http://127.0.0.1:${port}`);
});
