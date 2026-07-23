import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatKnowledgeReply,
  isBroadOverviewQuestion,
  selectBestKnowledgeArticle,
  selectRelevantKnowledgeContext,
  stripConversationalLeadIn,
  type KnowledgeArticleLite,
} from '../src/lib/companionEngine';
import { buildKnowledgeSearchQuery } from '../src/lib/knowledgeQuery';

const articles: KnowledgeArticleLite[] = [
  {
    id: 'alumni-discount',
    categoryId: 'kb-school',
    subcategoryName: 'Discounts & Scholarships',
    title: 'Alumni Discount',
    content: 'Alumni receive a 20% discount after presenting an alumni ID at OSA.',
    keywords: ['alumni', 'discount'],
    tags: ['discounts'],
    priority: 100,
  },
  {
    id: 'new-student-discount',
    categoryId: 'kb-school',
    subcategoryName: 'Discounts & Scholarships',
    title: 'New Student Discount',
    content: 'New students receive a 20% discount after presenting an admission slip.',
    keywords: ['new student', 'freshman', 'discount'],
    tags: ['discounts'],
    priority: 100,
  },
];

/** Realistic multi-program scholarship page (approved crawl shape). */
const scholarshipPage: KnowledgeArticleLite = {
  id: 'scholarship-programs',
  categoryId: 'kb-school',
  subcategoryName: 'Discounts & Scholarships',
  title: 'Scholarship Programs',
  keywords: ['scholarship', 'scholarships', 'gwa', 'tuition'],
  tags: ['website', 'import', 'scholarship'],
  priority: 100,
  sourceType: 'website',
  content: `
## F. Cayco Memorial Scholarship
Eligibility: Incoming freshmen who are AU graduates and are specially nominated for the grant.
Benefit: 100% of tuition and miscellaneous fees.
Requirements:
- Certified copy of grades
- Certificate of enrollment
- First-time recipients must present the Certificate of Award of the F. Cayco Memorial Scholarship

## E. Esguerra Scholarship for Valedictorian/Salutatorian
Eligibility: AU elementary graduates with First Honors or Second Honors.
Requirements:
- Certification letter from the principal
- Photocopy of the report card

## JUNIOR HIGH SCHOOL ENTRANCE SCHOLARSHIP FOR ELEMENTARY GRADUATES WITH HONORS
Available to AU and non-AU graduates.
Benefits:
- With Highest Honors, GWA 98–100%: 100% tuition fee only
- With High Honors, GWA 95–97%: 75% tuition fee only
- With Honors, GWA 90–94%: 50% tuition fee only
Requirements:
- Certification letter from the principal showing the GWA and honor classification
- Photocopy of the report card

## College Entrance Scholarship for High School Graduates with Honors
Available to AU and non-AU graduates.
Benefits:
- With Highest Honors, GWA 98–100%: 100% tuition fee only
- With High Honors, GWA 95–97%: 75% tuition fee only
- With Honors, GWA 90–94%: 50% tuition fee only
Requirements:
- Certification letter from the principal showing the GWA and honor classification
- Photocopy of the report card

## Academic Achievement in College
Eligibility: College students with individual academic achievements during a semester or school year.
Conditions:
- Minimum load of 18 units
- Highest average: 100% tuition fee only
- Second highest average: 50% tuition fee only
- Third highest average: 25% tuition fee only
- No grade lower than 1.75
- Must be recommended by the Guidance Department, Department Head, and Registrar’s Office

## Academic Scholarship for Elementary, Junior High School, and Senior High School
For currently enrolled AU students based on the preceding school year.
Benefits:
- First Honor: 100% tuition fee only
- Second Honor: 50% tuition fee only
- Third Honor: 25% tuition fee only
Requirements:
- Certification letter from the principal showing the GWA and honor classification
- Photocopy of the report card

## Important
All scholarship offers and discounts are subject to change without prior notice.
`.trim(),
};

test('alumni question selects only the alumni sibling', () => {
  const result = selectBestKnowledgeArticle(articles, 'How do I get the alumni discount?');
  assert.equal(result?.article.id, 'alumni-discount');
});

test('new-student question excludes the alumni sibling', () => {
  const result = selectBestKnowledgeArticle(articles, 'What is the new student discount?');
  assert.equal(result?.article.id, 'new-student-discount');
});

test('explicit comparison may combine only the named siblings', () => {
  const result = selectBestKnowledgeArticle(
    articles,
    'Compare the alumni and new student discounts.',
  );
  assert.equal(result?.article.id, 'alumni-discount+new-student-discount');
  assert.match(result?.article.content ?? '', /Alumni Discount/);
  assert.match(result?.article.content ?? '', /New Student Discount/);
});

