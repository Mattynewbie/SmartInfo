import { env } from './env';
import { APP_TITLE } from './branding';
import type { Category, CompanionIntent, FAQ, PublicInfo } from '../types';

type CompanionRequest = {
  question: string;
  categoryId: string;
  categories: Category[];
  faqs: FAQ[];
  publicInfo: PublicInfo[];
  simpleMode: boolean;
  intent: CompanionIntent;
  signal?: AbortSignal;
};

type CompanionReply = {
  text: string;
  source: 'faq' | 'public_information' | 'ai_proxy' | 'fallback';
};

type ReplyLanguage = 'english' | 'taglish';
type MatchScore = {
  exactTokenCount: number;
  matchedTokenCount: number;
  score: number;
  tokens: string[];
};

const devAiProxyUrl =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://127.0.0.1:8787' : '';
const aiProxyTimeoutMs = 16000;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !stopWords.has(token));

const rawTokens = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const stopWords = new Set([
  'a',
  'an',
  'ako',
  'and',
  'ang',
  'ano',
  'are',
  'ba',
  'by',
  'common',
  'companion',
  'dapat',
  'dalhin',
  'dala',
  'do',
  'does',
  'for',
  'from',
  'gagawin',
  'gawin',
  'get',
  'go',
  'government',
  'guide',
  'hall',
  'help',
  'how',
  'i',
  'in',
  'information',
  'is',
  'kailangan',
  'kailan',
  'kanino',
  'ko',
  'kong',
  'kumuha',
  'kung',
  'magdala',
  'magkano',
  'me',
  'meron',
  'mode',
  'muna',
  'my',
  'nadalhin',
  'nasa',
  'need',
  'needs',
  'ng',
  'office',
  'offices',
  'on',
  'or',
  'pa',
  'paano',
  'papaano',
  'para',
  'place',
  'places',
  'po',
  'process',
  'public',
  'pupunta',
  'requirement',
  'requirements',
  'sa',
  'saan',
  'school',
  'should',
  'sino',
  'smart',
  'step',
  'steps',
  'the',
  'to',
  'una',
  'what',
  'where',
  'with',
  'you',
  'your',
]);

const unique = (items: string[]) => Array.from(new Set(items));

function detectReplyLanguage(_question: string): ReplyLanguage {
  return 'taglish';
}

function scoreMatch(queryTokens: string[], searchable: string): MatchScore {
  const text = searchable.toLowerCase();
  const words = new Set(normalize(searchable));
  const agencyTokens = ['nbi', 'barangay', 'police', 'psa', 'sss', 'pagibig', 'philhealth'];
  const requestedAgency = agencyTokens.find((token) => queryTokens.includes(token));

  if (requestedAgency && !words.has(requestedAgency)) {
    return {
      exactTokenCount: 0,
      matchedTokenCount: 0,
      score: -10,
      tokens: queryTokens,
    };
  }

  return unique(queryTokens).reduce<MatchScore>((match, token) => {
    if (words.has(token)) {
      return {
        ...match,
        exactTokenCount: match.exactTokenCount + 1,
        matchedTokenCount: match.matchedTokenCount + 1,
        score: match.score + 3,
      };
    }

    if (token.length > 3 && text.includes(token)) {
      return {
        ...match,
        matchedTokenCount: match.matchedTokenCount + 1,
        score: match.score + 2,
      };
    }

    return match;
  }, {
    exactTokenCount: 0,
    matchedTokenCount: 0,
    score: 0,
    tokens: unique(queryTokens),
  });
}

function isStrongSavedMatch(match: MatchScore) {
  const tokenCount = match.tokens.length;

  if (!tokenCount || match.score < 2 || !match.matchedTokenCount) {
    return false;
  }

  if (tokenCount === 1) {
    return match.exactTokenCount > 0 || match.tokens[0].length >= 5;
  }

  if (match.matchedTokenCount >= 2 && match.score >= 4) {
    return true;
  }

  return match.exactTokenCount >= 1 && match.score >= Math.min(6, tokenCount * 2);
}

function getCategoryName(categories: Category[], categoryId: string) {
  return categories.find((item) => item.id === categoryId)?.name ?? 'this office';
}

function stepsFromText(text: string, requirements: string[] = []) {
  const baseSteps = text
    .split(/[.]\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);

  const requirementSteps = requirements.length
    ? [`Prepare these first: ${requirements.join(', ')}.`]
    : [];

  return unique([...requirementSteps, ...baseSteps]).slice(0, 5);
}

