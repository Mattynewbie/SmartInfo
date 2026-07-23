/**
 * SmartInfo website crawler — Super Admin only.
 * Used by voice-proxy /crawl/* routes. No member access.
 */

import { createHash } from 'node:crypto';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 40;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'SmartInfoKnowledgeBot/1.0 (+school-info-import; respectful crawler)';

/** @type {Map<string, { stop: boolean }>} */
const activeJobs = new Map();

export function requestStopCrawl(jobId) {
  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stop = true;
    return true;
  }
  return false;
}

export function isCrawlRunning(jobId) {
  return activeJobs.has(jobId);
}

/**
 * Supabase REST config for crawl jobs.
 * Prefer server env on DigitalOcean (SUPABASE_URL / SUPABASE_*_KEY).
 * Public URL + anon key may fall back to EXPO_PUBLIC_* (same values already in the mobile app).
 * Optional service role speeds up writes; user JWT works when RLS allows Super Admin.
 */
function getSupabaseConfig() {
  const url = (
    process.env.SUPABASE_URL ||
    process.env.EXPO_PUBLIC_SUPABASE_URL ||
    // Known project (public) — so DO works even if only GROQ/ELEVENLABS were set in App Platform.
    'https://wiryterhikvjxhsshyic.supabase.co'
  )
    .trim()
    .replace(/\/$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
    // Public anon key (safe to ship; RLS still enforces Super Admin for crawl writes).
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcnl0ZXJoaWt2anhoc3NoeWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMzk4NjQsImV4cCI6MjA5ODgxNTg2NH0.ebcHuidRAIh0R-roGl0OtPFWFV_qFKmzcIgOpUHL1O4'
  ).trim();
  return { url, serviceKey, anonKey };
}

async function supabaseRest(path, { method = 'GET', token, body, prefer } = {}) {
  const { url, serviceKey, anonKey } = getSupabaseConfig();
  if (!url) {
    throw new Error('SUPABASE_URL is not configured on the proxy.');
  }
  const key = serviceKey || anonKey;
  if (!key) {
    throw new Error('Supabase key missing on proxy (SUPABASE_SERVICE_ROLE_KEY or ANON key).');
  }
  const headers = {
    apikey: key,
    Authorization: `Bearer ${token || serviceKey || anonKey}`,
    'Content-Type': 'application/json',
  };
  if (prefer) {
    headers.Prefer = prefer;
  }
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = typeof data === 'object' && data?.message ? data.message : text || response.statusText;
    throw new Error(msg || `Supabase REST ${response.status}`);
  }
  return data;
}

/**
 * Verify the caller's JWT is a SmartInfo superadmin.
 * @returns {{ authUserId: string, userId: string }}
 */
export async function requireSuperAdminFromAuthHeader(authHeader) {
  const { url, anonKey, serviceKey } = getSupabaseConfig();
  if (!url || !(anonKey || serviceKey)) {
    throw Object.assign(new Error('Proxy Supabase auth is not configured.'), { status: 500 });
  }
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw Object.assign(new Error('Missing Authorization bearer token.'), { status: 401 });
  }

  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anonKey || serviceKey,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    throw Object.assign(new Error('Invalid or expired session.'), { status: 401 });
  }
  const authUser = await userRes.json();
  const authUserId = authUser?.id;
  if (!authUserId) {
    throw Object.assign(new Error('Invalid session user.'), { status: 401 });
  }

  // Look up role with service role when available (bypass RLS); else use user token.
  const restKey = serviceKey || anonKey;
  const roleRes = await fetch(
    `${url}/rest/v1/users?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=id,role&limit=1`,
    {
      headers: {
        apikey: restKey,
        Authorization: `Bearer ${serviceKey || token}`,
      },
    },
  );
  const rows = await roleRes.json();
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile || profile.role !== 'superadmin') {
    throw Object.assign(new Error('Super Admin only.'), { status: 403 });
  }
  return { authUserId, userId: String(profile.id), accessToken: token };
}

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    u.hash = '';
    // Drop common tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid'].forEach((k) => u.searchParams.delete(k));
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function pathAllowed(url, includePaths, excludePaths) {
  let pathname = '/';
  try {
    pathname = new URL(url).pathname || '/';
  } catch {
    return false;
  }
  const lower = pathname.toLowerCase();
  for (const ex of excludePaths || []) {
    if (!ex) continue;
    if (lower.includes(String(ex).toLowerCase())) {
      return false;
    }
  }
  if (!includePaths?.length) {
    return true;
  }
  return includePaths.some((inc) => inc && lower.includes(String(inc).toLowerCase()));
}

