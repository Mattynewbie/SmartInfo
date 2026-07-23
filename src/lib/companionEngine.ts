import { env } from './env';
import { APP_TITLE } from './branding';
import {
  buildCategoryScopeInstruction,
  validateCategory,
  type CategoryClassification,
} from './categoryClassifier';
import {
  resolveReplyLanguage,
  type AppLanguageMode,
  type ReplyLanguage,
} from './replyLanguage';
import type { Category, CompanionIntent, FAQ, PublicInfo } from '../types';

/** Minimal article shape the engine needs to ground answers (from knowledgeBase.ts). */
export type KnowledgeArticleLite = {
  id: string;
  categoryId: string;
  subcategoryId?: string | null;
  subcategoryName?: string;
  title: string;
  content: string;
  keywords: string[];
  tags: string[];
  priority: number;
  sourceType?: 'manual' | 'website';
};

type CompanionRequest = {
  question: string;
  categoryId: string;
  categories: Category[];
  faqs: FAQ[];
  publicInfo: PublicInfo[];
  simpleMode: boolean;
  intent: CompanionIntent;
  /** Selected school when category is School (e.g. Arellano University - Jose Rizal Campus). */
  schoolName?: string;
  /** auto | english | tagalog | taglish — default auto follows user input. */
  languageMode?: AppLanguageMode;
  /**
   * Verified Knowledge Base articles for this category. When the selected
   * category is KB-managed, the AI answers ONLY from these and never invents
   * school-specific facts. Empty/undefined = category not KB-managed.
   */
  knowledgeArticles?: KnowledgeArticleLite[];
  signal?: AbortSignal;
};

type CompanionAnswer = {
  blocked: false;
  text: string;
  source: 'faq' | 'public_information' | 'ai_proxy' | 'fallback' | 'knowledge_base';
};

type CompanionBlocked = {
  blocked: true;
  classification: CategoryClassification;
};

export type CompanionResult = CompanionAnswer | CompanionBlocked;

type CompanionReply = {
  text: string;
  source: 'faq' | 'public_information' | 'ai_proxy' | 'fallback' | 'knowledge_base';
};

type MatchScore = {
  exactTokenCount: number;
  matchedTokenCount: number;
  score: number;
  tokens: string[];
};

const devAiProxyUrl =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://127.0.0.1:8787' : '';
/** General chat proxy timeout. */
const aiProxyTimeoutMs = 14000;
/**
 * Knowledge AI editor timeout.
 * Broad multi-program answers need more room than short FAQ polish.
 */
const kbEditorTimeoutMs = 8000;
const kbEditorTimeoutBroadMs = 22000;
/** Website crawl pages longer than this are treated as long-form sources. */
const LONG_ARTICLE_CHARS = 1800;

/** Context budgets — broad overviews must keep every distinct program section. */
const CONTEXT_BUDGET_SPECIFIC = 4500;
const CONTEXT_BUDGET_BROAD = 14000;
const MAX_CHUNKS_SPECIFIC = 6;
const MAX_CHUNKS_BROAD = 28;
const NEIGHBOR_EXPAND = 2;

/** App category id whose public_information is school-scoped, admin-authored truth. */
const SCHOOL_CATEGORY_ID = 'school';
/** Minimum article score to treat a stored entry as a confident match. */
// Lowered slightly so long website-imported pages (body matches) still ground answers.
const KB_MATCH_THRESHOLD = 2.5;

/** Topics that often need multi-section / multi-program overview answers. */
const OVERVIEW_TOPIC_RE =
  /\b(scholarship|scholarships|iskolar|iskolarship|discount|discounts|program|programs|course|courses|requirement|requirements|service|services|procedure|procedures|enrollment|admission|admissions|tuition|fee|fees|policy|policies|option|options|benefit|benefits)\b/i;

/**
 * True when the user wants a complete overview of a family of items
 * (all scholarships, all discounts, all courses…) rather than one named item.
 * Reusable across school/government knowledge — not scholarship-hardcoded.
 */
export function isBroadOverviewQuestion(question: string): boolean {
  const q = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return false;

  // Named program / concrete detail questions are never "broad overviews".
  if (isNamedProgramQuestion(q)) {
    return false;
  }

  // Explicit multi-item overview intent
  if (
    /\b(list|lahat|all|every|overview|summarize|summary|ano[- ]?ano|anong mga|ano ang mga|ano ba ang mga)\b/i.test(
      q,
    )
  ) {
    return OVERVIEW_TOPIC_RE.test(q) || /\b(programs?|options?|services?)\b/i.test(q);
  }

  // "what are the scholarships / programs / discounts available?"
  // (Avoid matching "what are the requirements for F. Cayco…")
  if (
    /\b(what are the|which are the|what scholarships|what discounts|what programs|what courses|what services)\b/i.test(
      q,
    ) &&
    OVERVIEW_TOPIC_RE.test(q) &&
    !/\b(requirements?|eligibility|documents?)\b.{0,20}\bfor\b/i.test(q)
  ) {
    return true;
  }

  // "…available…" only when asking about the family, not a single named item
  if (/\bavailable\b/i.test(q) && OVERVIEW_TOPIC_RE.test(q)) {
    return true;
  }

  // "Can you explain the scholarship(s)?" / "Explain school scholarships"
  if (/\b(explain|describe|tell me about|sabihin|ipaliwanag)\b/i.test(q) && OVERVIEW_TOPIC_RE.test(q)) {
    return true;
  }

  // "What scholarships can I apply for?" / "What scholarship is available?"
  if (/\b(what|which|ano|anong)\b/i.test(q) && OVERVIEW_TOPIC_RE.test(q)) {
    return true;
  }

  // Short queries that are pure topic nouns: "scholarships", "discounts"
  if (/^(the\s+)?(school\s+)?(scholarship|scholarships|discounts?|courses?|programs?|requirements?)\??$/.test(q)) {
    return true;
  }

  return false;
}

/**
 * Heuristic: user named a specific program/person grant or a concrete detail
 * rather than the whole category overview.
 * e.g. "F. Cayco", "Esguerra", "High Honors", "Academic Achievement in College"
 */
function isNamedProgramQuestion(question: string): boolean {
  const q = question.toLowerCase();
  // Explicit multi-program list intent always stays broad.
  if (/\b(all|lahat|list|mga|ano[- ]?ano|available programs?|available scholarships?)\b/i.test(q)) {
    return false;
  }
  // Proper-name style markers common in PH scholarship titles (F. Cayco)
  if (/\b[a-z]\.\s*[a-z]{2,}/i.test(question)) return true;
  if (/\b(cayco|esguerra|valedictorian|salutatorian|memorial scholarship)\b/i.test(q)) {
    return true;
  }
  // Specific honor tier / GWA / percentage detail questions
  if (
    /\b(with\s+)?(highest honors|high honors|with honors)\b/i.test(q) ||
    /\b\d{1,3}\s*%\b/.test(q) ||
    /\bgwa\b/i.test(q)
  ) {
    return true;
  }
  // "requirements for …" / "discount for …" are specific
  if (
    /\b(requirements?|eligibility|benefit|coverage|discount)\b.{0,60}\bfor\b/i.test(q) ||
    /\bfor\b.{0,60}\b(requirements?|eligibility|scholarship|discount)\b/i.test(q)
  ) {
    return true;
  }
  if (/\bacademic achievement in college\b/i.test(q)) return true;
  if (/\b(junior high school entrance|college entrance scholarship)\b/i.test(q)) {
    return true;
  }
  // "how much is the discount for …"
  if (/\b(how much|magkano|gaano)\b/i.test(q) && OVERVIEW_TOPIC_RE.test(q)) {
    return true;
  }
  return false;
}