function formatStepGuide(intro: string, steps: string[], language: ReplyLanguage = 'taglish') {
  const renderedSteps = steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const closing =
    language === 'taglish'
      ? 'Kung may kulang, magtanong muna sa front desk or assigned office bago pumila.'
      : 'If anything is missing, ask the front desk or assigned office before lining up.';

  return `${intro}\n\n${renderedSteps}\n\n${closing}`;
}

function formatChecklist(items: string[]) {
  return items.map((item) => `- ${item}`).join('\n');
}

function nbiTaglishAnswer(intent: CompanionIntent, simpleMode: boolean) {
  const requirements = [
    'Dalawang valid government-issued ID',
    'NBI online account',
    'Reference number',
    'Proof of payment kung meron',
  ];

  const steps = [
    'Pumunta sa clearance.nbi.gov.ph at gumawa or mag-log in sa account.',
    'Kumpletuhin ang applicant information.',
    'Piliin ang NBI branch, date, at time ng appointment.',
    'Pumili ng payment option at bayaran gamit ang reference number.',
    'Pumunta sa napiling branch sa appointment date para sa biometrics at printing.',
  ];

  if (intent === 'requirements') {
    return `Para sa NBI Clearance, ihanda ito:\n\n${formatChecklist(requirements)}\n\nUna pa rin: mag-online appointment muna sa clearance.nbi.gov.ph bago pumunta sa branch.`;
  }

  if (intent === 'location') {
    return 'Pumunta ka sa NBI branch or clearance center na pinili mo online. Important: mag-book muna ng appointment sa clearance.nbi.gov.ph bago pumunta, para may schedule ka at reference number.';
  }

  if (intent === 'guide') {
    return formatStepGuide('Sige, guide kita sa NBI Clearance. Online appointment muna ang first step.', steps, 'taglish');
  }

  if (simpleMode) {
    return `Una mong gawin: mag-online appointment muna sa clearance.nbi.gov.ph. Hindi muna diretso sa NBI branch.\n\nPagkatapos, bayaran ang reference number, dalhin ang 2 valid ID, at pumunta sa branch sa napili mong schedule.`;
  }

  return `Nahanap ko sa saved public info: Una, online appointment muna sa clearance.nbi.gov.ph. Gumawa or mag-log in, kumpletuhin ang applicant information, piliin ang NBI branch at schedule, then bayaran ang reference number.\n\nSa appointment day, dalhin ang 2 valid government ID at reference/proof of payment para sa biometrics at printing. Kung may HIT, sundin ang release date ng NBI.\n\nGusto mo ng step-by-step? Tap Guide Me.`;
}

function knownTaglishAnswer(searchable: string, intent: CompanionIntent, simpleMode: boolean) {
  const text = searchable.toLowerCase();

  if (text.includes('nbi')) {
    return nbiTaglishAnswer(intent, simpleMode);
  }

  if (text.includes('barangay') && text.includes('clearance')) {
    return 'Para sa barangay clearance, magdala ng valid ID, proof of address, at payment kung required. Pumunta sa Barangay Hall, fill out ang form, submit ang documents, then hintayin ang release.';
  }

  if (text.includes('enroll') || text.includes('enrollment')) {
    return 'Para sa enrollment, ihanda ang report card, birth certificate, good moral certificate, at ID photo. Una kang pumunta sa Registrar, submit ang requirements, then hintayin ang section at schedule confirmation.';
  }

  if (text.includes('registrar')) {
    return 'Ang Registrar ay usually malapit sa main administration office. Kung bago ka sa campus, sabihin sa guard na pupunta ka sa Registrar at dalhin ang school ID or enrollment documents.';
  }

  return null;
}