/** Decode a few common HTML entities after tags are gone. */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return '';
      }
    });
}

/**
 * Remove chrome that is almost never useful school knowledge:
 * nav menus, site headers/footers, sidebars, cookie banners, etc.
 */
function removeChrome(html) {
  let s = String(html || '');

  // Scripts / styles / comments first.
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Semantic chrome tags (repeat for nested-ish cases).
  const chromeTags = [
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'iframe',
    'menu',
    'figure',
  ];
  for (let pass = 0; pass < 3; pass++) {
    for (const tag of chromeTags) {
      const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
      s = s.replace(re, ' ');
    }
  }

  // Elements whose id/class look like menus / chrome.
  // Match opening tags with those attributes, then drop balanced-ish blocks when possible.
  const chromeAttr =
    /(id|class)\s*=\s*["'][^"']*(nav|menu|navbar|header|footer|sidebar|breadcrumb|cookie|banner|toolbar|social|share|widget|modal|popup|drawer|offcanvas|skip-link|site-header|site-footer|main-menu|top-bar|bottom-bar|masthead)[^"']*["']/i;

  // Drop whole tags that are clearly chrome by class/id (non-greedy inner for short blocks).
  s = s.replace(
    /<([a-z0-9]+)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:\bnav\b|navbar|menu|menubar|header|footer|sidebar|breadcrumb|cookie|toolbar|social|share-links|widget|offcanvas|topbar|bottombar|site-header|site-footer|main-menu|masthead)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  // Also strip self-closing / leftover chrome openers that matched attr pattern but not closed above.
  s = s.replace(
    /<([a-z0-9]+)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:\bnav\b|navbar|menu|header|footer|sidebar|breadcrumb|cookie)[^"']*["'][^>]*\/?>/gi,
    ' ',
  );

  // Drop pure link lists that often remain after partial nav strip.
  s = s.replace(/<(ul|ol)\b[^>]*>\s*(?:<li\b[^>]*>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/li>\s*){3,}<\/\1>/gi, ' ');

  void chromeAttr;
  return s;
}

/**
 * Prefer the real page body over the whole document when possible.
 */
function pickMainHtml(html) {
  const raw = String(html || '');
  const candidates = [];

  const patterns = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<div\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:main-content|page-content|entry-content|post-content|content-area|site-content|article-body|page-body|primary)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<section\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:content|main)[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
    /<div\b[^>]*role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (m) {
      const inner = m[1] || m[2] || '';
      if (inner && stripTagsOnly(inner).length > 200) {
        candidates.push(inner);
      }
    }
  }

  if (candidates.length) {
    // Longest substantial candidate tends to be the article body.
    candidates.sort((a, b) => stripTagsOnly(b).length - stripTagsOnly(a).length);
    return candidates[0];
  }

  // Fallback: body without chrome.
  const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : raw;
}

function stripTagsOnly(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
}