function isDevKbLog(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function logKbRetrievalDetail(payload: Record<string, unknown>): void {
  if (!isDevKbLog()) return;
  try {
    console.log('[KB][retrieval]', JSON.stringify(payload));
  } catch {
    console.log('[KB][retrieval]', payload);
  }
}

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
    language === 'english'
      ? 'If anything is missing, ask the front desk or assigned office before lining up.'
      : language === 'tagalog'
        ? 'Kung may kulang, magtanong muna sa front desk o assigned office bago pumila.'
        : 'Kung may kulang, magtanong muna sa front desk or assigned office bago pumila.';

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
  if (language === 'tagalog') {
    if (intent === 'location') {
      return `Para sa ${categoryName}, magandang unang puntahan ang Information Desk o front office. Sabihin ang kailangan mo, at itanong kung aling window o silid ang tama.`;
    }
    if (intent === 'requirements') {
      return `Para sa ${categoryName}, ihanda muna ang valid ID, dating record o reference number kung meron, at kumpletong form. Magdala ng orihinal at kopya ng mga dokumento.`;
    }
    if (intent === 'announcement') {
      return 'Wala pa akong katugmang anunsyo sa naka-save na impormasyon. Tingnan ang opisyal na bulletin board, verified page, o front office para sa pinakabagong paalala.';
    }
    if (intent === 'safety') {
      return 'Manatiling kalmado, hanapin ang pinakamalapit na labasan o help desk, at sundin ang utos ng kawani. Kung may emerhensiya, tumawag agad sa lokal na serbisyong pang-emergency.';
    }
    if (intent === 'guide') {
      return formatStepGuide(`Sige, gagabayan kita nang sunud-sunod para sa ${categoryName}.`, [
        'Linawin muna ang eksaktong kahilingan o concern.',
        'Pumunta sa Information Desk o assigned office.',
        'Ipakita ang ID at mga dokumento kung kailangan.',
        'Sundin ang bilang o window na ituturo sa iyo.',
        'Kumpirmahin muli bago umalis kung may bayad o follow-up.',
      ], 'tagalog');
    }
    return `Hindi ko maabot ang AI service ngayon, pero matutulungan pa rin kita. Para sa ${categoryName}, magsimula sa Information Desk o assigned office, magdala ng ID, at ipaliwanag nang simple ang concern mo.`;
  }

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
    return `For ${categoryName}, the best first stop is the Information Desk or front office. Say what you need, then ask which window or room handles it. For school concerns, Registrar or Student Affairs is usually the right start.`;
  }

  if (intent === 'requirements') {
    return `For ${categoryName}, prepare a valid ID, any previous record or reference number, and the completed form if available. Tip: take a clear photo of your documents and bring the original copies.`;
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
  const schoolLabel =
    request.categoryId === 'school' && request.schoolName?.trim()
      ? request.schoolName.trim()
      : '';
  const contextName = schoolLabel || categoryName;
  const replyLanguage = resolveReplyLanguage(request.question, request.languageMode ?? 'auto');

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
    const localKnownAnswer =
      replyLanguage === 'english'
        ? null
        : knownTaglishAnswer(
            `${faqMatch.faq.question} ${faqMatch.faq.answer} ${faqMatch.faq.tags.join(' ')}`,
            request.intent,
            request.simpleMode,
          );

    if (localKnownAnswer) {
      return {
        source: 'faq',
        text: localKnownAnswer,
      };
    }

    const prefix = request.simpleMode
      ? replyLanguage === 'english'
        ? 'Simple answer: '
        : 'Simpleng sagot: '
      : replyLanguage === 'english'
        ? 'Here is the saved info I found: '
        : replyLanguage === 'tagalog'
          ? 'Nahanap ko sa naka-save na impormasyon: '
          : 'Nahanap ko sa saved public info: ';
    const nextStep =
      request.intent === 'guide'
        ? replyLanguage === 'english'
          ? '\n\nNext step: go to the assigned office, then show your documents.'
          : replyLanguage === 'tagalog'
            ? '\n\nSusunod: pumunta muna sa assigned office, saka ipakita ang mga dokumento.'
            : '\n\nNext step: punta muna sa assigned office, then ipakita ang documents.'
        : replyLanguage === 'english'
          ? '\n\nNeed step-by-step help? Tap Guide Me and I will break it down.'
          : replyLanguage === 'tagalog'
            ? '\n\nGusto mo ng sunud-sunod na gabay? Pindutin ang Guide Me.'
            : '\n\nGusto mo ng step-by-step? Tap Guide Me.';

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
    const localKnownAnswer =
      replyLanguage === 'english'
        ? null
        : knownTaglishAnswer(
            `${info.title} ${info.body} ${info.type} ${info.tags.join(' ')} ${info.locationName ?? ''}`,
            request.intent,
            request.simpleMode,
          );

    if (localKnownAnswer) {
      return {
        source: 'public_information',
        text: localKnownAnswer,
      };
    }

    if (request.intent === 'requirements' && info.requirements?.length) {
      return {
        source: 'public_information',
        text:
          replyLanguage === 'english'
            ? `For ${info.title}, prepare this checklist:\n\n${formatChecklist(info.requirements)}\n\nAfter that, go to ${info.locationName ?? 'the assigned office'}.`
            : replyLanguage === 'tagalog'
              ? `Para sa ${info.title}, ihanda ang checklist na ito:\n\n${formatChecklist(info.requirements)}\n\nKapag handa na, pumunta sa ${info.locationName ?? 'assigned office'}.`
              : `Para sa ${info.title}, ihanda itong checklist:\n\n${formatChecklist(info.requirements)}\n\nPag ready na, pumunta sa ${info.locationName ?? 'assigned office'}.`,
      };
    }

    if (request.intent === 'location' && info.locationName) {
      return {
        source: 'public_information',
        text:
          replyLanguage === 'english'
            ? `You should go to ${info.locationName}. ${info.body}\n\nIf you are unsure, ask the guard or information desk and say: "${info.title}".`
            : replyLanguage === 'tagalog'
              ? `Pumunta sa ${info.locationName}. ${info.body}\n\nKung hindi ka sigurado, magtanong sa guard o information desk at sabihin: "${info.title}".`
              : `Pumunta ka sa ${info.locationName}. ${info.body}\n\nKung hindi ka sure, magtanong sa guard or information desk at sabihin: "${info.title}".`,
      };
    }

    if (request.intent === 'guide') {
      return {
        source: 'public_information',
        text: formatStepGuide(
          replyLanguage === 'english'
            ? `Sure, I can guide you for ${info.title}.`
            : replyLanguage === 'tagalog'
              ? `Sige, gagabayan kita para sa ${info.title}.`
              : `Sige, guide kita for ${info.title}.`,
          stepsFromText(info.body, info.requirements),
          replyLanguage,
        ),
      };
    }

    return {
      source: 'public_information',
      text: request.simpleMode
        ? replyLanguage === 'english'
          ? `Simple answer: ${info.body}`
          : `Simpleng sagot: ${info.body}`
        : replyLanguage === 'english'
          ? `${info.body}\n\nBest next stop: ${info.locationName ?? 'Information Desk or front office'}.`
          : replyLanguage === 'tagalog'
            ? `Nahanap ko sa naka-save na impormasyon: ${info.body}\n\nSusunod na puntahan: ${info.locationName ?? 'Information Desk o front office'}.`
            : `Nahanap ko sa saved public info: ${info.body}\n\nBest next stop: ${info.locationName ?? 'Information Desk or front office'}.`,
    };
  }

  return {
    source: 'fallback',
    text: fallbackByIntent(contextName, request.intent, replyLanguage),
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
        categoryScope: buildCategoryScopeInstruction(
          request.categoryId,
          getCategoryName(request.categories, request.categoryId),
        ),
        schoolName: request.schoolName ?? '',
        categoryId: request.categoryId,
        simpleMode: request.simpleMode,
        intent: request.intent,
        replyLanguage: resolveReplyLanguage(request.question, request.languageMode ?? 'auto'),
      }),
    }, aiProxyTimeoutMs, request.signal);

    if (!response.ok) {
      return null;
    }

    throwIfAborted(request.signal);
    const payload = (await response.json()) as {
      answer?: string;
      blocked?: boolean;
      recommendedCategory?: string;
      recommendedCategoryId?: string;
    };
    throwIfAborted(request.signal);

    // Remote proxy may also block — treat as no answer (UI already gated).
    if (payload.blocked) {
      return null;
    }

    return payload.answer ? { text: payload.answer, source: 'ai_proxy' } : null;
  } catch (error) {
    if (request.signal?.aborted && isAbortError(error)) {
      throw error;
    }

    console.warn('AI proxy failed, using local companion reply.', error);
    return null;
  }
}

/**
 * Editor mode: send the matched article's STORED content to the proxy and ask
 * it to reorganize/polish it into a clean, professional answer — WITHOUT adding
 * facts. The server enforces the editor-only rules; here we just supply the
 * source text via `groundedContent`. Returns null on any failure so callers
 * fall back to the deterministic raw rendering (still grounded, never broken).
 */