function fallbackByIntent(categoryName: string, intent: CompanionIntent, language: ReplyLanguage) {
  if (language === 'taglish') {
    if (intent === 'location') {
      return `Para sa ${categoryName}, magandang first stop ang Information Desk or front office. Sabihin mo lang kung ano ang kailangan mo, then itanong kung aling window or room ang tamang puntahan.`;
    }

    if (intent === 'requirements') {
      return `Para sa ${categoryName}, ihanda muna ang valid ID, previous record or reference number kung meron, at completed form kung available. Tip: magdala ng original copies at picture ng documents para ready ka.`;
    }

    if (intent === 'announcement') {
      return 'Wala pa akong matching announcement sa saved info. Check mo muna ang official bulletin board, verified page, or front office para sa latest advisory.';
    }

    if (intent === 'safety') {
      return 'Stay calm, hanapin ang nearest exit or help desk, at sundin ang instructions ng staff. Kung emergency or may injured, tumawag agad sa local emergency services.';
    }

    if (intent === 'guide') {
      return formatStepGuide(`Sige, guide kita step-by-step para sa ${categoryName}.`, [
        'Linawin muna ang exact request or concern.',
        'Ihanda ang ID at related documents.',
        'Pumunta sa information desk or assigned office.',
        'Tanungin ang tamang form, window, or person in charge.',
        'Itago ang receipt, claim stub, or reference number.',
      ], 'taglish');
    }

    return `Hindi ko maabot ang AI service ngayon, pero tutulungan pa rin kita. Para sa ${categoryName}, magandang start ang Information Desk or assigned office. Magdala ng ID, sabihin ang concern mo in simple words, at itanong kung aling window or room ang dapat puntahan.`;
  }

  if (intent === 'location') {
    return `For ${categoryName}, best first stop is the Information Desk or front office. Sabihin mo lang what you need, then ask which window or room handles it. If it is school-related, Registrar or Student Affairs is usually the right starting point.`;
  }

  if (intent === 'requirements') {
    return `For ${categoryName}, prepare a valid ID, any previous record or reference number, and the completed form if available. Tip: take a clear photo of your documents and bring the original copies, para ready ka.`;
  }

  if (intent === 'announcement') {
    return `I do not see a matching announcement yet. Please check the official bulletin board, verified page, or front office for the latest posted advisory.`;
  }

  if (intent === 'safety') {
    return `Stay calm, look for the nearest exit or help desk, and follow official staff instructions. If there is danger or someone needs urgent help, contact local emergency services right away.`;
  }

  if (intent === 'guide') {
    return formatStepGuide(`Sure, I can guide you step-by-step for ${categoryName}.`, [
      'Identify the exact request or concern.',
      'Prepare your ID and related documents.',
      'Go to the information desk or assigned office.',
      'Ask for the correct form, window, or person in charge.',
      'Keep your receipt, claim stub, or reference number.',
    ], 'english');
  }

  return `I cannot reach the AI service right now, but I can still help. For ${categoryName}, start at the Information Desk or assigned office, bring an ID, and explain your concern in simple words.`;
}