/** True when a bare line looks like a real page section title (must never be dropped). */
function looksLikeSectionHeading(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 120) return false;
  // Already structured from htmlToStructuredText
  if (/^#{1,4}\s+\S/.test(raw)) return true;
  if (/^SECTION:\s+\S/i.test(raw)) return true;

  const bare = raw.replace(/^#{1,4}\s+/, '').replace(/^SECTION:\s+/i, '').trim();
  if (!bare || bare.length < 3) return false;

  // Explicit school-knowledge section keywords
  const sectionRe =
    /\b(requirement|requirements|goal|goals|objective|objectives|admission|admissions|enrollment|enrolment|tuition|fee|fees|scholarship|scholarships|curriculum|program|programs|campus|campuses|contact|schedule|calendar|document|documents|eligibility|procedure|procedures|how to apply|application|overview|about|mission|vision|history|faculty|offered|offerings|benefits|discount|discounts|policy|policies|guideline|guidelines)\b/i;
  if (sectionRe.test(bare) && bare.split(/\s+/).length <= 12 && !/[.!?]{2,}/.test(bare)) {
    return true;
  }

  // ALL CAPS short titles: "REQUIREMENTS", "GOALS AND OBJECTIVES"
  const letters = bare.replace(/[^A-Za-z]/g, '');
  if (
    letters.length >= 4 &&
    bare === bare.toUpperCase() &&
    /[A-Z]/.test(bare) &&
    bare.split(/\s+/).length <= 10 &&
    bare.length <= 80 &&
    !/[.!?]/.test(bare)
  ) {
    return true;
  }

  // Title Case short labels that are not full sentences
  if (
    bare.split(/\s+/).length >= 2 &&
    bare.split(/\s+/).length <= 8 &&
    bare.length <= 70 &&
    !/[.!?]/.test(bare) &&
    bare.split(/\s+/).every((w) => !w || w[0] === w[0].toUpperCase() || /^(and|of|the|for|at|in|to|with|a|an)$/i.test(w))
  ) {
    // Prefer ones that include a knowledge keyword or end with a colon
    if (sectionRe.test(bare) || /:$/.test(bare)) return true;
  }

  return false;
}

/**
 * Convert cleaned HTML into structured plain text for the AI:
 * - Headings become "## Heading"
 * - List items become "- item"
 * - Table cells stay on separate lines
 * This preserves section meaning (e.g. REQUIREMENTS before a bullet list).
 */
function htmlToStructuredText(html) {
  let s = String(html || '');

  // Headings first — keep level so AI knows hierarchy.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const text = stripTagsOnly(inner).replace(/\s+/g, ' ').trim();
    if (!text) return '\n';
    const n = Math.min(4, Math.max(1, Number(level) || 2));
    const hashes = '#'.repeat(n);
    return `\n\n${hashes} ${text}\n\n`;
  });

  // Definition / strong labels often used as mini-headings
  s = s.replace(/<(dt|legend)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => {
    const text = stripTagsOnly(inner).replace(/\s+/g, ' ').trim();
    return text ? `\n\n## ${text}\n` : '\n';
  });

  // List items → bullets (before stripping other tags)
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const text = stripTagsOnly(inner).replace(/\s+/g, ' ').trim();
    return text ? `\n- ${text}` : '\n';
  });
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');

  // Table rows → one line per row with cell separators
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [];
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let m;
    while ((m = cellRe.exec(row))) {
      const cell = stripTagsOnly(m[1]).replace(/\s+/g, ' ').trim();
      if (cell) cells.push(cell);
    }
    return cells.length ? `\n${cells.join(' | ')}` : '\n';
  });

  // Block breaks
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|header|footer)>/gi, '\n\n')
    .replace(/<(p|div|section|article|blockquote)\b[^>]*>/gi, '\n');

  // Remaining tags
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);

  // Normalize whitespace while keeping structure markers
  const lines = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0);

  // Collapse excessive blank runs later via join
  return lines.join('\n');
}

/**
 * Drop leftover menu-like lines (short standalone chrome labels).
 * NEVER drops section headings, structured "##" lines, or bullet items.
 */
