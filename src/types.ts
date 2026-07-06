export type AssistantStatus = 'idle' | 'listening' | 'thinking' | 'preparing_voice' | 'speaking';

export type Category = {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  isActive: boolean;
};

export type PublicInfo = {
  id: string;
  categoryId: string;
  title: string;
  body: string;
  type: 'procedure' | 'requirements' | 'location' | 'rule' | 'safety' | 'general';
  tags: string[];
  locationName?: string;
  requirements?: string[];
  updatedAt: string;
};

export type FAQ = {
  id: string;
  categoryId: string;
  question: string;
  answer: string;
  tags: string[];
  isActive: boolean;
  updatedAt: string;
};

export type Announcement = {
  id: string;
  categoryId: string;
  title: string;
  body: string;
  priority: 'normal' | 'important' | 'urgent';
  postedAt: string;
};

export type FeedbackItem = {
  id: string;
  categoryId: string;
  message: string;
  rating: number;
  createdAt: string;
};

export type UserProfile = {
  id: string;
  authUserId?: string;
  email?: string;
  displayName: string;
  role: 'student' | 'admin';
  institutionName?: string;
  createdAt: string;
  updatedAt: string;
};

export type ManagedUser = UserProfile & {
  freeSeconds: number;
  purchasedSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};

export type CompanionIntent =
  | 'general'
  | 'guide'
  | 'location'
  | 'requirements'
  | 'announcement'
  | 'safety';

export type VoiceUsage = {
  freeSeconds: number;
  purchasedSeconds: number;
  usedSeconds: number;
};

export type DeviceIdentity = {
  hash: string;
  source: string;
  stableAcrossAppDataClear: boolean;
  stabilityNote?: string;
};

export type VoicePackage = {
  id: string;
  label: string;
  pricePesos: number;
  minutes: number;
  status: 'active' | 'coming_soon';
};
