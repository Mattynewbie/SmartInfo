import type { Announcement, Category, FAQ, FeedbackItem, PublicInfo, VoicePackage } from '../types';

const now = new Date().toISOString();

export const defaultCategories: Category[] = [
  {
    id: 'school',
    key: 'school',
    name: 'School',
    description: 'Enrollment, offices, schedules, rules, and announcements.',
    color: '#3B82F6',
    icon: 'school-outline',
    isActive: true,
  },
  {
    id: 'government',
    key: 'government',
    name: 'Government',
    description: 'Documents, forms, office hours, and public service steps.',
    color: '#14B8A6',
    icon: 'business-outline',
    isActive: true,
  },
  {
    id: 'public_places',
    key: 'public_places',
    name: 'Public Places',
    description: 'Directions, safety reminders, facilities, and lost and found.',
    color: '#F59E0B',
    icon: 'map-outline',
    isActive: true,
  },
  {
    id: 'others',
    key: 'others',
    name: 'Others',
    description: 'Custom public information support.',
    color: '#FB7185',
    icon: 'sparkles-outline',
    isActive: true,
  },
];

export const defaultFaqs: FAQ[] = [
  {
    id: 'faq-school-enrollment',
    categoryId: 'school',
    question: 'How do I enroll?',
    answer:
      'For enrollment, prepare your report card, birth certificate, good moral certificate, and ID photo. Go to the Registrar first, submit your documents, then wait for section and schedule confirmation.',
    tags: ['enrollment', 'registrar', 'requirements', 'student'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-school-registrar',
    categoryId: 'school',
    question: 'Where is the registrar office?',
    answer:
      'The Registrar is usually near the main administration office. If you are new, ask the guard for "Registrar" and bring your school ID or enrollment documents.',
    tags: ['registrar', 'office', 'location'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-school-rules',
    categoryId: 'school',
    question: 'What are the basic school rules?',
    answer:
      'Wear the proper uniform, bring your ID, be on time, respect teachers and classmates, and follow campus safety reminders. If unsure, ask the Student Affairs office.',
    tags: ['rules', 'student affairs', 'uniform', 'id'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-government-clearance',
    categoryId: 'government',
    question: 'How do I get a barangay clearance?',
    answer:
      'Bring a valid ID, proof of address, and payment if required. Go to the Barangay Hall, fill out the form, submit your documents, and wait for release.',
    tags: ['barangay', 'clearance', 'valid id', 'documents'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-government-nbi-clearance',
    categoryId: 'government',
    question: 'How do I get an NBI clearance?',
    answer:
      'For NBI Clearance, apply online first at clearance.nbi.gov.ph. Create or log in to your account, complete your applicant information, choose your NBI branch and appointment schedule, select a payment option, pay using the generated reference number, then go to your chosen NBI branch on your appointment date for biometrics and printing. Bring two valid government-issued IDs and your reference number or proof of payment. If you get a HIT, follow the release date or verification advice from NBI.',
    tags: ['nbi', 'clearance', 'online appointment', 'biometrics', 'valid id', 'government id'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-government-hours',
    categoryId: 'government',
    question: 'What are the usual office hours?',
    answer:
      'Most government offices are open Monday to Friday, around 8:00 AM to 5:00 PM, except holidays. For urgent needs, check the office hotline or public advisory.',
    tags: ['office hours', 'schedule', 'government'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-place-lost-found',
    categoryId: 'public_places',
    question: 'Where is lost and found?',
    answer:
      'Go to the Information Desk or Security Office. Describe the lost item clearly, show ID if claiming, and leave your contact number for updates.',
    tags: ['lost and found', 'security', 'information desk'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-place-safety',
    categoryId: 'public_places',
    question: 'What should I do during an emergency?',
    answer:
      'Stay calm, move to the nearest safe exit, follow staff or security instructions, and call the local emergency hotline if someone needs urgent help.',
    tags: ['emergency', 'safety', 'exit', 'security'],
    isActive: true,
    updatedAt: now,
  },
  {
    id: 'faq-others-custom',
    categoryId: 'others',
    question: 'Can this app support other institutions?',
    answer:
      'Yes. Admins can add FAQs, public information, announcements, and categories for clinics, offices, events, or community centers.',
    tags: ['custom', 'institution', 'support'],
    isActive: true,
    updatedAt: now,
  },
];

export const defaultPublicInfo: PublicInfo[] = [
  {
    id: 'info-school-enrollment-steps',
    categoryId: 'school',
    title: 'Enrollment Guide',
    body:
      'Start at the Registrar. Submit your requirements, confirm fees or scholarship status, receive your section, then check your class schedule.',
    type: 'procedure',
    tags: ['enrollment', 'guide', 'registrar', 'schedule'],
    requirements: ['Report card', 'Birth certificate', 'Good moral certificate', '2x2 ID photo'],
    locationName: 'Registrar Office',
    updatedAt: now,
  },
  {
    id: 'info-school-offices',
    categoryId: 'school',
    title: 'Common School Offices',
    body:
      'Registrar handles records and enrollment. Cashier handles payments. Guidance supports student concerns. Student Affairs handles IDs, rules, and activities.',
    type: 'location',
    tags: ['office', 'registrar', 'cashier', 'guidance', 'student affairs'],
    locationName: 'Administration Building',
    updatedAt: now,
  },
  {
    id: 'info-government-documents',
    categoryId: 'government',
    title: 'Document Request Flow',
    body:
      'Prepare a valid ID, get the correct form, fill it out clearly, submit at the receiving window, pay only at the official cashier, then keep your claim stub.',
    type: 'procedure',
    tags: ['documents', 'forms', 'cashier', 'claim stub'],
    requirements: ['Valid ID', 'Completed form', 'Proof of address if needed'],
    locationName: 'Public Assistance Desk',
    updatedAt: now,
  },
  {
    id: 'info-government-nbi-clearance',
    categoryId: 'government',
    title: 'NBI Clearance Online Appointment',
    body:
      'Use the official NBI Clearance portal at clearance.nbi.gov.ph. Register or log in, complete your applicant information, apply for clearance, choose an NBI clearance center with an appointment date and time, choose a payment channel, pay using the reference number, then visit the selected branch for photo, fingerprint, signature capture, and clearance printing.',
    type: 'procedure',
    tags: ['nbi', 'clearance', 'online', 'appointment', 'payment', 'biometrics'],
    requirements: ['Two valid government-issued IDs', 'NBI online account', 'Reference number', 'Proof of payment if available'],
    locationName: 'Selected NBI Clearance Center',
    updatedAt: now,
  },
  {
    id: 'info-public-place-directions',
    categoryId: 'public_places',
    title: 'Visitor Direction Helper',
    body:
      'For directions, go to the Information Desk, check the facility map, or ask uniformed security. For accessibility help, request assistance at the nearest entrance.',
    type: 'location',
    tags: ['directions', 'facility', 'information desk', 'accessibility'],
    locationName: 'Information Desk',
    updatedAt: now,
  },
  {
    id: 'info-safety-card',
    categoryId: 'public_places',
    title: 'Emergency Safety Card',
    body:
      'Know the nearest exit, keep walkways clear, report hazards quickly, and follow official staff instructions during drills or real emergencies.',
    type: 'safety',
    tags: ['emergency', 'safety', 'exit', 'hazard'],
    locationName: 'Security Office',
    updatedAt: now,
  },
  {
    id: 'info-others-custom',
    categoryId: 'others',
    title: 'Custom Institution Support',
    body:
      'Use this category for information that does not fit the other modes, like clinic services, event booths, private offices, or community programs.',
    type: 'general',
    tags: ['custom', 'others', 'support'],
    updatedAt: now,
  },
];

export const defaultAnnouncements: Announcement[] = [
  {
    id: 'ann-school-welcome',
    categoryId: 'school',
    title: 'School mode is ready',
    body: 'You can ask about enrollment, requirements, offices, school rules, and class schedule guidance.',
    priority: 'important',
    postedAt: now,
  },
  {
    id: 'ann-safety-reminder',
    categoryId: 'public_places',
    title: 'Safety reminder',
    body: 'Keep exits clear and report hazards to security or the information desk.',
    priority: 'normal',
    postedAt: now,
  },
];

export const defaultFeedback: FeedbackItem[] = [
  {
    id: 'feedback-demo',
    categoryId: 'school',
    message: 'Demo feedback will appear here. Connected Supabase feedback can be reviewed by admins.',
    rating: 5,
    createdAt: now,
  },
];

export const defaultVoicePackages: VoicePackage[] = [
  { id: 'voice-30', label: '30 minutes', pricePesos: 10, minutes: 30, status: 'coming_soon' },
  { id: 'voice-60', label: '1 hour', pricePesos: 20, minutes: 60, status: 'coming_soon' },
  { id: 'voice-180', label: '3 hours', pricePesos: 50, minutes: 180, status: 'coming_soon' },
];