function cleanExtractedText(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const commonNavWords = new Set([
    'home',
    'news',
    'alumni',
    'research',
    'login',
    'search',
    'menu',
    'gallery',
    'events',
    'blog',
    'careers',
    'skip',
    'toggle',
  ]);

  // Words that look like nav but are often real content section titles — never treat as nav.
  const protectWords = new Set([
    'requirements',
    'requirement',
    'admission',
    'admissions',
    'enrollment',
    'enrolment',
    'tuition',
    'scholarship',
    'scholarships',
    'programs',
    'program',
    'campus',
    'campuses',
    'contact',
    'about',
    'goals',
    'objectives',
    'mission',
    'vision',
    'curriculum',
    'faculty',
    'students',
  ]);

  const seen = new Set();
  const kept = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    // Always keep structure we already marked.
    if (/^#{1,4}\s+\S/.test(line) || /^SECTION:\s+\S/i.test(line) || /^-\s+\S/.test(line)) {
      seen.add(key);
      kept.push(line);
      continue;
    }

    if (looksLikeSectionHeading(line)) {
      // Normalize bare section titles into ## headings for the AI.
      const normalized = line.startsWith('#') ? line : `## ${line.replace(/:$/, '').trim()}`;
      const nKey = normalized.toLowerCase();
      if (!seen.has(nKey)) {
        seen.add(nKey);
        seen.add(key);
        kept.push(normalized);
      }
      continue;
    }

    const words = line.split(/\s+/);
    const wordCount = words.length;
    const firstWord = (words[0] || '').toLowerCase().replace(/[^a-z]/g, '');

    // Only drop pure chrome nav chips — never protected section words.
    const isOneWordNav =
      wordCount === 1 &&
      line.length < 22 &&
      !/\d/.test(line) &&
      !/[.!?:]/.test(line) &&
      commonNavWords.has(firstWord) &&
      !protectWords.has(firstWord);

    const isKnownNav =
      wordCount <= 2 &&
      words.every((w) => {
        const clean = w.toLowerCase().replace(/[^a-z]/g, '');
        return commonNavWords.has(clean) && !protectWords.has(clean);
      });

    if (isOneWordNav || isKnownNav) {
      continue;
    }

    seen.add(key);
    kept.push(line);
  }

  // If filters were too aggressive, fall back to original lines but still mark headings.
  if (kept.join(' ').length < 100 && lines.join(' ').length > 100) {
    const fallback = [];
    const seen2 = new Set();
    for (const line of lines) {
      const key = line.toLowerCase();
      if (seen2.has(key)) continue;
      if (looksLikeSectionHeading(line) && !line.startsWith('#')) {
        fallback.push(`## ${line.replace(/:$/, '').trim()}`);
      } else {
        fallback.push(line);
      }
      seen2.add(key);
    }
    return fallback.join('\n\n').trim();
  }

  // Join: keep a blank line after headings and between blocks for readability.
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i];
    out.push(line);
    const next = kept[i + 1];
    if (!next) break;
    if (/^#{1,4}\s+/.test(line) || /^#{1,4}\s+/.test(next) || /^-\s+/.test(line) !== /^-\s+/.test(next)) {
      // blank line between different block types
      if (!/^-\s+/.test(line) || !/^-\s+/.test(next)) {
        out.push('');
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Build AI-safe page body with title/URL context + structured sections.
 * Example:
 *   Page: Junior High School
 *   URL: https://...
 *   ## GOALS AND OBJECTIVES
 *   - ...
 *   ## REQUIREMENTS
 *   - Report Card (F-138)
 */
function stripHtml(html, meta = {}) {
  const main = pickMainHtml(html);
  const withoutChrome = removeChrome(main);
  const structured = htmlToStructuredText(withoutChrome);
  let body = cleanExtractedText(structured);

  const title = String(meta.title || '').trim();
  const url = String(meta.url || '').trim();

  // Collect section outline for the AI (helps even if body is long).
  const sections = [];
  const secRe = /^#{1,4}\s+(.+)$/gm;
  let sm;
  while ((sm = secRe.exec(body))) {
    const name = sm[1].trim();
    if (name && !sections.includes(name) && name.length < 100) {
      sections.push(name);
    }
  }

  const headerLines = [];
  if (title) headerLines.push(`Page: ${title}`);
  if (url) headerLines.push(`URL: ${url}`);
  if (sections.length) {
    headerLines.push(`Sections on this page: ${sections.join(' · ')}`);
  }
  // Keep this note free of topic words (requirements/admission/etc.) so keyword
  // extraction does not pollute every page with unrelated match terms.
  headerLines.push(
    'Note: Text under each ## heading belongs only to that section. Prefer the matching section when answering.',
  );

  if (headerLines.length && body) {
    body = `${headerLines.join('\n')}\n\n${body}`;
  } else if (headerLines.length) {
    body = headerLines.join('\n');
  }

  return body.trim();
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) {
    const h1 = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return h1 ? stripTagsOnly(h1[1]).slice(0, 200) : 'Untitled page';
  }
  // Titles often look like "Page | School Name" — keep left part when useful.
  let title = stripTagsOnly(m[1]).slice(0, 200);
  if (title.includes('|')) {
    const parts = title.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts[0] && parts[0].length >= 4) {
      title = parts[0];
    }
  }
  return title || 'Untitled page';
}