async function editKnowledgeWithProxy(
  article: KnowledgeArticleLite,
  request: CompanionRequest,
  language: ReplyLanguage,
): Promise<CompanionReply | null> {
  const proxyUrl = env.aiProxyUrl || env.voiceProxyUrl || devAiProxyUrl;
  if (!proxyUrl) {
    return null;
  }

  const cleanProxyUrl = proxyUrl.replace(/\/$/, '');
  const endpoint =
    cleanProxyUrl.endsWith('/chat') || cleanProxyUrl.endsWith('/companion-answer')
      ? cleanProxyUrl
      : `${cleanProxyUrl}/chat`;

  const broad = isBroadOverviewQuestion(request.question);
  // The exact, immutable admin text the editor may reformat but never alter.
  // Broad overviews need the full multi-program context (not a tiny slice).
  const groundedRaw = `${article.title}\n\n${article.content}`.trim();
  const groundedContent = groundedRaw.slice(0, broad ? CONTEXT_BUDGET_BROAD : CONTEXT_BUDGET_SPECIFIC);
  const editorTimeout = broad ? kbEditorTimeoutBroadMs : kbEditorTimeoutMs;

  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appTitle: APP_TITLE,
        question: request.question,
        category: getCategoryName(request.categories, request.categoryId),
        categoryScope: buildCategoryScopeInstruction(
          request.categoryId,
          getCategoryName(request.categories, request.categoryId),
        ),
        schoolName: request.schoolName ?? '',
        categoryId: request.categoryId,
        simpleMode: request.simpleMode,
        intent: request.intent,
        replyLanguage: language,
        // Editor-only grounding: server rewrites ONLY this text, adds nothing.
        mode: 'editor',
        groundedContent,
        broadOverview: broad,
      }),
    }, editorTimeout, request.signal);

    if (!response.ok) {
      return null;
    }

    throwIfAborted(request.signal);
    const payload = (await response.json()) as {
      answer?: string;
      blocked?: boolean;
      groundingMode?: string;
    };
    throwIfAborted(request.signal);

    // An older deployed proxy ignores editor fields and answers from general
    // knowledge. Require an explicit capability marker before trusting output.
    if (
      payload.blocked ||
      !payload.answer?.trim() ||
      payload.groundingMode !== 'editor-v2'
    ) {
      return null;
    }

    // ── GROUNDING VERIFICATION ── Reject any editor output that leaked generic
    // AI knowledge (e.g. "usually", "contact the Alumni Relations Office") not
    // present in the stored source. This guarantees a DB match can never turn
    // into a generic AI answer, even if the model ignores the editor rules.
    const answer = payload.answer.trim();
    if (!isEditorOutputGrounded(answer, groundedContent)) {
      console.warn(
        '[KB] Editor output failed grounding check — rejecting, using raw stored text.',
      );
      return null;
    }

    // One official header + body only — strip "Sure, here is…" style openers.
    const text = formatKnowledgeReply(answer, language);
    // Reject hollow editor output (header with no body).
    if (!hasSubstantiveKnowledgeReply(text, language)) {
      return null;
    }
    return { text, source: 'knowledge_base' };
  } catch (error) {
    if (request.signal?.aborted && isAbortError(error)) {
      throw error;
    }
    console.warn('Knowledge editor proxy failed, using raw stored text.', error);
    return null;
  }
}

/** No-official-info message (KB miss). Refuse to invent + offer general help. */
function knowledgeMissMessage(language: ReplyLanguage): string {
  if (language === 'tagalog') {
    return "Wala akong nakitang opisyal na impormasyon tungkol diyan sa knowledge base ng school. Hindi ko ito hulaan para maiwasan ang maling sagot.\n\nMaaaring i-Approve muna ng Super Admin ang tamang website page o idagdag ang detalye sa School Info. Kung gusto mo, tanungin ulit gamit ang ibang topic na may opisyal na data.";
  }
  if (language === 'taglish') {
    return "Wala akong nakitang official info tungkol dyan sa school knowledge base. Hindi ko i-ha-hallucinate ang sagot para iwas mali.\n\nPwede i-Approve muna ng Super Admin yung tamang website page, or i-add sa School Info. Kung gusto mo, magtanong ulit ng topic na may official data na.";
  }
  return "I couldn't find official information about that topic in this school's knowledge base. I won't guess so I don't give you wrong details.\n\nA Super Admin can Approve the matching website page or add it under School Info. Meanwhile, ask about a topic that has already been imported and approved.";
}

/**
 * School-name / campus noise that appears in almost every website import.
 * Matching only these must NEVER pick a random page (e.g. Logo for a CEO question).
 */
const GENERIC_SCHOOL_TOKENS = new Set([
  'arellano',
  'university',
  'universities',
  'campus',
  'campuses',
  'school',
  'schools',
  'college',
  'colleges',
  'institution',
  'official',
  'page',
  'about',
  'au',
  'jose',
  'rizal',
  'legarda',
  'manila',
  'pasay',
  'pasig',
  'malabon',
  'mandaluyong',
  'student',
  'students',
  'info',
  'information',
  'website',
  'import',
  'basic',
  'education',
  'high',
  'junior',
  'senior',
  'who',
  'whom',
  'whose',
  'tell',
  'know',
  'please',
]);

/** Topic words that define what the user is actually asking about. */
function topicTokens(queryTokens: string[]): string[] {
  return unique(queryTokens).filter((t) => t.length >= 3 && !GENERIC_SCHOOL_TOKENS.has(t));
}

function articleHaystack(article: KnowledgeArticleLite): string {
  return `${article.title}\n${article.content}\n${article.keywords.join(' ')}\n${article.tags.join(' ')}`.toLowerCase();
}

/** Mutually exclusive sibling topics that must not bleed into one another. */
const DISJOINT_TOPIC_GROUPS = [
  ['alumni', 'new student', 'freshman', 'transferee', 'returning student'],
  ['undergraduate', 'graduate school', 'senior high', 'junior high', 'elementary'],
  ['academic scholarship', 'athletic scholarship', 'employee discount', 'sibling discount'],
];

function requestsComparison(question: string): boolean {
  return /\b(compare|comparison|difference|different|versus|vs\.?|both|all discounts|lahat|pareho|pagkakaiba)\b/i.test(
    question,
  );
}

function hasSiblingConflict(query: string, candidateMetadata: string): boolean {
  if (requestsComparison(query)) return false;
  const q = query.toLowerCase();
  const candidate = candidateMetadata.toLowerCase();
  for (const group of DISJOINT_TOPIC_GROUPS) {
    const requested = group.filter((topic) => q.includes(topic));
    if (!requested.length) continue;
    const hasRequested = requested.some((topic) => candidate.includes(topic));
    const hasDifferentSibling = group.some(
      (topic) => !requested.includes(topic) && candidate.includes(topic),
    );
    if (!hasRequested && hasDifferentSibling) return true;
  }
  return false;
}

/**
 * Score how well an article answers the query.
 * Requires topic-token overlap (ceo, logo, tuition…) so "Arellano University"
 * alone cannot return the Logo page for a CEO question.
 */
function scoreArticle(
  queryTokens: string[],
  article: KnowledgeArticleLite,
  rawQuery = queryTokens.join(' '),
): number {
  const uniqueQuery = unique(queryTokens);
  if (!uniqueQuery.length) {
    return 0;
  }
  const topics = topicTokens(uniqueQuery);
  const titleText = article.title.toLowerCase();
  const bodyText = article.content.toLowerCase();
  const haystack = articleHaystack(article);
  const titleWords = new Set(normalize(article.title));
  const keyTokens = new Set(
    [...article.keywords, ...article.tags, article.subcategoryName ?? '']
      .flatMap((k) => normalize(String(k || '')))
      .filter(Boolean),
  );

  const metadata = `${article.title}\n${article.subcategoryName ?? ''}\n${article.keywords.join(' ')}\n${article.tags.join(' ')}`;
  if (hasSiblingConflict(rawQuery, metadata)) {
    return 0;
  }

  // ── HARD GATE: if the user asked about specific topics, the article MUST
  // mention at least one of them. Otherwise score = 0 (do not answer with Logo).
  if (topics.length > 0) {
    const topicHits = topics.filter(
      (t) =>
        titleWords.has(t) ||
        keyTokens.has(t) ||
        titleText.includes(t) ||
        bodyText.includes(t) ||
        haystack.includes(t),
    );
    if (topicHits.length === 0) {
      return 0;
    }
  }

  let score = 0;
  let strongHits = 0;
  let topicStrongHits = 0;

  for (const token of uniqueQuery) {
    const isTopic = topics.includes(token);
    const weightBoost = isTopic ? 1.8 : GENERIC_SCHOOL_TOKENS.has(token) ? 0.35 : 1;
    const distinctive = token.length >= 4;

    if (keyTokens.has(token)) {
      score += (distinctive ? 6 : 3) * weightBoost;
      strongHits += 1;
      if (isTopic) topicStrongHits += 1;
    }
    if (titleWords.has(token)) {
      score += (distinctive ? 10 : 5) * weightBoost;
      strongHits += 1;
      if (isTopic) topicStrongHits += 1;
    } else if (token.length > 3 && titleText.includes(token)) {
      score += (distinctive ? 7 : 3) * weightBoost;
      strongHits += 1;
      if (isTopic) topicStrongHits += 1;
    }
    if (token.length > 3 && bodyText.includes(token)) {
      score += (distinctive ? 2.5 : 0.5) * weightBoost;
      if (isTopic) topicStrongHits += 0.5;
    }
  }

  // Extra boost when topic words land in the title (logo query → Logo page).
  for (const t of topics) {
    if (titleWords.has(t) || titleText.includes(t)) {
      score += 12;
      topicStrongHits += 1;
    }
  }

  // Multi-topic title agreement only counts topic tokens (not "arellano"+"university").
  const topicTitleHits = topics.filter(
    (t) => titleWords.has(t) || titleText.includes(t),
  ).length;
  if (topicTitleHits >= 2) {
    score += 6;
  }

  if (strongHits === 0) {
    score *= 0.2;
  }

  // Prefer articles that actually cover the topic in title/keywords, not only body.
  if (topics.length > 0 && topicStrongHits < 1) {
    score *= 0.4;
  }

  return score + Math.min(1.0, Math.max(0, article.priority) * 0.03);
}