function buildLocalReply(request: CompanionRequest): CompanionReply {
  const queryTokens = normalize(request.question);
  const categoryName = getCategoryName(request.categories, request.categoryId);
  const replyLanguage = detectReplyLanguage(request.question);

  const activeFaqs = request.faqs.filter(
    (faq) => faq.categoryId === request.categoryId && faq.isActive,
  );

  const faqMatch = activeFaqs
    .map((faq) => ({
      faq,
      match: scoreMatch(
        queryTokens,
        `${faq.question} ${faq.answer} ${faq.tags.join(' ')}`,
      ),
    }))
    .sort((left, right) => right.match.score - left.match.score)[0];

  if (faqMatch && isStrongSavedMatch(faqMatch.match)) {
    const taglishAnswer =
      replyLanguage === 'taglish'
        ? knownTaglishAnswer(
            `${faqMatch.faq.question} ${faqMatch.faq.answer} ${faqMatch.faq.tags.join(' ')}`,
            request.intent,
            request.simpleMode,
          )
        : null;

    if (taglishAnswer) {
      return {
        source: 'faq',
        text: taglishAnswer,
      };
    }

    const prefix = request.simpleMode
      ? replyLanguage === 'taglish'
        ? 'Simple answer: '
        : 'Simple answer: '
      : replyLanguage === 'taglish'
        ? 'Nahanap ko sa saved public info: '
        : 'Here is the saved public info I found: ';
    const nextStep =
      request.intent === 'guide'
        ? replyLanguage === 'taglish'
          ? '\n\nNext step: punta muna sa assigned office, then ipakita ang documents.'
          : '\n\nNext step: punta muna sa assigned office, then show your documents.'
        : replyLanguage === 'taglish'
          ? '\n\nGusto mo ng step-by-step? Tap Guide Me.'
          : '\n\nNeed step-by-step help? Tap Guide Me and I will break it down.';

    return {
      source: 'faq',
      text: `${prefix}${faqMatch.faq.answer}${nextStep}`,
    };
  }

  const infoMatch = request.publicInfo
    .filter((info) => info.categoryId === request.categoryId)
    .map((info) => ({
      info,
      match: scoreMatch(
        queryTokens,
        `${info.title} ${info.body} ${info.type} ${info.tags.join(' ')} ${
          info.locationName ?? ''
        } ${(info.requirements ?? []).join(' ')}`,
      ),
    }))
    .sort((left, right) => right.match.score - left.match.score)[0];

  if (infoMatch && isStrongSavedMatch(infoMatch.match)) {
    const { info } = infoMatch;
    const taglishAnswer =
      replyLanguage === 'taglish'
        ? knownTaglishAnswer(
            `${info.title} ${info.body} ${info.type} ${info.tags.join(' ')} ${info.locationName ?? ''}`,
            request.intent,
            request.simpleMode,
          )
        : null;

    if (taglishAnswer) {
      return {
        source: 'public_information',
        text: taglishAnswer,
      };
    }

    if (request.intent === 'requirements' && info.requirements?.length) {
      return {
        source: 'public_information',
        text:
          replyLanguage === 'taglish'
            ? `Para sa ${info.title}, ihanda itong checklist:\n\n${formatChecklist(info.requirements)}\n\nPag ready na, pumunta sa ${info.locationName ?? 'assigned office'}.`
            : `For ${info.title}, prepare this checklist:\n\n${formatChecklist(info.requirements)}\n\nAfter that, go to ${info.locationName ?? 'the assigned office'}.`,
      };
    }

    if (request.intent === 'location' && info.locationName) {
      return {
        source: 'public_information',
        text:
          replyLanguage === 'taglish'
            ? `Pumunta ka sa ${info.locationName}. ${info.body}\n\nKung hindi ka sure, magtanong sa guard or information desk at sabihin: "${info.title}".`
            : `You should go to ${info.locationName}. ${info.body}\n\nIf you are unsure, ask the guard or information desk and say: "${info.title}".`,
      };
    }

    if (request.intent === 'guide') {
      return {
        source: 'public_information',
        text: formatStepGuide(
          replyLanguage === 'taglish'
            ? `Sige, guide kita for ${info.title}.`
            : `Sure, I can guide you for ${info.title}.`,
          stepsFromText(info.body, info.requirements),
          replyLanguage,
        ),
      };
    }

    return {
      source: 'public_information',
      text: request.simpleMode
        ? replyLanguage === 'taglish'
          ? `Simple answer: ${info.body}`
          : `Simple answer: ${info.body}`
        : replyLanguage === 'taglish'
          ? `Nahanap ko sa saved public info: ${info.body}\n\nBest next stop: ${info.locationName ?? 'Information Desk or front office'}.`
          : `${info.body}\n\nBest next stop: ${info.locationName ?? 'Information Desk or front office'}.`,
    };
  }

  return {
    source: 'fallback',
    text: fallbackByIntent(categoryName, request.intent, replyLanguage),
  };
}

async function askProxy(request: CompanionRequest): Promise<CompanionReply | null> {
  const proxyUrl = env.aiProxyUrl || env.voiceProxyUrl || devAiProxyUrl;

  if (!proxyUrl) {
    return null;
  }

  const cleanProxyUrl = proxyUrl.replace(/\/$/, '');
  const endpoint =
    cleanProxyUrl.endsWith('/chat') || cleanProxyUrl.endsWith('/companion-answer')
      ? cleanProxyUrl
      : `${cleanProxyUrl}/chat`;

  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appTitle: APP_TITLE,
        question: request.question,
        category: getCategoryName(request.categories, request.categoryId),
        simpleMode: request.simpleMode,
        intent: request.intent,
        replyLanguage: detectReplyLanguage(request.question),
      }),
    }, aiProxyTimeoutMs, request.signal);

    if (!response.ok) {
      return null;
    }

    throwIfAborted(request.signal);
    const payload = (await response.json()) as { answer?: string };
    throwIfAborted(request.signal);
    return payload.answer ? { text: payload.answer, source: 'ai_proxy' } : null;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.warn('AI proxy failed, using local companion reply.', error);
    return null;
  }
}

export async function getCompanionReply(request: CompanionRequest): Promise<CompanionReply> {
  throwIfAborted(request.signal);
  const localReply = buildLocalReply(request);
  throwIfAborted(request.signal);

  if (localReply.source !== 'fallback') {
    return localReply;
  }

  const proxyReply = await askProxy(request);
  return proxyReply ?? localReply;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Assistant request was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function isAbortError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError') {
    return true;
  }
  // React Native's fetch throws a TypeError with this message on cancellation
  const msg = error.message.toLowerCase();
  return (
    msg.includes('fetch request has been canceled') ||
    msg.includes('aborted') ||
    msg.includes('cancelled') ||
    msg.includes('canceled')
  );
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
  } finally {
    signal?.removeEventListener('abort', abortRequest);
    clearTimeout(timeoutId);
  }
}