function extractLinks(html, pageUrl) {
  const links = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = match[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }
    const absolute = normalizeUrl(href, pageUrl);
    if (absolute) {
      links.add(absolute);
    }
  }
  return [...links];
}

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 40);
}

function guessKeywords(title, content) {
  // Ignore the structural header note when scoring topic keywords.
  const contentForKeys = String(content || '')
    .replace(/^Page:.*$/gim, '')
    .replace(/^URL:.*$/gim, '')
    .replace(/^Sections on this page:.*$/gim, '')
    .replace(/^Note:.*$/gim, '');
  const blob = `${title} ${contentForKeys}`.toLowerCase();
  // Pull words from ## section headings so AI can match "requirements" etc.
  const headingWords = [];
  const headingRe = /^#{1,4}\s+(.+)$/gm;
  let hm;
  while ((hm = headingRe.exec(contentForKeys))) {
    for (const w of hm[1].toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 3) headingWords.push(w);
    }
  }
  // Always index distinctive title words (logo, hymn, scholarship…).
  const titleWordsEarly = String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['page', 'about', 'arellano', 'university', 'school'].includes(w));
  const candidates = [
    'enrollment',
    'admission',
    'tuition',
    'scholarship',
    'scholarships',
    'discount',
    'discounts',
    'registrar',
    'requirements',
    'goals',
    'objectives',
    'campuses',
    'logo',
    'seal',
    'hymn',
    'mission',
    'vision',
    'history',
    'calendar',
    'campus',
    'program',
    'programs',
    'course',
    'courses',
    'fee',
    'fees',
    'alumni',
    'contact',
    'about',
    'application',
    'apply',
    'office',
    'schedule',
    'subject',
    'subjects',
    'curriculum',
    'financial',
    'aid',
  ];
  const fromList = candidates.filter((k) => blob.includes(k));
  // Also index distinctive title words so AI matching can find the page.
  const titleWords = String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 12);
  return [...new Set([...titleWordsEarly, ...fromList, ...headingWords, ...titleWords])].slice(0, 28);
}

/**
 * Publish (or refresh) a crawled page into knowledge_articles so the AI can
 * answer from it immediately — no manual Approve step required.
 * Returns the knowledge_articles.id when successful.
 */
async function publishPageToKnowledgeBase({ schoolId, url, title, content, keywords, writeToken }) {
  const now = new Date().toISOString();
  // Find existing article by source_url so re-crawls update instead of duplicate.
  const existing = await supabaseRest(
    `knowledge_articles?source_url=eq.${encodeURIComponent(url)}&school_id=eq.${encodeURIComponent(schoolId)}&select=id&limit=1`,
    { token: writeToken },
  );
  const existingId = Array.isArray(existing) && existing[0]?.id ? String(existing[0].id) : null;

  const payload = {
    category_id: 'kb-school',
    title: (title || url).slice(0, 300),
    content: content.slice(0, 20000),
    keywords: keywords.length ? keywords : ['website', 'import', 'school'],
    tags: ['website-import', 'school', 'auto-published'],
    priority: 90,
    is_published: true,
    is_archived: false,
    school_id: schoolId,
    source_url: url,
    source_type: 'website',
    updated_at: now,
  };

  if (existingId) {
    await supabaseRest(`knowledge_articles?id=eq.${encodeURIComponent(existingId)}`, {
      method: 'PATCH',
      token: writeToken,
      prefer: 'return=minimal',
      body: payload,
    });
    return existingId;
  }

  const created = await supabaseRest('knowledge_articles', {
    method: 'POST',
    token: writeToken,
    prefer: 'return=representation',
    body: payload,
  });
  if (Array.isArray(created) && created[0]?.id) {
    return String(created[0].id);
  }
  if (created?.id) {
    return String(created.id);
  }
  return null;
}