/**
 * Convert a school-scoped public_information row into the article shape the
 * grounding gate consumes. Requirements and location are folded into the
 * content so the admin's stored facts (and their formatting) are preserved and
 * the AI can never invent replacements. Type/tags/title feed keyword matching.
 */
function schoolInfoToArticle(info: PublicInfo): KnowledgeArticleLite {
  const parts: string[] = [];
  if (info.body.trim()) {
    parts.push(info.body.trim());
  }
  if (info.requirements?.length) {
    parts.push(
      ['Requirements:', ...info.requirements.map((item) => `• ${item}`)].join('\n'),
    );
  }
  if (info.locationName?.trim()) {
    parts.push(`Location: ${info.locationName.trim()}`);
  }
  return {
    id: info.id,
    categoryId: info.categoryId,
    title: info.title,
    content: parts.join('\n\n'),
    keywords: [...info.tags, ...(info.requirements ?? []), info.type],
    tags: info.tags,
    priority: 100,
  };
}

/**
 * Convert an admin FAQ into the article shape the grounding gate consumes so
 * FAQ answers stay available under the same "answer only from stored content"
 * rule. The stored answer becomes the content; the question feeds matching.
 */
function faqToArticle(faq: FAQ): KnowledgeArticleLite {
  return {
    id: faq.id,
    categoryId: faq.categoryId,
    title: faq.question,
    content: faq.answer,
    keywords: [...faq.tags],
    tags: faq.tags,
    priority: 100,
  };
}

/**
 * Assemble every admin-authored knowledge entry that applies to this request:
 * KB articles for the category PLUS, when the user is in School mode, the
 * school-scoped public_information and active school FAQs. Non-empty means the
 * category is admin-managed and the engine must answer ONLY from these — never
 * from the LLM.
 */
function collectGroundingArticles(request: CompanionRequest): KnowledgeArticleLite[] {
  const expectedKbCategory =
    request.categoryId === 'general_chat' ? 'kb-general' : `kb-${request.categoryId}`;
  const kbArticles = (request.knowledgeArticles ?? []).filter(
    (article) =>
      article.categoryId === request.categoryId || article.categoryId === expectedKbCategory,
  );
  if (request.categoryId !== SCHOOL_CATEGORY_ID) {
    return [...kbArticles];
  }
  const schoolArticles = request.publicInfo
    .filter((info) => info.categoryId === SCHOOL_CATEGORY_ID)
    .map(schoolInfoToArticle);
  const faqArticles = request.faqs
    .filter((faq) => faq.categoryId === SCHOOL_CATEGORY_ID && faq.isActive)
    .map(faqToArticle);
  const uniqueArticles = new Map<string, KnowledgeArticleLite>();
  for (const article of [...kbArticles, ...schoolArticles, ...faqArticles]) {
    uniqueArticles.set(article.id, article);
  }
  return [...uniqueArticles.values()];
}

/** Localized header that marks the answer as sourced from official school info. */
function groundingHeader(language: ReplyLanguage): string {
  return language === 'tagalog'
    ? 'Base sa opisyal na impormasyon ng school:'
    : language === 'taglish'
      ? 'Base sa official info ng school:'
      : "According to the school's official information:";
}

/** Known official-context headers (EN / TL) the model may emit. */
const OFFICIAL_CONTEXT_HEADERS = [
  /^according to the school'?s official information:\s*/i,
  /^according to the available information:\s*/i,
  /^according to the stored knowledge:\s*/i,
  /^based on the official records:\s*/i,
  /^based on the stored knowledge:\s*/i,
  /^based on the school'?s official information:\s*/i,
  /^base sa opisyal na impormasyon ng school:\s*/i,
  /^base sa official info ng school:\s*/i,
];

/**
 * Remove ChatGPT-style conversational openers so the answer reads like
 * documentation under a single official-info header.
 */