test('unrelated question does not return a random school article', () => {
  const result = selectBestKnowledgeArticle(articles, 'Who is the university president?');
  assert.equal(result, null);
});

test('database query removes conversational filler but keeps the intent terms', () => {
  assert.equal(
    buildKnowledgeSearchQuery('How do I get the alumni discount, please?'),
    'alumni discount',
  );
});

test('detects broad scholarship overview questions', () => {
  assert.equal(isBroadOverviewQuestion('Can you explain the scholarship?'), true);
  assert.equal(isBroadOverviewQuestion('What scholarships are available?'), true);
  assert.equal(isBroadOverviewQuestion('List all scholarship programs.'), true);
  assert.equal(isBroadOverviewQuestion('Ano ang mga scholarship?'), true);
  assert.equal(isBroadOverviewQuestion('Ano-ano ang available na scholarship?'), true);
  assert.equal(isBroadOverviewQuestion('What scholarship can I apply for?'), true);
});

test('detects specific scholarship questions', () => {
  assert.equal(
    isBroadOverviewQuestion('What are the requirements for the F. Cayco Memorial Scholarship?'),
    false,
  );
  assert.equal(
    isBroadOverviewQuestion('What is the Academic Achievement in College scholarship?'),
    false,
  );
  assert.equal(
    isBroadOverviewQuestion('What discount is available for students with High Honors?'),
    false,
  );
});

test('broad scholarship retrieval includes every distinct program section', () => {
  const context = selectRelevantKnowledgeContext(
    scholarshipPage,
    'Can you explain the scholarship?',
    false,
  );
  assert.match(context, /F\.\s*Cayco/i);
  assert.match(context, /Esguerra/i);
  assert.match(context, /JUNIOR HIGH SCHOOL ENTRANCE SCHOLARSHIP/i);
  assert.match(context, /College Entrance Scholarship/i);
  assert.match(context, /Academic Achievement in College/i);
  assert.match(context, /Academic Scholarship for Elementary/i);
  assert.match(context, /subject to change/i);
  // Must not stop after only the first two programs
  assert.ok(context.length > 1200, `context too short: ${context.length}`);
});

test('specific Cayco question keeps Cayco requirements', () => {
  const context = selectRelevantKnowledgeContext(
    scholarshipPage,
    'What are the requirements for the F. Cayco Memorial Scholarship?',
    false,
  );
  assert.match(context, /Cayco/i);
  assert.match(context, /Certificate of Award/i);
  assert.match(context, /Certified copy of grades/i);
});

test('High Honors discount detail is retrievable', () => {
  const context = selectRelevantKnowledgeContext(
    scholarshipPage,
    'What discount is available for students with High Honors?',
    false,
  );
  assert.match(context, /75%/);
  assert.match(context, /95/);
});

test('Academic Achievement in College conditions are retrievable', () => {
  const context = selectRelevantKnowledgeContext(
    scholarshipPage,
    'What is the Academic Achievement in College scholarship?',
    false,
  );
  assert.match(context, /18 units/i);
  assert.match(context, /1\.75/);
  assert.match(context, /Guidance/i);
});

test('scholarship article is selected for broad scholarship question', () => {
  const pool = [...articles, scholarshipPage];
  const result = selectBestKnowledgeArticle(pool, 'Can you explain the scholarship?');
  assert.ok(result);
  assert.match(result!.article.id, /scholarship-programs/);
  assert.ok(result!.score >= 2.5);
});

test('strips conversational double-intro after official header', () => {
  const cleaned = stripConversationalLeadIn(
    "Sure, here is an overview of the scholarship programs and how to obtain them.\n\nF. Cayco Memorial Scholarship\n- 100% tuition",
  );
  assert.doesNotMatch(cleaned, /^sure/i);
  assert.doesNotMatch(cleaned, /here is an overview/i);
  assert.match(cleaned, /F\.\s*Cayco/i);

  const formatted = formatKnowledgeReply(
    "Sure, here is an overview of the scholarship programs and how to obtain them.\n\nThe following scholarship programs are currently available:\n\nF. Cayco Memorial Scholarship",
    'english',
  );
  assert.match(formatted, /^According to the school's official information:/);
  assert.equal(
    (formatted.match(/According to the school's official information:/gi) || []).length,
    1,
  );
  assert.doesNotMatch(formatted, /Sure,/i);
  assert.doesNotMatch(formatted, /here is an overview/i);
  assert.match(formatted, /The following scholarship programs are currently available/);
});