function isUsefulContent(text) {
  if (!text || text.length < 120) {
    return false;
  }
  // Skip pure nav/boilerplate dumps
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length >= 3;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      throw new Error(`Skip non-HTML (${ct || 'unknown type'})`);
    }
    const html = await res.text();
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function logLine(jobId, sourceId, level, message, url, writeToken) {
  try {
    await supabaseRest('website_crawl_logs', {
      method: 'POST',
      token: writeToken,
      prefer: 'return=minimal',
      body: {
        job_id: jobId,
        source_id: sourceId,
        level,
        message: String(message).slice(0, 2000),
        url: url || null,
      },
    });
  } catch {
    // Logging must not kill the crawl.
  }
}

async function patchJob(jobId, patch, writeToken) {
  await supabaseRest(`website_crawl_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    token: writeToken,
    prefer: 'return=minimal',
    body: { ...patch, updated_at: new Date().toISOString() },
  });
}

async function patchSource(sourceId, patch, writeToken) {
  await supabaseRest(`website_sources?id=eq.${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    token: writeToken,
    prefer: 'return=minimal',
    body: { ...patch, updated_at: new Date().toISOString() },
  });
}

/** Remove old pending review rows for this website before a new crawl. */
async function clearPendingPagesForSource(sourceId, writeToken) {
  await supabaseRest(
    `website_imported_pages?source_id=eq.${encodeURIComponent(sourceId)}&status=eq.pending`,
    {
      method: 'DELETE',
      token: writeToken,
      prefer: 'return=minimal',
    },
  );
}

/**
 * Run a BFS crawl for a website_sources row + job.
 * writeToken: prefer service role; falls back to superadmin user JWT.
 */