export function stripConversationalLeadIn(text: string): string {
  let body = String(text || '').trim();
  if (!body) return '';

  // Drop any duplicate official headers the model may have prepended.
  let strippedHeader = true;
  while (strippedHeader) {
    strippedHeader = false;
    for (const re of OFFICIAL_CONTEXT_HEADERS) {
      if (re.test(body)) {
        body = body.replace(re, '').trim();
        strippedHeader = true;
      }
    }
  }

  // Remove leading filler paragraphs / first sentence openers.
  const fillerLine =
    /^(sure|certainly|of course|absolutely|okay|ok|alright|yes)[,!.]?\s+/i;
  const fillerPhrases = [
    /^(sure|certainly|of course|absolutely)[,!.]?\s+(here('s| is)|i can|let me)\b[^\n]*/i,
    /^here('s| is)\s+(an?\s+)?(overview|summary|list|information|details?)\b[^\n]*/i,
    /^i can help\b[^\n]*/i,
    /^let me (help|explain|share|provide)\b[^\n]*/i,
    /^i('ll| will) (help|explain|share|provide)\b[^\n]*/i,
    /^(below is|the following is)\s+(an?\s+)?(overview|summary|list)\b[^\n]*/i,
    /^sige[,!.]?\s+(ito|here|heto)\b[^\n]*/i,
    /^oo[,!.]?\s+(ito|here)\b[^\n]*/i,
  ];

  // Strip up to 2 leading filler lines/paragraphs.
  for (let pass = 0; pass < 2; pass++) {
    const before = body;
    // First paragraph only
    const parts = body.split(/\n\s*\n/);
    const first = (parts[0] || '').trim();
    let dropFirst = false;
    if (fillerLine.test(first) || fillerPhrases.some((re) => re.test(first))) {
      dropFirst = true;
    } else if (
      first.length < 140 &&
      /^(sure|certainly|of course|here('s| is)|i can)\b/i.test(first) &&
      /overview|summary|programs?|scholarships?|help/i.test(first)
    ) {
      dropFirst = true;
    }
    if (dropFirst && parts.length > 1) {
      body = parts.slice(1).join('\n\n').trim();
    } else if (dropFirst && parts.length === 1) {
      // Single paragraph: try cutting the first sentence only
      const cut = first.replace(
        /^(sure|certainly|of course|absolutely)[,!.]?\s+[^.!?\n]+[.!?]\s*/i,
        '',
      );
      const cut2 = cut.replace(
        /^here('s| is)\s+(an?\s+)?(overview|summary|list)[^.!?\n]*[.!?]\s*/i,
        '',
      );
      body = (cut2 || cut).trim();
    }
    // Also strip a single leading filler line before the rest of a multi-line block
    body = body
      .replace(
        /^(sure|certainly|of course|absolutely)[,!.]?\s+(here('s| is)|i can|let me)[^\n]*\n+/i,
        '',
      )
      .replace(/^here('s| is)\s+(an?\s+)?(overview|summary|list)[^\n]*\n+/i, '')
      .trim();
    if (body === before) break;
  }

  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One professional header + clean body. Never double-intro.
 */
export function formatKnowledgeReply(answerBody: string, language: ReplyLanguage): string {
  const header = groundingHeader(language);
  let body = stripConversationalLeadIn(answerBody);
  // If strip left nothing useful, keep original minus header only
  if (body.length < 20) {
    body = String(answerBody || '')
      .replace(new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
      .trim();
    body = stripConversationalLeadIn(body);
  }
  if (!body) return header;
  return `${header}\n\n${body}`;
}

/**
 * For broad overviews, reject editor output that kept only a fraction of the
 * distinct program/section headings present in the grounded context.
 */
function isBroadReplyCompleteEnough(replyText: string, sourceContext: string): boolean {
  const sourceHeadings = extractProgramLikeHeadings(sourceContext);
  if (sourceHeadings.length < 3) {
    // Few headings — length heuristic: reply should not be tiny vs source
    return replyText.length >= Math.min(900, Math.floor(sourceContext.length * 0.18));
  }
  const replyLower = replyText.toLowerCase();
  let covered = 0;
  for (const h of sourceHeadings) {
    // Match by distinctive tokens from the heading (not full string required)
    const tokens = h
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4)
      .slice(0, 4);
    if (!tokens.length) continue;
    const hits = tokens.filter((t) => replyLower.includes(t)).length;
    if (hits >= Math.min(2, tokens.length)) covered += 1;
  }
  // At least ~70% of distinct program headings should appear in the answer
  return covered >= Math.ceil(sourceHeadings.length * 0.7);
}

function extractProgramLikeHeadings(text: string): string[] {
  const lines = String(text || '').split(/\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t.length < 8 || t.length > 120) continue;
    const isHeading =
      (/scholarship|discount|program|admission|entrance|academic achievement|honor/i.test(t) &&
        !/[.!?]$/.test(t)) ||
      (t === t.toUpperCase() && /[A-Z]/.test(t) && t.split(/\s+/).length <= 16);
    if (!isHeading) continue;
    const key = t.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * True when the reply has real content beyond the official-info header.
 * Prevents blank bubbles that only say "According to the school's official information:".
 */
function hasSubstantiveKnowledgeReply(text: string, language: ReplyLanguage): boolean {
  const header = groundingHeader(language);
  let body = String(text || '').trim();
  if (body.startsWith(header)) {
    body = body.slice(header.length).trim();
  }
  // Also strip common header variants the model may emit.
  body = body
    .replace(/^according to the school'?s official information:\s*/i, '')
    .replace(/^base sa (opisyal na impormasyon|official info) ng school:\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Need a real sentence / list — not empty, not just a colon remnant.
  const words = body.split(/\s+/).filter((w) => w.length > 1);
  return body.length >= 28 && words.length >= 5;
}

/** The single best-matching admin article with its score, or null when nothing clears the bar. */
export function selectBestKnowledgeArticle(
  articles: KnowledgeArticleLite[],
  question: string,
): { article: KnowledgeArticleLite; score: number } | null {
  if (!articles.length) {
    return null;
  }
  const queryTokens = normalize(question);
  if (!queryTokens.length) {
    return null;
  }
  const topics = topicTokens(queryTokens);
  const broad = isBroadOverviewQuestion(question);
  const ranked = articles
    .map((article) => ({
      article,
      score: scoreArticle(queryTokens, article, question),
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  // Require a real match; below threshold we treat it as "no official info".
  if (!best || best.score < KB_MATCH_THRESHOLD) {
    return null;
  }

  // Sibling documents remain isolated by default. Only an explicit comparison
  // may combine them, and then only the specifically named siblings are used.
  if (requestsComparison(question)) {
    const q = question.toLowerCase();
    const namedTopics = DISJOINT_TOPIC_GROUPS.flatMap((group) =>
      group.filter((topic) => q.includes(topic)),
    );
    if (namedTopics.length >= 2) {
      const selected = new Map<string, KnowledgeArticleLite>();
      for (const topic of namedTopics) {
        const hit = ranked.find(({ article, score }) => {
          if (score < KB_MATCH_THRESHOLD) return false;
          const metadata = `${article.title}\n${article.subcategoryName ?? ''}\n${article.keywords.join(' ')}\n${article.tags.join(' ')}`.toLowerCase();
          return metadata.includes(topic);
        });
        if (hit) selected.set(hit.article.id, hit.article);
      }
      if (selected.size >= 2) {
        const chosen = [...selected.values()];
        return {
          article: {
            id: chosen.map((article) => article.id).join('+'),
            categoryId: chosen[0].categoryId,
            title: chosen.map((article) => article.title).join(' vs. '),
            content: chosen
              .map((article) => `## ${article.title}\n\n${article.content}`)
              .join('\n\n'),
            keywords: unique(chosen.flatMap((article) => article.keywords)),
            tags: unique(chosen.flatMap((article) => article.tags)),
            priority: Math.max(...chosen.map((article) => article.priority)),
          },
          score: best.score,
        };
      }
    }
  }

  // Broad overview: merge multiple high-scoring articles that share the same
  // topic family (e.g. several scholarship pages) so nothing is dropped.
  if (broad && ranked.length > 1) {
    const minScore = Math.max(KB_MATCH_THRESHOLD, best.score * 0.45);
    const related = ranked.filter((row) => {
      if (row.score < minScore) return false;
      const hay = articleHaystack(row.article);
      // Share at least one topic token, or match the overview family keywords
      const sharesTopic =
        topics.length === 0 ||
        topics.some((t) => hay.includes(t)) ||
        OVERVIEW_TOPIC_RE.test(hay);
      return sharesTopic;
    });
    if (related.length >= 2) {
      // Cap merge size for safety
      const chosen = related.slice(0, 8).map((r) => r.article);
      logKbRetrievalDetail({
        phase: 'multi-article-merge',
        query: question,
        articleIds: chosen.map((a) => a.id),
        titles: chosen.map((a) => a.title),
        scores: related.slice(0, 8).map((r) => Number(r.score.toFixed(2))),
      });
      return {
        article: {
          id: chosen.map((article) => article.id).join('+'),
          categoryId: chosen[0].categoryId,
          title: chosen[0].title,
          content: chosen
            .map((article) => `## ${article.title}\n\n${article.content}`)
            .join('\n\n'),
          keywords: unique(chosen.flatMap((article) => article.keywords)),
          tags: unique(chosen.flatMap((article) => article.tags)),
          priority: Math.max(...chosen.map((article) => article.priority)),
          sourceType: chosen.some((a) => a.sourceType === 'website') ? 'website' : chosen[0].sourceType,
        },
        score: best.score,
      };
    }
  }

  // Final safety: with topic words present, refuse if the winner does not
  // actually contain any of them (should already be score 0, but double-check).
  if (topics.length > 0) {
    const hay = articleHaystack(best.article);
    const coversTopic = topics.some((t) => hay.includes(t));
    if (!coversTopic) {
      return null;
    }
  }

  // If two articles are almost tied, prefer the one whose TITLE covers more topic tokens.
  const second = ranked[1];
  if (second && best.score - second.score < 2.5) {
    const topicTitleHits = (article: KnowledgeArticleLite) => {
      const title = article.title.toLowerCase();
      const titleWords = new Set(normalize(article.title));
      return topics.filter((t) => titleWords.has(t) || title.includes(t)).length;
    };
    const bestTitle = topicTitleHits(best.article);
    const secondTitle = topicTitleHits(second.article);
    if (secondTitle > bestTitle && second.score >= KB_MATCH_THRESHOLD) {
      return second;
    }
  }
  return best;
}

/**
 * Phrases that signal the model answered from its OWN general knowledge instead
 * of the stored source. If any appears in the editor output but NOT in the
 * source text, the output is contaminated and must be rejected in favor of the
 * deterministic stored rendering. This is the last line of defense that keeps
 * a DB-matched answer from ever becoming a generic AI answer.
 */
const GENERIC_KNOWLEDGE_MARKERS = [
  'usually',
  'normally',
  'typically',
  'generally',
  'most schools',
  'most universities',
  'in general',
  'as a rule',
  'karaniwang',
  'kadalasan',
  'sa pangkalahatan',
  'madalas',
];

const SENSITIVE_GROUNDING_TERMS = [
  'registrar',
  'admissions office',
  'alumni relations',
  'student affairs',
  'guidance office',
  'accounting office',
  'cashier',
  'dean',
  'osa',
];

/**
 * Verify the editor output is grounded in the source. Two checks:
 *   1. No generic-knowledge marker ("usually", etc.) that isn't in the source.
 *   2. For longer sources, the output must substantially reuse the source's
 *      distinctive words. Short admin notes (< 15 distinctive tokens) skip the
 *      overlap check — a correct Tagalog/Taglish rewrite of a 5-word English
 *      note shares almost no tokens, but is still grounded.
 * Returns true only when the output is safe to use.
 */
function isEditorOutputGrounded(editorText: string, sourceText: string): boolean {
  const out = editorText.toLowerCase();
  const source = sourceText.toLowerCase();

  for (const marker of GENERIC_KNOWLEDGE_MARKERS) {
    if (out.includes(marker) && !source.includes(marker)) {
      return false;
    }
  }

  // Office names are high-impact instructions. Reject any that the editor
  // introduced rather than copied from the approved source.
  for (const term of SENSITIVE_GROUNDING_TERMS) {
    if (out.includes(term) && !source.includes(term)) return false;
  }

  // Numbers, percentages, dates, amounts, emails, and URLs must be source-backed.
  const factualTokens = out.match(/(?:https?:\/\/\S+|[\w.+-]+@[\w.-]+\.\w+|₱?\d[\d,.]*(?:%|\b))/gi) ?? [];
  for (const token of factualTokens) {
    const normalizedToken = token.toLowerCase().replace(/[),.;]+$/, '');
    if (!source.includes(normalizedToken)) return false;
  }

  // Distinctive source words (length > 3, excludes stop words and header filler).
  const sourceWords = Array.from(
    new Set(
      source
        .replace(/[^\p{L}\p{N}\s%]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stopWords.has(w)),
    ),
  );

  // Short admin notes have too few distinctive tokens to make overlap meaningful.
  // A correct Tagalog rewrite of "alumni 20% off go to osa" shares almost none
  // of the English source words — that's expected, not hallucination.
  const outWords = new Set(
    out
      .replace(/[^\p{L}\p{N}\s%]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
  let hits = 0;
  for (const word of sourceWords) {
    if (outWords.has(word)) {
      hits += 1;
    }
  }
  if (sourceWords.length === 0) return true;
  if (sourceWords.length < 15) {
    return hits >= 1;
  }
  // Require a meaningful share of distinctive source words to survive into the
  // rewrite. Kept moderate so natural translation (which preserves proper nouns,
  // office names, form names, acronyms, and numbers) still passes, while a
  // hallucinated general answer — which shares almost none of them — is caught.
  return hits / sourceWords.length >= 0.35;
}

/**
 * Deterministic, LLM-free rendering of a stored article. Used as the fallback
 * when the editor proxy is unavailable or its output fails grounding. Grounded
 * and safe: it only reformats the admin's exact text, never adds facts.
 */
/** Clean stored article text for professional chat display (no raw markdown noise). */
function formatArticleBodyForChat(content: string, simpleMode: boolean): string {
  let body = String(content || '')
    .replace(/^Page:\s*.+$/gim, '')
    .replace(/^URL:\s*.+$/gim, '')
    .replace(/^Sections on this page:\s*.+$/gim, '')
    .replace(/^Note:\s*.+$/gim, '')
    .replace(/^#{1,4}\s+/gm, '') // headings → plain section titles (UI enlarges them)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*{2,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (simpleMode) {
    body = body.split(/\n\s*\n/)[0]?.trim() || body;
  }
  return body;
}

function isWebsiteOrLongArticle(article: KnowledgeArticleLite): boolean {
  const tags = (article.tags || []).map((t) => t.toLowerCase());
  if (tags.some((t) => t.includes('website') || t.includes('import'))) {
    return true;
  }
  const content = article.content || '';
  if (/^URL:\s/m.test(content) || /^Page:\s/m.test(content)) {
    return true;
  }
  return content.length >= LONG_ARTICLE_CHARS;
}

/**
 * True when a section is just sidebar/nav junk (short link labels), not real prose.
 * Example junk from AU logo page under "About":
 *   - Arellano University Logo
 *   - Philosophy
 */
function isNavJunkSection(title: string, bodyText: string): boolean {
  const body = bodyText.trim();
  if (!body) {
    return true;
  }
  // Pure bullet list of short labels → menu, not knowledge.
  const lines = body
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s+/, '').trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return true;
  }
  const shortLabelLines = lines.filter((l) => l.length < 48 && !/[.!?]/.test(l));
  const mostlyLabels = shortLabelLines.length / lines.length >= 0.75;
  const noRealSentence = !/[a-z]{4,}.*[.!?]/i.test(body) && body.length < 500;
  if (mostlyLabels && (noRealSentence || body.length < 350)) {
    return true;
  }
  // Generic "About" menus that only list page names
  if (/^about$/i.test(title.trim()) && mostlyLabels) {
    return true;
  }
  return false;
}

/**
 * Pick sections most relevant to the question.
 * Prefers DESIGN / MEANING prose over nav menus that also contain the word "logo".
 * Broad overview questions keep all related program sections (not top-N only).
 */
function focusContentOnQuestion(content: string, question: string, simpleMode: boolean): string {
  // Keep markdown headings for reliable splits, strip chrome headers only.
  let raw = String(content || '')
    .replace(/^Page:\s*.+$/gim, '')
    .replace(/^URL:\s*.+$/gim, '')
    .replace(/^Sections on this page:\s*.+$/gim, '')
    .replace(/^Note:\s*.+$/gim, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*{2,}/g, '')
    .trim();

  if (!raw) {
    return '';
  }

  const broad = isBroadOverviewQuestion(question);
  const budget = broad ? CONTEXT_BUDGET_BROAD : CONTEXT_BUDGET_SPECIFIC;
  const queryTokens = topicTokens(normalize(question));
  const q = question.toLowerCase();
  const isLogoQuery = /\blogo\b|\bseal\b|\bemblem\b/.test(q);

  type Section = { title: string; body: string; level: number; index: number };
  const sections: Section[] = [];

  // Split on markdown headings first (### DESIGN, # About, etc.)
  const headingSplit = raw.split(/(?=^#{1,4}\s+.+$)/m);
  let sectionIndex = 0;
  for (const chunk of headingSplit) {
    const m = chunk.match(/^(#{1,4})\s+(.+?)\s*\n([\s\S]*)$/);
    if (m) {
      sections.push({
        level: m[1].length,
        title: m[2].trim(),
        body: m[3].trim(),
        index: sectionIndex++,
      });
    } else if (chunk.trim()) {
      sections.push({ level: 0, title: '', body: chunk.trim(), index: sectionIndex++ });
    }
  }

  // Also split ALL-CAPS / title-case program headings without markdown (common in crawls)
  if (sections.length <= 1) {
    const alt = splitByPlainHeadings(raw);
    if (alt.length > sections.length) {
      sections.length = 0;
      alt.forEach((s, i) => sections.push({ ...s, level: s.title ? 2 : 0, index: i }));
    }
  }

  // Fallback: no headings — use full cleaned body (do not hard-slice broad answers)
  if (sections.length === 0) {
    const full = formatArticleBodyForChat(content, false);
    return full.length > budget ? `${full.slice(0, budget).trim()}…` : full;
  }

  const scored = sections
    .map((sec) => {
      const title = sec.title;
      const body = sec.body;
      if (isNavJunkSection(title, body)) {
        return { sec, score: -100 };
      }

      const titleL = title.toLowerCase();
      const bodyL = body.toLowerCase();
      const blob = `${titleL}\n${bodyL}`;
      let score = 0;

      for (const t of queryTokens) {
        if (titleL.includes(t)) score += 10;
        if (bodyL.includes(t)) score += 2;
      }

      // Program-family headings should stay in broad overviews
      if (OVERVIEW_TOPIC_RE.test(titleL) || OVERVIEW_TOPIC_RE.test(bodyL.slice(0, 400))) {
        score += broad ? 14 : 4;
      }
      // Named grant / honor tier blocks
      if (
        /\b(scholarship|discount|honor|gwa|tuition|eligibility|requirement)\b/i.test(titleL) ||
        /\b\d{1,3}\s*%\b/.test(body)
      ) {
        score += broad ? 8 : 2;
      }

      const sentenceCount = (body.match(/[.!?]["']?\s/g) || []).length;
      if (sentenceCount >= 1) score += 4;
      if (sentenceCount >= 3) score += 4;
      if (body.length > 200) score += 5;
      if (body.length > 600) score += 4;

      if (/^(design|meaning|history|seal|symbolism)$/i.test(title.trim())) {
        score += isLogoQuery ? 25 : 6;
      }
      if (/logo|seal|manansala|surabachi|promontory|three stars|filipino flag/i.test(blob)) {
        score += isLogoQuery ? 8 : 2;
      }

      if (/^(about|menu|navigation|links)$/i.test(title.trim())) {
        score -= 15;
      }

      // Disclaimer / notes — keep for overviews
      if (/\b(subject to change|without prior notice|important|disclaimer|note)\b/i.test(blob)) {
        score += broad ? 6 : 1;
      }

      return { sec, score };
    })
    .filter((s) => s.score > -50);

  scored.sort((a, b) => b.score - a.score);

  let chosen = scored.filter((s) => s.score > 0);
  if (isLogoQuery) {
    const designMeaning = scored.filter((s) =>
      /^(design|meaning)$/i.test(s.sec.title.trim()),
    );
    if (designMeaning.length) {
      chosen = designMeaning;
      const logoIntro = scored.find(
        (s) =>
          /logo/i.test(s.sec.title) &&
          s.sec.body.length > 80 &&
          !isNavJunkSection(s.sec.title, s.sec.body),
      );
      if (logoIntro && !chosen.includes(logoIntro)) {
        chosen = [logoIntro, ...chosen];
      }
    }
  } else if (broad) {
    // Keep every positive section (all programs), cap only at safety max
    chosen = chosen.slice(0, MAX_CHUNKS_BROAD);
    // If topic word appears in the page, also keep zero-score siblings that
    // look like distinct program blocks under the same family.
    if (OVERVIEW_TOPIC_RE.test(q) || OVERVIEW_TOPIC_RE.test(raw.slice(0, 500))) {
      const extras = scored.filter(
        (s) =>
          s.score >= 0 &&
          !chosen.includes(s) &&
          (OVERVIEW_TOPIC_RE.test(s.sec.title) ||
            /\b(gwa|tuition|honor|eligibility|requirement|% )\b/i.test(s.sec.body)),
      );
      chosen = [...chosen, ...extras].slice(0, MAX_CHUNKS_BROAD);
    }
  } else {
    // Specific: top sections + neighbors by original document order
    const top = chosen.slice(0, simpleMode ? 3 : MAX_CHUNKS_SPECIFIC);
    const indexSet = new Set<number>();
    for (const row of top) {
      for (
        let i = Math.max(0, row.sec.index - NEIGHBOR_EXPAND);
        i <= row.sec.index + NEIGHBOR_EXPAND;
        i++
      ) {
        indexSet.add(i);
      }
    }
    chosen = scored
      .filter((s) => indexSet.has(s.sec.index) && s.score >= 0)
      .slice(0, MAX_CHUNKS_SPECIFIC + NEIGHBOR_EXPAND * 2);
  }

  if (!chosen.length) {
    chosen = scored
      .filter((s) => s.sec.body.length > 80)
      .sort((a, b) => b.sec.body.length - a.sec.body.length)
      .slice(0, broad ? 8 : 2);
  }

  // Preserve original document order so program lists stay coherent
  chosen.sort((a, b) => a.sec.index - b.sec.index);

  const parts: string[] = [];
  for (const { sec } of chosen) {
    const title = sec.title.replace(/^#+\s*/, '').trim();
    if (title && !/^arellano university logo$/i.test(title)) {
      parts.push(title);
    } else if (title && chosen.length === 1) {
      parts.push(title);
    }
    const body = sec.body
      .replace(/^#{1,4}\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body) {
      parts.push(body);
    }
  }

  let out = parts.join('\n\n').trim();
  // simpleMode no longer drops whole programs — only slightly prefer shorter phrasing later via AI
  if (out.length > budget) {
    out = softTrimAtSectionBoundary(out, budget);
  }

  if (!out || out.length < 80) {
    const full = formatArticleBodyForChat(content, false);
    const kept = full
      .split('\n')
      .filter((line) => {
        const t = line.replace(/^[-•*]\s+/, '').trim();
        if (!t) return true;
        if (t.length < 40 && !/[.!?]/.test(t) && !/\d/.test(t)) {
          return /^(design|meaning|history|requirements|goals|scholarship|discount)/i.test(t);
        }
        return true;
      })
      .join('\n');
    out = kept.length > budget ? softTrimAtSectionBoundary(kept, budget) : kept.trim();
  }

  return out;
}

/** Split plain-text crawled pages on ALL-CAPS or short Title-Case headings. */
function splitByPlainHeadings(
  raw: string,
): Array<{ title: string; body: string }> {
  const lines = raw.split(/\n/);
  const sections: Array<{ title: string; body: string }> = [];
  let title = '';
  let bodyLines: string[] = [];
  const flush = () => {
    const body = bodyLines.join('\n').trim();
    if (!title && !body) return;
    sections.push({ title, body });
    title = '';
    bodyLines = [];
  };
  for (const line of lines) {
    const t = line.trim();
    const isCapsHeading =
      t.length >= 8 &&
      t.length <= 120 &&
      t === t.toUpperCase() &&
      /[A-Z]/.test(t) &&
      !/^\d+[\).]/.test(t) &&
      t.split(/\s+/).length <= 16;
    const isTitleHeading =
      t.length >= 10 &&
      t.length <= 100 &&
      !/[.!?]$/.test(t) &&
      /^(Junior|College|Academic|Elementary|Senior|F\.|E\.|[A-Z][a-z]+).{0,80}(Scholarship|Discount|Program|Admission)/i.test(
        t,
      );
    if (isCapsHeading || isTitleHeading) {
      flush();
      title = t;
    } else {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

/** Prefer cutting at a blank line so we don't mid-sentence truncate a program. */
function softTrimAtSectionBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const slice = text.slice(0, budget);
  const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
  if (lastBreak > budget * 0.55) {
    return `${slice.slice(0, lastBreak).trim()}\n\n…`;
  }
  return `${slice.trim()}…`;
}

type KnowledgeChunk = {
  index: number;
  heading: string;
  text: string;
  score: number;
};

/**
 * Hybrid retrieval over one approved article:
 * - keyword / heading / full-text scoring
 * - broad questions: all related program sections (dynamic limit)
 * - specific questions: top hits + neighboring related chunks
 * - preserve original order; exact-duplicate only
 */
export function selectRelevantKnowledgeContext(
  article: KnowledgeArticleLite,
  question: string,
  simpleMode: boolean,
): string {
  const cleaned = String(article.content || '')
    .replace(/^Page:\s*.+$/gim, '')
    .replace(/^URL:\s*.+$/gim, '')
    .replace(/^Sections on this page:\s*.+$/gim, '')
    .replace(/^Note:\s*.+$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const broad = isBroadOverviewQuestion(question);
  const budget = broad ? CONTEXT_BUDGET_BROAD : CONTEXT_BUDGET_SPECIFIC;
  // Short notes: return whole text
  if (cleaned.length <= 1100) return cleaned;

  // Broad + page is clearly about the overview topic → prefer full structured extract
  const titleBlob = `${article.title}\n${article.keywords.join(' ')}\n${article.tags.join(' ')}`.toLowerCase();
  const queryTokens = topicTokens(normalize(question));
  const qLower = question.toLowerCase();

  const chunks: KnowledgeChunk[] = [];
  let heading = '';
  let buffer = '';
  let index = 0;
  const flush = () => {
    const text = buffer.trim();
    if (!text) return;
    const headingLower = heading.toLowerCase();
    const bodyLower = text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (headingLower.includes(token)) score += 12;
      if (bodyLower.includes(token)) score += 2;
    }
    // Family-topic pages: every program block is relevant for broad asks
    if (OVERVIEW_TOPIC_RE.test(headingLower) || OVERVIEW_TOPIC_RE.test(bodyLower.slice(0, 500))) {
      score += broad ? 16 : 3;
    }
    if (/\b\d{1,3}\s*%\b/.test(text) || /\bgwa\b/i.test(text)) {
      score += broad ? 6 : 2;
    }
    if (/\b(subject to change|without prior notice|disclaimer)\b/i.test(bodyLower)) {
      score += broad ? 8 : 1;
    }
    if (hasSiblingConflict(question, heading || text.slice(0, 200))) score = -100;
    if (/[.!?](?:\s|$)/.test(text)) score += 2;
    // Named program specificity boost
    if (!broad && isNamedProgramQuestion(question)) {
      const namedBits = normalize(question).filter((t) => t.length >= 4);
      for (const bit of namedBits) {
        if (headingLower.includes(bit)) score += 18;
        if (bodyLower.includes(bit)) score += 4;
      }
    }
    chunks.push({ index, heading, text, score });
    index += 1;
    buffer = '';
  };

  for (const block of cleaned.split(/\n\s*\n/)) {
    let trimmed = block.trim();
    if (!trimmed) continue;
    const headingMatch = trimmed.match(/^#{1,4}\s+([^\n]+)(?:\n([\s\S]*))?$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
      trimmed = (headingMatch[2] ?? '').trim();
      if (!trimmed) continue;
    } else if (
      // Plain CAPS program title as its own paragraph
      trimmed.length >= 8 &&
      trimmed.length <= 120 &&
      trimmed === trimmed.toUpperCase() &&
      /[A-Z]/.test(trimmed) &&
      trimmed.split(/\s+/).length <= 16 &&
      !/[.!?]$/.test(trimmed)
    ) {
      flush();
      heading = trimmed;
      continue;
    } else if (
      /^(Junior|College|Academic|Elementary|Senior|F\.|E\.).{0,90}(Scholarship|Discount)/i.test(
        trimmed.split('\n')[0] || '',
      ) &&
      (trimmed.split('\n')[0] || '').length <= 120
    ) {
      flush();
      const first = trimmed.split('\n')[0].trim();
      heading = first;
      trimmed = trimmed.split('\n').slice(1).join('\n').trim();
      if (!trimmed) continue;
    }
    // Larger chunk size so requirements stay with the program title
    if (buffer && buffer.length + trimmed.length > (broad ? 1400 : 1000)) flush();
    buffer = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
  }
  flush();

  if (!chunks.length) {
    return focusContentOnQuestion(cleaned, question, simpleMode);
  }

  const ranked = chunks
    .filter((chunk) => chunk.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const positive = ranked.filter((chunk) => chunk.score > 0);

  let selected: KnowledgeChunk[];
  if (broad) {
    // All positive + topic-family siblings; never stop at top-2/3
    const base = positive.length ? positive : ranked;
    const max = simpleMode ? Math.min(16, MAX_CHUNKS_BROAD) : MAX_CHUNKS_BROAD;
    const indexSet = new Set(base.map((c) => c.index));
    // Expand neighbors so requirements under a heading are not dropped
    for (const c of base) {
      for (let i = Math.max(0, c.index - 1); i <= c.index + 1; i++) indexSet.add(i);
    }
    selected = chunks.filter((c) => indexSet.has(c.index) && c.score >= 0).slice(0, max);

    // If page title/tags indicate the family topic, keep nearly everything non-junk
    if (
      OVERVIEW_TOPIC_RE.test(titleBlob) ||
      OVERVIEW_TOPIC_RE.test(qLower) ||
      queryTokens.some((t) => OVERVIEW_TOPIC_RE.test(t))
    ) {
      const family = chunks.filter((c) => c.score >= 0);
      if (family.length > selected.length) {
        selected = family.slice(0, max);
      }
    }
  } else {
    const topN = simpleMode ? 3 : MAX_CHUNKS_SPECIFIC;
    const top = (positive.length ? positive : ranked).slice(0, topN);
    const indexSet = new Set<number>();
    for (const c of top) {
      for (let i = Math.max(0, c.index - NEIGHBOR_EXPAND); i <= c.index + NEIGHBOR_EXPAND; i++) {
        indexSet.add(i);
      }
    }
    selected = chunks.filter((c) => indexSet.has(c.index) && c.score >= 0);
  }

  selected.sort((left, right) => left.index - right.index);

  const seen = new Set<string>();
  const parts: string[] = [];
  const selectedMeta: Array<{ index: number; heading: string; score: number; chars: number }> = [];
  for (const chunk of selected) {
    // Include heading so two programs with similar benefit tables are NOT treated as duplicates.
    const fingerprint = `${chunk.heading}\n${chunk.text}`
      .toLowerCase()
      .replace(/\W+/g, ' ')
      .trim()
      .slice(0, 240);
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    if (chunk.heading) parts.push(chunk.heading);
    parts.push(chunk.text);
    selectedMeta.push({
      index: chunk.index,
      heading: chunk.heading || '(body)',
      score: chunk.score,
      chars: chunk.text.length,
    });
  }

  let result = parts.join('\n\n').trim();
  if (!result) {
    result = focusContentOnQuestion(cleaned, question, simpleMode);
  } else if (result.length > budget) {
    result = softTrimAtSectionBoundary(result, budget);
  }

  logKbRetrievalDetail({
    query: question,
    articleId: article.id,
    articleTitle: article.title,
    broad,
    totalChunks: chunks.length,
    selectedCount: selectedMeta.length,
    selected: selectedMeta,
    contextChars: result.length,
    budget,
  });

  return result;
}

function buildRawKnowledgeReply(
  article: KnowledgeArticleLite,
  request: CompanionRequest,
  language: ReplyLanguage,
): CompanionReply {
  // Content is already retrieval-focused by selectRelevantKnowledgeContext.
  // Only light cleanup — do NOT re-run aggressive top-N section slicing.
  const body = formatArticleBodyForChat(article.content, false);
  const title = String(article.title || '')
    .replace(/\*\*/g, '')
    .replace(/^AU\s*\|\s*/i, '')
    .replace(/^About\s*[-–:]\s*/i, '')
    .trim();

  const contentParts: string[] = [];
  if (title) {
    contentParts.push(title);
  }
  if (body) {
    contentParts.push(body);
  }

  return {
    source: 'knowledge_base',
    text: formatKnowledgeReply(contentParts.join('\n\n'), language),
  };
}

/**
 * Structured debug log for every knowledge-retrieval decision. Makes the
 * invariant auditable: if dbMatchFound is TRUE, responseSource MUST be DATABASE.
 * A GENERAL_AI source alongside a DB match is flagged as a critical bug.
 */
function logKnowledgeRetrieval(entry: {
  school?: string;
  categoryId: string;
  query: string;
  knowledgeId: string | null;
  matchScore: number;
  dbMatchFound: boolean;
  responseSource: 'DATABASE' | 'GENERAL_AI' | 'NO_OFFICIAL_INFO';
  polished: boolean;
}) {
  const line = {
    selectedSchool: entry.school ?? '(none)',
    selectedCategory: entry.categoryId,
    userQuery: entry.query,
    retrievedKnowledgeId: entry.knowledgeId ?? '(none)',
    knowledgeMatchScore: Number(entry.matchScore.toFixed(2)),
    databaseMatchFound: entry.dbMatchFound,
    responseSource: entry.responseSource,
    polishedByEditor: entry.polished,
  };
  if (entry.dbMatchFound && entry.responseSource !== 'DATABASE') {
    console.error('[KB][CRITICAL BUG] DB match exists but response is not DATABASE:', line);
  } else {
    console.log('[KB]', line);
  }
}

/**
 * Single entry for answers.
 *
 * Priority order (admin knowledge is the single source of truth):
 *   1. Grounding gate — if any admin-authored entry (KB article or school-scoped
 *      public_information) confidently matches, answer ONLY from its stored
 *      content. A match OVERRIDES the category classifier, because the admin
 *      explicitly filed this topic under this category.
 *   2. Category gate — otherwise, block off-topic questions.
 *   3. If the category is admin-managed but nothing matched, REFUSE (say no info
 *      has been added yet). Never let the LLM invent school-specific facts.
 *   4. Only non-admin-managed categories fall through to local/AI answers.
 */
export async function getCompanionReply(request: CompanionRequest): Promise<CompanionResult> {
  throwIfAborted(request.signal);
  const replyLanguage = resolveReplyLanguage(request.question, request.languageMode ?? 'auto');

  // Every admin-authored entry that applies to this request. School mode is
  // always admin-managed (its answers must come from stored school info, never
  // a generic LLM reply); other categories are admin-managed when KB articles
  // exist for them.
  const groundingArticles = collectGroundingArticles(request);
  const isAdminManaged =
    request.categoryId === SCHOOL_CATEGORY_ID ||
    (request.knowledgeArticles?.length ?? 0) > 0;

  // ── STEP 1: GROUNDING GATE — match admin/website source, then answer.
  // Retrieval expands for broad overviews (all related programs/sections).
  // Short notes still get AI polish; long multi-section answers use a longer editor budget.
  const bestMatch = selectBestKnowledgeArticle(groundingArticles, request.question);
  if (bestMatch) {
    const { article, score } = bestMatch;
    const broad = isBroadOverviewQuestion(request.question);
    const focusedContent = selectRelevantKnowledgeContext(
      article,
      request.question,
      request.simpleMode,
    );
    const focusedArticle: KnowledgeArticleLite = {
      ...article,
      content: focusedContent,
    };
    const raw = buildRawKnowledgeReply(focusedArticle, request, replyLanguage);

    logKbRetrievalDetail({
      phase: 'grounding-gate',
      school: request.schoolName ?? null,
      categoryId: request.categoryId,
      query: request.question,
      broad,
      knowledgeId: article.id,
      articleTitle: article.title,
      matchScore: Number(score.toFixed(2)),
      rawArticleChars: (article.content || '').length,
      focusedContextChars: focusedContent.length,
      rawReplyChars: raw.text.length,
    });

    let edited: CompanionReply | null = null;
    const editorTimeout = broad ? kbEditorTimeoutBroadMs : kbEditorTimeoutMs;
    try {
      // Selected (possibly multi-section) context reaches the model — not a fixed top-2 cut.
      edited = await Promise.race([
        editKnowledgeWithProxy(focusedArticle, request, replyLanguage),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), editorTimeout + 500);
        }),
      ]);
    } catch {
      edited = null;
    }

    // Prefer polished answer only when it still covers enough of the source for broad asks.
    let reply =
      edited && hasSubstantiveKnowledgeReply(edited.text, replyLanguage) ? edited : raw;
    if (
      broad &&
      edited &&
      reply === edited &&
      !isBroadReplyCompleteEnough(edited.text, focusedContent)
    ) {
      console.warn(
        '[KB] Editor omitted too many source sections for broad question — using full grounded raw extract.',
      );
      reply = raw;
    }

    logKbRetrievalDetail({
      phase: 'final-reply',
      query: request.question,
      polished: Boolean(edited && reply === edited),
      finishPath: edited && reply === edited ? 'editor' : 'raw_grounded',
      responseChars: reply.text.length,
      uiResponseChars: reply.text.length,
    });

    // Never ship a hollow answer (header only / empty body). Treat as no match.
    if (!hasSubstantiveKnowledgeReply(reply.text, replyLanguage)) {
      console.warn(
        '[KB] Matched article produced empty/header-only reply — refusing instead of blank bubble.',
        article.id,
        article.title,
      );
    } else {
      logKnowledgeRetrieval({
        school: request.schoolName,
        categoryId: request.categoryId,
        query: request.question,
        knowledgeId: article.id,
        matchScore: score,
        dbMatchFound: true,
        responseSource: 'DATABASE',
        polished: Boolean(edited && edited === reply),
      });
      return { blocked: false, text: reply.text, source: 'knowledge_base' };
    }
  }

  throwIfAborted(request.signal);

  // ── STEP 2: HARD CATEGORY GATE — never reach AI / local answer on mismatch. ──
  const classification = validateCategory(
    request.question,
    request.categoryId,
    request.categories,
  );
  if (!classification.isMatch) {
    console.warn(
      '[getCompanionReply] BLOCKED category mismatch',
      request.categoryId,
      '→',
      classification.detectedCategoryId,
      classification.scores,
    );
    return { blocked: true, classification };
  }

  throwIfAborted(request.signal);

  // ── STEP 3: admin-managed category with no matching entry → refuse rather
  // than let the AI proxy invent school-specific facts. ──
  if (isAdminManaged) {
    logKnowledgeRetrieval({
      school: request.schoolName,
      categoryId: request.categoryId,
      query: request.question,
      knowledgeId: null,
      matchScore: 0,
      dbMatchFound: false,
      responseSource: 'NO_OFFICIAL_INFO',
      polished: false,
    });
    return { blocked: false, text: knowledgeMissMessage(replyLanguage), source: 'knowledge_base' };
  }

  // ── STEP 4: non-admin-managed categories may use local + AI answers. ──
  const localReply = buildLocalReply(request);
  throwIfAborted(request.signal);

  if (localReply.source !== 'fallback') {
    return { blocked: false, text: localReply.text, source: localReply.source };
  }

  const proxyReply = await askProxy(request);
  if (proxyReply) {
    return { blocked: false, text: proxyReply.text, source: proxyReply.source };
  }
  return { blocked: false, text: localReply.text, source: localReply.source };
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
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

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
    if (timedOut && !signal?.aborted) {
      const timeoutError = new Error('AI proxy timed out.');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }

    throw error;
  } finally {
    signal?.removeEventListener('abort', abortRequest);
    clearTimeout(timeoutId);
  }
}