export async function runWebsiteCrawl({ source, jobId, writeToken, createdBy }) {
  const control = { stop: false };
  activeJobs.set(jobId, control);

  const maxDepth = Number(source.max_depth ?? DEFAULT_MAX_DEPTH);
  const maxPages = Number(source.max_pages ?? DEFAULT_MAX_PAGES);
  const includePaths = source.include_paths || [];
  const excludePaths = source.exclude_paths || [];
  const baseUrl = normalizeUrl(source.base_url, source.base_url);
  if (!baseUrl) {
    await patchJob(jobId, { status: 'failed', error_message: 'Invalid base_url', finished_at: new Date().toISOString() }, writeToken);
    activeJobs.delete(jobId);
    return;
  }

  const visited = new Set();
  /** @type {Array<{ url: string, depth: number }>} */
  const queue = [{ url: baseUrl, depth: 0 }];
  let pagesFound = 0;
  let pagesSaved = 0;

  try {
    await patchJob(
      jobId,
      { status: 'running', started_at: new Date().toISOString(), progress_percent: 0 },
      writeToken,
    );
    await patchSource(source.id, { status: 'crawling', last_error: null }, writeToken);
    // Fresh review queue for this website only (keeps approved/rejected history).
    try {
      await clearPendingPagesForSource(source.id, writeToken);
      await logLine(
        jobId,
        source.id,
        'info',
        'Cleared previous pending pages for this website before re-crawl.',
        baseUrl,
        writeToken,
      );
    } catch (clearError) {
      await logLine(
        jobId,
        source.id,
        'warn',
        `Could not clear old pending pages: ${clearError instanceof Error ? clearError.message : 'unknown'}`,
        baseUrl,
        writeToken,
      );
    }
    await logLine(jobId, source.id, 'info', `Crawl started for ${baseUrl}`, baseUrl, writeToken);

    while (queue.length && pagesSaved < maxPages) {
      if (control.stop) {
        await logLine(jobId, source.id, 'warn', 'Crawl stopped by Super Admin.', null, writeToken);
        await patchJob(
          jobId,
          {
            status: 'stopped',
            pages_found: pagesFound,
            pages_saved: pagesSaved,
            progress_percent: Math.min(99, Math.round((pagesSaved / maxPages) * 100)),
            finished_at: new Date().toISOString(),
          },
          writeToken,
        );
        await patchSource(source.id, { status: 'ready' }, writeToken);
        return;
      }

      const { url, depth } = queue.shift();
      if (visited.has(url)) {
        continue;
      }
      visited.add(url);
      pagesFound += 1;

      if (!sameOrigin(url, baseUrl) || !pathAllowed(url, includePaths, excludePaths)) {
        continue;
      }

      try {
        const html = await fetchPage(url);
        const title = extractTitle(html);
        const content = stripHtml(html, { title, url }).slice(0, 20000);
        if (!isUsefulContent(content)) {
          await logLine(jobId, source.id, 'info', `Skipped thin page: ${title}`, url, writeToken);
        } else {
          const hash = contentHash(content);
          const keywords = guessKeywords(title, content);
          // Save as PENDING — Super Admin must Approve before AI can use it.
          await supabaseRest('website_imported_pages?on_conflict=source_id,url', {
            method: 'POST',
            token: writeToken,
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: {
              source_id: source.id,
              school_id: source.school_id,
              job_id: jobId,
              url,
              title,
              content,
              content_hash: hash,
              status: 'pending',
              category_guess: 'school',
              keywords,
              knowledge_article_id: null,
              reviewed_by: null,
              reviewed_at: null,
              updated_at: new Date().toISOString(),
            },
          });
          pagesSaved += 1;
          await logLine(jobId, source.id, 'info', `Saved (pending approval): ${title}`, url, writeToken);
        }

        if (depth < maxDepth) {
          for (const link of extractLinks(html, url)) {
            if (!visited.has(link) && sameOrigin(link, baseUrl) && pathAllowed(link, includePaths, excludePaths)) {
              queue.push({ url: link, depth: depth + 1 });
            }
          }
        }
      } catch (error) {
        await logLine(
          jobId,
          source.id,
          'error',
          error instanceof Error ? error.message : 'Fetch failed',
          url,
          writeToken,
        );
      }

      const progress = Math.min(99, Math.round((pagesSaved / maxPages) * 100));
      await patchJob(
        jobId,
        { pages_found: pagesFound, pages_saved: pagesSaved, progress_percent: progress },
        writeToken,
      );

      // Be polite to the origin.
      await new Promise((r) => setTimeout(r, 350));
    }

    const scheduleHours = source.schedule_hours;
    const nextCrawl =
      scheduleHours && Number(scheduleHours) > 0
        ? new Date(Date.now() + Number(scheduleHours) * 3600 * 1000).toISOString()
        : null;

    await patchJob(
      jobId,
      {
        status: 'completed',
        pages_found: pagesFound,
        pages_saved: pagesSaved,
        progress_percent: 100,
        finished_at: new Date().toISOString(),
      },
      writeToken,
    );
    await patchSource(
      source.id,
      {
        status: 'ready',
        last_crawled_at: new Date().toISOString(),
        last_error: null,
        next_crawl_at: nextCrawl,
      },
      writeToken,
    );
    await logLine(
      jobId,
      source.id,
      'info',
      `Crawl completed. Found ${pagesFound} URLs, saved ${pagesSaved} pages.`,
      null,
      writeToken,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Crawl failed';
    await logLine(jobId, source.id, 'error', msg, null, writeToken);
    await patchJob(
      jobId,
      {
        status: 'failed',
        error_message: msg,
        pages_found: pagesFound,
        pages_saved: pagesSaved,
        finished_at: new Date().toISOString(),
      },
      writeToken,
    );
    await patchSource(source.id, { status: 'error', last_error: msg }, writeToken);
  } finally {
    activeJobs.delete(jobId);
  }
}

export async function loadSourceById(sourceId, token) {
  const rows = await supabaseRest(
    `website_sources?id=eq.${encodeURIComponent(sourceId)}&select=*&limit=1`,
    { token },
  );
  return Array.isArray(rows) ? rows[0] : null;
}

export async function createCrawlJob(sourceId, createdBy, token) {
  const rows = await supabaseRest('website_crawl_jobs', {
    method: 'POST',
    token,
    prefer: 'return=representation',
    body: {
      source_id: sourceId,
      status: 'queued',
      created_by: createdBy || null,
    },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export function getWriteToken(userAccessToken) {
  const { serviceKey } = getSupabaseConfig();
  return serviceKey || userAccessToken;
}
