import { Ionicons } from '@expo/vector-icons';
import {
  AudioModule,
  AudioQuality,
  createAudioPlayer,
  IOSOutputFormat,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import type { Voice as DeviceSpeechVoice } from 'expo-speech';
import { StatusBar } from 'expo-status-bar';
import type { Session, User } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  StatusBar as RNStatusBar,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  defaultAnnouncements,
  defaultCategories,
  defaultFaqs,
  defaultFeedback,
  defaultPublicInfo,
  defaultVoicePackages,
} from './src/data/seed';
import { getCompanionReply } from './src/lib/companionEngine';
import { loadSelectedVoiceId, saveSelectedVoiceId } from './src/lib/localStorage';
import { deleteRecord, supabase, upsertRecord } from './src/lib/supabase';
import {
  assistantVoiceOptions,
  defaultAssistantVoiceId,
  getAssistantVoiceOption,
  synthesizeAssistantSpeech,
  type AssistantVoiceId,
} from './src/lib/ttsService';
import { getPersistentDeviceIdentity } from './src/lib/deviceIdentity';
import { env } from './src/lib/env';
import { transcribeRecording } from './src/lib/voiceService';
import {
  defaultVoiceUsage,
  formatVoiceTime,
  GUEST_FREE_VOICE_SECONDS,
  getOrCreateGuestUserId,
  getRemainingVoiceSeconds,
  loadVoiceUsage,
  MEMBER_FREE_VOICE_SECONDS,
  saveVoiceUsage,
} from './src/lib/voiceTime';
import { APP_SHORT_TITLE, APP_TITLE } from './src/lib/branding';
import type {
  Announcement,
  AssistantStatus,
  Category,
  ChatMessage,
  CompanionIntent,
  DeviceIdentity,
  FAQ,
  FeedbackItem,
  ManagedUser,
  PublicInfo,
  UserProfile,
  VoiceUsage,
} from './src/types';

type IconName = keyof typeof Ionicons.glyphMap;
type ScreenName = 'home' | 'account' | 'admin' | 'feedback';
type AdminSection = 'faqs' | 'info' | 'announcements' | 'categories' | 'feedback' | 'users' | 'smtp';
type UserRole = 'student' | 'admin';
type AuthMode = 'login' | 'signup';
type ThemeMode = 'light' | 'dark';
type AuthDraft = { email: string; password: string; displayName: string };
type VoiceControlState = 'idle' | 'listening' | 'processing' | 'speaking' | 'locked';
type CancelAssistantWorkOptions = {
  discardAssistantMessage?: boolean;
  nextStatus?: AssistantStatus;
};

const createId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const schoolCategoryId = 'school';
const defaultCategory = defaultCategories.find((category) => category.id === schoolCategoryId) ?? defaultCategories[0];
const cloudVoiceStartFallbackMs = 2200;
const voiceRecordingOptions: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.LOW,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 48000,
  },
};

const createIntroMessage = (category: Category): ChatMessage => ({
  id: createId(`assistant-intro-${category.id}`),
  role: 'assistant',
  text: `Hi, I am your ${APP_TITLE}. ${category.name} mode tayo ngayon. Ask me anything, or tap a guide button.`,
  createdAt: new Date().toISOString(),
});

const quickActions: Array<{
  label: string;
  icon: IconName;
  intent: CompanionIntent;
  prompt: (category: Category) => string;
}> = [
  {
    label: 'Guide Me',
    icon: 'footsteps-outline',
    intent: 'guide',
    prompt: (category) => `Guide me step-by-step for the most common ${category.name} process.`,
  },
  {
    label: 'Where should I go?',
    icon: 'navigate-outline',
    intent: 'location',
    prompt: (category) => `Where should I go for ${category.name} help?`,
  },
  {
    label: 'What do I need?',
    icon: 'checkbox-outline',
    intent: 'requirements',
    prompt: (category) => `What do I need for ${category.name} requirements?`,
  },
  {
    label: 'Announcements',
    icon: 'megaphone-outline',
    intent: 'announcement',
    prompt: (category) => `Any announcements for ${category.name}?`,
  },
];

export default function App() {
  const audioRecorder = useAudioRecorder(voiceRecordingOptions);
  const recorderState = useAudioRecorderState(audioRecorder);
  const systemColorScheme = useColorScheme();

  const [screen, setScreen] = useState<ScreenName>('home');
  const [categories, setCategories] = useState<Category[]>(defaultCategories);
  const [selectedCategoryId, setSelectedCategoryId] = useState(schoolCategoryId);
  const [faqs, setFaqs] = useState<FAQ[]>(defaultFaqs);
  const [publicInfo, setPublicInfo] = useState<PublicInfo[]>(defaultPublicInfo);
  const [announcements, setAnnouncements] = useState<Announcement[]>(defaultAnnouncements);
  const [feedback, setFeedback] = useState<FeedbackItem[]>(defaultFeedback);
  const [messages, setMessages] = useState<ChatMessage[]>([createIntroMessage(defaultCategory)]);
  const [input, setInput] = useState('');
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus>('idle');
  const [simpleMode, setSimpleMode] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(systemColorScheme === 'dark' ? 'dark' : 'light');
  const [userRole, setUserRole] = useState<UserRole>('student');
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authDraft, setAuthDraft] = useState({ email: '', password: '', displayName: '' });
  const [authStatus, setAuthStatus] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [adminCode, setAdminCode] = useState('');
  const [recentQuestions, setRecentQuestions] = useState<string[]>([]);
  const [voiceUsage, setVoiceUsage] = useState<VoiceUsage>(defaultVoiceUsage);
  const [selectedVoiceId, setSelectedVoiceId] = useState<AssistantVoiceId>(defaultAssistantVoiceId);
  const [deviceVoices, setDeviceVoices] = useState<DeviceSpeechVoice[]>([]);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceWarningShown, setVoiceWarningShown] = useState(false);
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [voiceUsageSynced, setVoiceUsageSynced] = useState(!supabase);
  const [guestUserId, setGuestUserId] = useState('');
  const [conversationId, setConversationId] = useState(createId('conversation'));
  const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
  const [typedText, setTypedText] = useState('');
  const [adminSection, setAdminSection] = useState<AdminSection>('faqs');
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [userMinuteDrafts, setUserMinuteDrafts] = useState<Record<string, string>>({});
  const [faqDraft, setFaqDraft] = useState({ id: '', question: '', answer: '' });
  const [infoDraft, setInfoDraft] = useState({
    id: '',
    title: '',
    body: '',
    type: 'general' as PublicInfo['type'],
    locationName: '',
    requirements: '',
  });
  const [announcementDraft, setAnnouncementDraft] = useState({ id: '', title: '', body: '' });
  const [categoryDraft, setCategoryDraft] = useState({
    id: '',
    name: '',
    description: '',
    color: '#3B82F6',
    icon: 'sparkles-outline',
  });
  const [feedbackDraft, setFeedbackDraft] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(5);

  const screenProgress = useRef(new Animated.Value(1)).current;
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingReplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsPlayerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  const speechRunIdRef = useRef(0);
  const aiAbortControllerRef = useRef<AbortController | null>(null);
  const transcriptionAbortControllerRef = useRef<AbortController | null>(null);
  const ttsAbortControllerRef = useRef<AbortController | null>(null);
  const recordingRunIdRef = useRef<number | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const voiceStartedAtRef = useRef<number | null>(null);
  const voiceHoldActiveRef = useRef(false);
  const voiceHoldIdRef = useRef(0);
  const voiceStartInFlightRef = useRef(false);
  const voiceRestartRequestedRef = useRef(false);
  const deviceIdentityRef = useRef<DeviceIdentity | null>(null);
  const pendingVoiceUsageSecondsRef = useRef(0);
  const voiceUsageFlushInFlightRef = useRef(false);
  const isDarkMode = themeMode === 'dark';
  const appGradientColors = isDarkMode
    ? (['#07111F', '#0F172A', '#172033'] as const)
    : (['#F7FAFC', '#EEF7F2', '#FFF7ED'] as const);

  const selectedCategory = useMemo(
    () =>
      categories.find((category) => category.id === selectedCategoryId) ??
      categories.find((category) => category.id === schoolCategoryId) ??
      categories[0] ??
      defaultCategories[0],
    [categories, selectedCategoryId],
  );

  const activeAnnouncements = useMemo(
    () =>
      announcements
        .filter((announcement) => announcement.categoryId === selectedCategory.id)
        .sort((left, right) => {
          const priority = { urgent: 3, important: 2, normal: 1 };
          return priority[right.priority] - priority[left.priority];
        }),
    [announcements, selectedCategory.id],
  );

  const safetyInfo = useMemo(
    () =>
      publicInfo.find(
        (info) => info.type === 'safety' && (info.categoryId === selectedCategory.id || info.categoryId === 'public_places'),
      ),
    [publicInfo, selectedCategory.id],
  );

  const remainingVoiceSeconds = getRemainingVoiceSeconds(voiceUsage);
  const isAdmin = userRole === 'admin';
  const voiceNeedsBackendValidation = Boolean(supabase) && !voiceUsageSynced;
  const voiceLocked = !isAdmin && (remainingVoiceSeconds <= 0 || voiceNeedsBackendValidation);
  const supabaseMode = supabase ? 'Connected' : 'Demo';
  const voiceControlState: VoiceControlState =
    voiceLocked
      ? 'locked'
      : voiceActive || recorderState.isRecording
        ? 'listening'
        : assistantStatus === 'thinking' || assistantStatus === 'preparing_voice'
          ? 'processing'
          : assistantStatus === 'speaking'
            ? 'speaking'
            : 'idle';
  const screenAnimatedStyle = {
    opacity: screenProgress,
    transform: [
      {
        translateY: screenProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [12, 0],
        }),
      },
    ],
  };

  useEffect(() => {
    screenProgress.setValue(0);
    Animated.timing(screenProgress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [screen, screenProgress]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = APP_TITLE;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) {
        clearInterval(typingTimerRef.current);
      }
      if (pendingReplyTimerRef.current) {
        clearTimeout(pendingReplyTimerRef.current);
      }
      aiAbortControllerRef.current?.abort();
      transcriptionAbortControllerRef.current?.abort();
      ttsAbortControllerRef.current?.abort();
      ttsPlayerRef.current?.remove();
      stopDeviceSpeechNow();
    };
  }, []);

  useEffect(() => {
    Speech.getAvailableVoicesAsync()
      .then(setDeviceVoices)
      .catch((error) => console.warn('Unable to load device voices:', error));
  }, []);

  useEffect(() => {
    async function boot() {
      const [storedGuestVoiceUsage, nextGuestUserId, storedVoiceId, nextDeviceIdentity] = await Promise.all([
        loadVoiceUsage(),
        getOrCreateGuestUserId(),
        loadSelectedVoiceId(),
        getPersistentDeviceIdentity(),
      ]);

      deviceIdentityRef.current = nextDeviceIdentity;
      setSelectedVoiceId(getAssistantVoiceOption(storedVoiceId ?? defaultAssistantVoiceId).id);
      setGuestUserId(nextGuestUserId);
      setConversationId(`conversation-${nextGuestUserId}`);

      if (supabase) {
        await loadDeviceVoiceUsage(nextDeviceIdentity, null);
        await loadSupabaseContent();
        const { data } = await supabase.auth.getSession();
        await loadAccountFromSession(data.session, nextGuestUserId);
      } else {
        setVoiceUsage({
          freeSeconds: storedGuestVoiceUsage.freeSeconds || GUEST_FREE_VOICE_SECONDS,
          purchasedSeconds: storedGuestVoiceUsage.purchasedSeconds,
          usedSeconds: storedGuestVoiceUsage.usedSeconds,
        });
        setVoiceUsageSynced(true);
      }
    }

    boot();

    if (!supabase) {
      return undefined;
    }

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      getOrCreateGuestUserId()
        .then((nextGuestUserId) => loadAccountFromSession(session, nextGuestUserId))
        .catch((error) => console.warn('Unable to load auth session:', error));
    });

    return () => {
      subscription.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    async function prepareAudio() {
      try {
        const status = await AudioModule.getRecordingPermissionsAsync();
        setMicPermissionGranted(status.granted);
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
      } catch (error) {
        console.warn('Audio setup failed:', error);
      }
    }

    prepareAudio();
  }, []);

  useEffect(() => {
    if (!supabase) {
      saveVoiceUsage(voiceUsage);
    }
  }, [voiceUsage]);

  useEffect(() => {
    if (!voiceActive || isAdmin) {
      return undefined;
    }

    const interval = setInterval(() => {
      setVoiceUsage((current) => {
        const total = current.freeSeconds + current.purchasedSeconds;
        return { ...current, usedSeconds: Math.min(total, current.usedSeconds + 1) };
      });
      pendingVoiceUsageSecondsRef.current += 1;
      if (pendingVoiceUsageSecondsRef.current >= 5) {
        void flushPendingDeviceVoiceUsage();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isAdmin, voiceActive]);

  const loadSupabaseContent = async () => {
    if (!supabase) {
      return;
    }

    const [categoryRows, faqRows, infoRows, announcementRows, feedbackRows] = await Promise.all([
      supabase.from('categories').select('*').order('name'),
      supabase.from('faqs').select('*').order('updated_at', { ascending: false }),
      supabase.from('public_information').select('*').order('updated_at', { ascending: false }),
      supabase.from('announcements').select('*').order('posted_at', { ascending: false }),
      supabase.from('feedback').select('*').order('created_at', { ascending: false }),
    ]);

    if (categoryRows.data?.length) {
      setCategories(
        categoryRows.data.map((row) => ({
          id: String(row.id),
          key: String(row.key ?? row.id),
          name: String(row.name),
          description: String(row.description ?? ''),
          color: String(row.color ?? '#3B82F6'),
          icon: String(row.icon ?? 'sparkles-outline'),
          isActive: Boolean(row.is_active ?? true),
        })),
      );
    }

    if (faqRows.data?.length) {
      setFaqs(
        faqRows.data.map((row) => ({
          id: String(row.id),
          categoryId: String(row.category_id),
          question: String(row.question),
          answer: String(row.answer),
          tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
          isActive: Boolean(row.is_active ?? true),
          updatedAt: String(row.updated_at ?? new Date().toISOString()),
        })),
      );
    }

    if (infoRows.data?.length) {
      setPublicInfo(
        infoRows.data.map((row) => ({
          id: String(row.id),
          categoryId: String(row.category_id),
          title: String(row.title),
          body: String(row.body),
          type: String(row.info_type ?? 'general') as PublicInfo['type'],
          tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
          locationName: row.location_name ? String(row.location_name) : undefined,
          requirements: Array.isArray(row.requirements) ? row.requirements.map(String) : undefined,
          updatedAt: String(row.updated_at ?? new Date().toISOString()),
        })),
      );
    }

    if (announcementRows.data?.length) {
      setAnnouncements(
        announcementRows.data.map((row) => ({
          id: String(row.id),
          categoryId: String(row.category_id),
          title: String(row.title),
          body: String(row.body),
          priority: String(row.priority ?? 'normal') as Announcement['priority'],
          postedAt: String(row.posted_at ?? new Date().toISOString()),
        })),
      );
    }

    if (feedbackRows.data?.length) {
      setFeedback(
        feedbackRows.data.map((row) => ({
          id: String(row.id),
          categoryId: String(row.category_id),
          message: String(row.message),
          rating: Number(row.rating ?? 5),
          createdAt: String(row.created_at ?? new Date().toISOString()),
        })),
      );
    }
  };

  async function loadAccountFromSession(session: Session | null, fallbackGuestUserId: string) {
    setAuthSession(session);

    if (!supabase || !session?.user) {
      setUserProfile(null);
      setUserRole('student');
      setRecentQuestions([]);
      setGuestUserId(fallbackGuestUserId);
      setConversationId(`conversation-${fallbackGuestUserId}`);
      await loadDeviceVoiceUsage(deviceIdentityRef.current, null);
      return;
    }

    if (!isEmailConfirmed(session.user)) {
      setUserProfile(null);
      setUserRole('student');
      setRecentQuestions([]);
      setAuthStatus('Please verify your email before using the logged-in account.');
      setGuestUserId(fallbackGuestUserId);
      setConversationId(`conversation-${fallbackGuestUserId}`);
      await loadDeviceVoiceUsage(deviceIdentityRef.current, null);
      return;
    }

    const profile = await ensureUserProfile(session.user);
    if (!profile) {
      return;
    }

    setUserProfile(profile);
    setUserRole(profile.role);
    setGuestUserId(profile.id);
    setConversationId(`conversation-${profile.id}`);
    await Promise.all([
      loadRecentQuestionsForProfile(profile),
      profile.role === 'admin'
        ? Promise.resolve(setVoiceUsage({ freeSeconds: 0, purchasedSeconds: 0, usedSeconds: 0 }))
        : loadDeviceVoiceUsage(deviceIdentityRef.current, profile.id),
    ]);

    if (profile.role === 'admin') {
      await loadManagedUsers();
    }
  }

  async function ensureUserProfile(user: User): Promise<UserProfile | null> {
    if (!supabase) {
      return null;
    }

    const displayName =
      typeof user.user_metadata?.display_name === 'string' && user.user_metadata.display_name.trim()
        ? user.user_metadata.display_name.trim()
        : user.email?.split('@')[0] || 'Student';

    const { data: existingProfile, error: findError } = await supabase
      .from('users')
      .select('*')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (findError) {
      console.warn('Unable to find user profile:', findError.message);
      setAuthStatus('Profile setup failed. Ask an admin to check Supabase policies.');
      return null;
    }

    if (existingProfile) {
      return updateExistingUserProfile(existingProfile, displayName, user.email ?? '');
    }

    const payload = {
      id: user.id,
      auth_user_id: user.id,
      email: user.email ?? '',
      display_name: displayName,
      role: 'student',
      institution_name: APP_TITLE,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('users')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      if (isDuplicateProfileError(error)) {
        const recoveredProfile = await recoverExistingUserProfile(user, displayName);
        if (recoveredProfile) {
          return recoveredProfile;
        }
      }

      console.warn('Unable to create/load user profile:', error.message);
      setAuthStatus('Profile setup failed. Ask an admin to check Supabase policies.');
      return null;
    }

    return mapUserProfile(data);
  }

  async function updateExistingUserProfile(
    existingProfile: Record<string, unknown>,
    displayName: string,
    email: string,
  ): Promise<UserProfile> {
    if (!supabase) {
      return mapUserProfile(existingProfile);
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        email,
        display_name: displayName,
        institution_name: existingProfile.institution_name ?? APP_TITLE,
        updated_at: new Date().toISOString(),
      })
      .eq('id', String(existingProfile.id))
      .select('*')
      .single();

    if (error) {
      console.warn('Unable to update user profile:', error.message);
      return mapUserProfile(existingProfile);
    }

    return mapUserProfile(data);
  }

  async function recoverExistingUserProfile(user: User, displayName: string): Promise<UserProfile | null> {
    if (!supabase) {
      return null;
    }

    const { data: updatedProfile, error: updateError } = await supabase
      .from('users')
      .update({
        email: user.email ?? '',
        display_name: displayName,
        updated_at: new Date().toISOString(),
      })
      .eq('auth_user_id', user.id)
      .select('*')
      .maybeSingle();

    if (updatedProfile) {
      return mapUserProfile(updatedProfile);
    }

    const { data: existingProfile, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (existingProfile) {
      return mapUserProfile(existingProfile);
    }

    console.warn(
      'User profile exists but could not be read. Run the latest supabase/schema.sql policies.',
      updateError?.message ?? selectError?.message ?? 'No visible profile row.',
    );
    setAuthStatus('Your profile exists, but Supabase policies are out of date. Run the latest supabase/schema.sql.');
    return null;
  }

  async function loadRecentQuestionsForProfile(profile: UserProfile) {
    if (!supabase) {
      setRecentQuestions([]);
      return;
    }

    const { data, error } = await supabase
      .from('recent_questions')
      .select('question')
      .eq('user_id', profile.id)
      .order('updated_at', { ascending: false })
      .limit(6);

    if (error) {
      console.warn('Unable to load recent questions:', error.message);
      setRecentQuestions([]);
      return;
    }

    setRecentQuestions((data ?? []).map((row) => String(row.question)).filter(Boolean));
  }

  async function ensureDeviceIdentity() {
    if (deviceIdentityRef.current) {
      return deviceIdentityRef.current;
    }

    const nextIdentity = await getPersistentDeviceIdentity();
    deviceIdentityRef.current = nextIdentity;
    return nextIdentity;
  }

  async function loadDeviceVoiceUsage(identity: DeviceIdentity | null, userId: string | null): Promise<VoiceUsage | null> {
    if (!supabase) {
      const localUsage = await loadVoiceUsage();
      const nextUsage = {
        freeSeconds: localUsage.freeSeconds || GUEST_FREE_VOICE_SECONDS,
        purchasedSeconds: localUsage.purchasedSeconds,
        usedSeconds: localUsage.usedSeconds,
      };
      setVoiceUsage(nextUsage);
      setVoiceUsageSynced(true);
      return nextUsage;
    }

    if (!identity) {
      setVoiceUsageSynced(false);
      setVoiceUsage({ freeSeconds: GUEST_FREE_VOICE_SECONDS, purchasedSeconds: 0, usedSeconds: GUEST_FREE_VOICE_SECONDS });
      return null;
    }

    const { data, error } = await supabase.rpc('get_or_create_device_voice_usage', {
      p_device_hash: identity.hash,
      p_device_source: identity.source,
      p_user_id: userId,
    });

    if (error) {
      console.warn('Unable to validate device voice usage:', error.message);
      setVoiceUsageSynced(false);
      setVoiceUsage({ freeSeconds: GUEST_FREE_VOICE_SECONDS, purchasedSeconds: 0, usedSeconds: GUEST_FREE_VOICE_SECONDS });
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const nextUsage = mapVoiceUsageRow(row);
    setVoiceUsage(nextUsage);
    setVoiceUsageSynced(true);
    return nextUsage;
  }

  async function flushPendingDeviceVoiceUsage(force = false) {
    const seconds = Math.floor(pendingVoiceUsageSecondsRef.current);
    if (seconds <= 0 || (!force && seconds < 5) || isAdmin || voiceUsageFlushInFlightRef.current) {
      return;
    }

    if (!supabase) {
      pendingVoiceUsageSecondsRef.current = Math.max(0, pendingVoiceUsageSecondsRef.current - seconds);
      return;
    }

    const identity = deviceIdentityRef.current;
    if (!identity) {
      setVoiceUsageSynced(false);
      return;
    }

    pendingVoiceUsageSecondsRef.current = Math.max(0, pendingVoiceUsageSecondsRef.current - seconds);
    voiceUsageFlushInFlightRef.current = true;

    const { data, error } = await supabase.rpc('consume_device_voice_seconds', {
      p_device_hash: identity.hash,
      p_seconds: seconds,
      p_user_id: userProfile?.id ?? null,
    });

    voiceUsageFlushInFlightRef.current = false;

    if (error) {
      pendingVoiceUsageSecondsRef.current += seconds;
      setVoiceUsageSynced(false);
      console.warn('Unable to save device voice usage:', error.message);
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    setVoiceUsage(mapVoiceUsageRow(row));
    setVoiceUsageSynced(true);
  }

  async function loadManagedUsers() {
    if (!supabase) {
      return;
    }

    const [{ data: userRows, error: usersError }, { data: usageRows, error: usageError }] = await Promise.all([
      supabase.from('users').select('*').order('created_at', { ascending: false }),
      supabase.from('voice_usage').select('*'),
    ]);

    if (usersError) {
      console.warn('Unable to load users:', usersError.message);
      return;
    }

    if (usageError) {
      console.warn('Unable to load voice usage:', usageError.message);
    }

    const usageByUser = new Map((usageRows ?? []).map((row) => [String(row.user_id), row]));
    setManagedUsers(
      (userRows ?? []).map((row) => {
        const profile = mapUserProfile(row);
        const usage = usageByUser.get(profile.id);
        const freeSeconds = Number(usage?.free_seconds ?? (profile.role === 'admin' ? 0 : MEMBER_FREE_VOICE_SECONDS));
        const purchasedSeconds = Number(usage?.purchased_seconds ?? 0);
        const usedSeconds = Number(usage?.used_seconds ?? 0);

        return {
          ...profile,
          freeSeconds,
          purchasedSeconds,
          usedSeconds,
          remainingSeconds:
            profile.role === 'admin'
              ? Number.POSITIVE_INFINITY
              : Math.max(0, freeSeconds + purchasedSeconds - usedSeconds),
        };
      }),
    );
  }

  const persistMessage = useCallback(
    async (message: ChatMessage, title?: string) => {
      if (!guestUserId || !userProfile) {
        return;
      }

      await upsertRecord('conversations', {
        id: conversationId,
        user_id: guestUserId,
        category_id: selectedCategory.id,
        title: title ?? 'Public assistance chat',
        updated_at: new Date().toISOString(),
      });

      await upsertRecord('messages', {
        id: message.id,
        conversation_id: conversationId,
        role: message.role,
        content: message.text,
        created_at: message.createdAt,
      });
    },
    [conversationId, guestUserId, selectedCategory.id, userProfile],
  );

  const stopAssistantPlayback = useCallback(() => {
    const player = ttsPlayerRef.current;
    ttsPlayerRef.current = null;

    // Pause before remove so audio hardware stops output immediately,
    // not just after the buffer drains (~100-300ms on some devices).
    try {
      if (player) {
        player.volume = 0;
        player.pause();
      }
    } catch {
      // pause() may throw if the player is already in a terminal state
    }
    try {
      player?.remove();
    } catch {
      // remove() may throw if another cancellation already released it
    }
    stopDeviceSpeechNow();
  }, []);

  const cancelAssistantWork = useCallback(
    (options: CancelAssistantWorkOptions = {}) => {
      speechRunIdRef.current += 1;

      aiAbortControllerRef.current?.abort();
      transcriptionAbortControllerRef.current?.abort();
      ttsAbortControllerRef.current?.abort();
      aiAbortControllerRef.current = null;
      transcriptionAbortControllerRef.current = null;
      ttsAbortControllerRef.current = null;

      if (pendingReplyTimerRef.current) {
        clearTimeout(pendingReplyTimerRef.current);
        pendingReplyTimerRef.current = null;
      }

      if (typingTimerRef.current) {
        clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }

      stopAssistantPlayback();
      setTypingMessageId(null);
      setTypedText('');

      if (options.discardAssistantMessage && activeAssistantMessageIdRef.current) {
        const activeMessageId = activeAssistantMessageIdRef.current;
        setMessages((current) => current.filter((message) => message.id !== activeMessageId));
      }

      activeAssistantMessageIdRef.current = null;
      setAssistantStatus(options.nextStatus ?? 'idle');
    },
    [stopAssistantPlayback],
  );

  const handleSelectCategory = useCallback(
    (categoryId: string) => {
      if (categoryId === selectedCategoryId) {
        return;
      }

      const nextCategory =
        categories.find((category) => category.id === categoryId) ??
        categories.find((category) => category.id === schoolCategoryId) ??
        defaultCategory;

      cancelAssistantWork({ discardAssistantMessage: true });
      setInput('');
      setMessages([createIntroMessage(nextCategory)]);
      setConversationId(createId(`conversation-${categoryId}`));
      setSelectedCategoryId(categoryId);
      Haptics.selectionAsync();
    },
    [cancelAssistantWork, categories, selectedCategoryId],
  );

  const rememberQuestion = useCallback(async (question: string) => {
    if (!userProfile) {
      setRecentQuestions([]);
      return;
    }

    const normalizedQuestion = normalizeRecentQuestion(question);
    const next = [
      question,
      ...recentQuestions.filter((item) => normalizeRecentQuestion(item) !== normalizedQuestion),
    ].slice(0, 6);
    setRecentQuestions(next);

    if (!supabase || !normalizedQuestion) {
      return;
    }

    const { error } = await supabase
      .from('recent_questions')
      .upsert(
        {
          user_id: userProfile.id,
          question,
          normalized_question: normalizedQuestion,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,normalized_question' },
      );

    if (error) {
      console.warn('Unable to save recent question:', error.message);
      return;
    }

    const { data: staleRows, error: staleError } = await supabase
      .from('recent_questions')
      .select('id')
      .eq('user_id', userProfile.id)
      .order('updated_at', { ascending: false })
      .range(6, 50);

    if (staleError) {
      console.warn('Unable to trim recent questions:', staleError.message);
      return;
    }

    const staleIds = (staleRows ?? []).map((row) => String(row.id));
    if (staleIds.length) {
      await supabase.from('recent_questions').delete().eq('user_id', userProfile.id).in('id', staleIds);
    }
  }, [recentQuestions, userProfile]);

  const handleSelectAssistantVoice = useCallback((voiceId: AssistantVoiceId) => {
    setSelectedVoiceId(voiceId);
    saveSelectedVoiceId(voiceId);
    Haptics.selectionAsync();
  }, []);

  const speakWithDeviceVoice = useCallback(
    (replyText: string, voiceId = selectedVoiceId, runId = speechRunIdRef.current) => {
      const selectedVoice = getAssistantVoiceOption(voiceId);
      const deviceVoice = findDeviceVoice(deviceVoices, selectedVoice.language);
      const spokenText = cleanSpokenReplyText(replyText);
      const finishCurrentSpeech = () => {
        if (speechRunIdRef.current !== runId) {
          return;
        }

        activeAssistantMessageIdRef.current = null;
        setAssistantStatus('idle');
      };

      void stopDeviceSpeechQueue().then(() => {
        if (speechRunIdRef.current !== runId) {
          return;
        }

        setAssistantStatus('speaking');
        Speech.speak(spokenText, {
          language: selectedVoice.language,
          voice: deviceVoice?.identifier,
          pitch: selectedVoice.pitch,
          rate: selectedVoice.rate,
          onStart: () => {
            if (speechRunIdRef.current === runId) {
              setAssistantStatus('speaking');
            }
          },
          onDone: finishCurrentSpeech,
          onStopped: finishCurrentSpeech,
          onError: finishCurrentSpeech,
        });
      });
    },
    [deviceVoices, selectedVoiceId],
  );

  const playGeneratedAudio = useCallback(
    (audioUri: string, runId: number) =>
      new Promise<void>((resolve) => {
        if (speechRunIdRef.current !== runId) {
          resolve();
          return;
        }

        const player = createAudioPlayer({ uri: audioUri }, { updateInterval: 200 });
        ttsPlayerRef.current = player;

        let done = false;
        let subscription: { remove: () => void } | null = null;

        // Fast poll (40 ms) so cancellation is detected almost immediately.
        // Also watches for external removal via ttsPlayerRef becoming null/different.
        const cancelPoll = setInterval(() => {
          if (speechRunIdRef.current !== runId || ttsPlayerRef.current !== player) {
            finish();
          }
        }, 40);

        const finish = () => {
          if (done) {
            return;
          }

          done = true;
          clearInterval(cancelPoll);
          subscription?.remove();
          try {
            player.pause();
          } catch {
            // ignore – player may already be dead
          }
          try {
            player.remove();
          } catch {
            // ignore – stopAssistantPlayback may have already released it
          }
          if (ttsPlayerRef.current === player) {
            ttsPlayerRef.current = null;
          }
          resolve();
        };

        subscription = player.addListener('playbackStatusUpdate', (status) => {
          if (status.didJustFinish) {
            finish();
          }
        });

        setAssistantStatus('speaking');
        player.play();
      }),
    [],
  );

  const speakAssistantText = useCallback(
    async (replyText: string, runId = speechRunIdRef.current) => {
      const selectedVoice = getAssistantVoiceOption(selectedVoiceId);
      const spokenText = cleanSpokenReplyText(replyText);

      stopAssistantPlayback();
      ttsAbortControllerRef.current?.abort();

      if (selectedVoice.provider === 'device') {
        ttsAbortControllerRef.current = null;
        speakWithDeviceVoice(spokenText, selectedVoice.id, runId);
        return;
      }

      const ttsAbortController = new AbortController();
      ttsAbortControllerRef.current = ttsAbortController;

      try {
        setAssistantStatus('preparing_voice');
        const chunks = splitSpokenReplyIntoChunks(spokenText);
        const synthesizeChunk = async (chunk: string) => {
          try {
            return {
              audioUri: await synthesizeAssistantSpeech(chunk, selectedVoice, { signal: ttsAbortController.signal }),
              cancelled: false,
              error: null,
              timedOut: false,
            };
          } catch (error) {
            if (isAbortError(error) || speechRunIdRef.current !== runId || ttsAbortController.signal.aborted) {
              return { audioUri: null, cancelled: true, error: null, timedOut: false };
            }

            return { audioUri: null, cancelled: false, error, timedOut: false };
          }
        };
        const waitForCloudVoiceStartFallback = () =>
          new Promise<{ audioUri: null; cancelled: false; error: null; timedOut: true }>((resolve) => {
            setTimeout(() => {
              resolve({ audioUri: null, cancelled: false, error: null, timedOut: true });
            }, cloudVoiceStartFallbackMs);
          });
        let nextAudio = chunks[0]
          ? synthesizeChunk(chunks[0])
          : null;

        for (let index = 0; index < chunks.length; index += 1) {
          if (!nextAudio || speechRunIdRef.current !== runId || ttsAbortController.signal.aborted) {
            return;
          }

          const audioResult = index === 0
            ? await Promise.race([nextAudio, waitForCloudVoiceStartFallback()])
            : await nextAudio;
          if (audioResult.timedOut) {
            ttsAbortController.abort();
            if (speechRunIdRef.current === runId) {
              speakWithDeviceVoice(spokenText, 'device-filipino', runId);
            }
            return;
          }
          if (audioResult.cancelled) {
            return;
          }
          if (audioResult.error) {
            throw audioResult.error;
          }
          if (!audioResult.audioUri) {
            return;
          }

          // Guard again: synthesis may have just finished as the abort signal fired.
          if (speechRunIdRef.current !== runId || ttsAbortController.signal.aborted) {
            return;
          }

          nextAudio = chunks[index + 1]
            ? synthesizeChunk(chunks[index + 1])
            : null;

          await playGeneratedAudio(audioResult.audioUri, runId);
        }

        if (speechRunIdRef.current === runId) {
          activeAssistantMessageIdRef.current = null;
          setAssistantStatus('idle');
        }
      } catch (error) {
        if (isAbortError(error) || speechRunIdRef.current !== runId) {
          return;
        }

        console.warn('ElevenLabs TTS failed, using device voice:', error);
        speakWithDeviceVoice(spokenText, 'device-filipino', runId);
      } finally {
        if (ttsAbortControllerRef.current === ttsAbortController) {
          ttsAbortControllerRef.current = null;
        }
      }
    },
    [playGeneratedAudio, selectedVoiceId, speakWithDeviceVoice, stopAssistantPlayback],
  );

  const playAssistantReply = useCallback(
    (replyText: string, runId = speechRunIdRef.current) => {
      if (speechRunIdRef.current !== runId) {
        return;
      }

      const message: ChatMessage = {
        id: createId('assistant'),
        role: 'assistant',
        text: replyText,
        createdAt: new Date().toISOString(),
      };

      setMessages((current) => [...current, message]);
      persistMessage(message);
      activeAssistantMessageIdRef.current = message.id;
      setTypingMessageId(message.id);
      setTypedText('');
      setAssistantStatus('preparing_voice');

      if (typingTimerRef.current) {
        clearInterval(typingTimerRef.current);
      }

      let index = 0;
      typingTimerRef.current = setInterval(() => {
        index += 2;
        setTypedText(replyText.slice(0, index));

        if (index >= replyText.length && typingTimerRef.current) {
          clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
          setTypingMessageId(null);
        }
      }, 18);

      void speakAssistantText(replyText, runId).catch((error) => {
        if (isAbortError(error) || speechRunIdRef.current !== runId) {
          return;
        }

        console.warn('Assistant speech failed:', error);
        setAssistantStatus('idle');
      });
    },
    [persistMessage, speakAssistantText],
  );

  const submitQuestion = useCallback(
    async (question: string, intent: CompanionIntent = 'general', fromVoice = false) => {
      const cleanQuestion = question.trim();
      if (!cleanQuestion) {
        return;
      }

      cancelAssistantWork({ discardAssistantMessage: true, nextStatus: 'thinking' });
      const runId = speechRunIdRef.current;
      const aiAbortController = new AbortController();
      aiAbortControllerRef.current = aiAbortController;

      Haptics.selectionAsync();
      setInput('');
      setAssistantStatus('thinking');
      void rememberQuestion(cleanQuestion);

      const userMessage: ChatMessage = {
        id: createId(fromVoice ? 'voice-user' : 'user'),
        role: 'user',
        text: cleanQuestion,
        createdAt: new Date().toISOString(),
      };

      setMessages((current) => [...current, userMessage]);
      persistMessage(userMessage, cleanQuestion.slice(0, 64));

      try {
        const reply = await getCompanionReply({
          question: cleanQuestion,
          categoryId: selectedCategory.id,
          categories,
          faqs,
          publicInfo,
          simpleMode,
          intent,
          signal: aiAbortController.signal,
        });

        if (speechRunIdRef.current !== runId || aiAbortController.signal.aborted) {
          return;
        }

        playAssistantReply(reply.text, runId);
      } catch (error) {
        if (isAbortError(error) || speechRunIdRef.current !== runId) {
          return;
        }

        console.warn('Assistant request failed:', error);
        setAssistantStatus('idle');
        Alert.alert('Assistant unavailable', 'Please try asking again.');
      } finally {
        if (aiAbortControllerRef.current === aiAbortController) {
          aiAbortControllerRef.current = null;
        }
      }
    },
    [
      cancelAssistantWork,
      categories,
      faqs,
      persistMessage,
      playAssistantReply,
      publicInfo,
      rememberQuestion,
      selectedCategory.id,
      simpleMode,
    ],
  );

  const handleQuickAction = (intent: CompanionIntent, prompt: string) => {
    submitQuestion(prompt, intent);
  };

  const requestMicPermission = useCallback(async () => {
    const currentStatus = await AudioModule.getRecordingPermissionsAsync();
    if (currentStatus.granted) {
      setMicPermissionGranted(true);
      return true;
    }

    const status = await AudioModule.requestRecordingPermissionsAsync();
    setMicPermissionGranted(status.granted);
    return status.granted;
  }, []);

  const startVoice = useCallback(async () => {
    if (voiceActive || audioRecorder.isRecording) {
      return;
    }

    if (voiceStartInFlightRef.current) {
      voiceRestartRequestedRef.current = true;
      stopAssistantPlayback();
      setAssistantStatus('listening');
      return;
    }

    const holdId = voiceHoldIdRef.current;
    voiceStartInFlightRef.current = true;

    // ── 1. Immediately show visual feedback so the user sees the interrupt ──
    setAssistantStatus('listening');

    // ── 2. Stop ALL audio (TTS player + device speech) synchronously ──
    cancelAssistantWork({ discardAssistantMessage: true, nextStatus: 'listening' });
    stopDeviceSpeechNow();
    const runId = speechRunIdRef.current;
    const isCurrentHold = () => voiceHoldActiveRef.current && voiceHoldIdRef.current === holdId;

    try {
      if (!isAdmin) {
        const activeDeviceIdentity = await ensureDeviceIdentity();
        const deviceUsage = await loadDeviceVoiceUsage(activeDeviceIdentity, userProfile?.id ?? null);

        if (!isCurrentHold() || speechRunIdRef.current !== runId) {
          if (speechRunIdRef.current === runId) {
            setAssistantStatus('idle');
          }
          return;
        }

        if (!deviceUsage || getRemainingVoiceSeconds(deviceUsage) <= 0) {
          Alert.alert('Voice assistance locked', 'This device has used its free voice time. Text chat is still free and usable.');
          if (speechRunIdRef.current === runId) {
            setAssistantStatus('idle');
          }
          return;
        }

        if (!activeDeviceIdentity.stableAcrossAppDataClear) {
          console.warn(`Device voice limit is using a weaker fallback ID: ${activeDeviceIdentity.stabilityNote ?? activeDeviceIdentity.source}`);
        }
      }

      const allowed = micPermissionGranted || (await requestMicPermission());
      if (!allowed) {
        Alert.alert('Microphone needed', 'Please allow microphone access to use voice assistance.');
        if (speechRunIdRef.current === runId) {
          setAssistantStatus('idle');
        }
        return;
      }

      if (!isCurrentHold() || speechRunIdRef.current !== runId) {
        if (speechRunIdRef.current === runId) {
          setAssistantStatus('idle');
        }
        return;
      }

      // ── 3. Let audio hardware fully settle before opening the mic ──
      // Without this, the recorder may pick up the last frames of AI audio.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      if (!isCurrentHold() || speechRunIdRef.current !== runId) {
        if (speechRunIdRef.current === runId) {
          setAssistantStatus('idle');
        }
        return;
      }

      recordingRunIdRef.current = runId;
      if (!audioRecorder.getStatus().canRecord) {
        try {
          await audioRecorder.prepareToRecordAsync();
        } catch (error) {
          const preparedAfterRace = isAudioRecorderAlreadyPreparedError(error) && audioRecorder.getStatus().canRecord;
          if (!preparedAfterRace) {
            throw error;
          }
        }
      }

      if (!isCurrentHold() || speechRunIdRef.current !== runId) {
        recordingRunIdRef.current = null;
        if (speechRunIdRef.current === runId) {
          setAssistantStatus('idle');
        }
        return;
      }

      audioRecorder.record();
      if (!isCurrentHold() || speechRunIdRef.current !== runId) {
        await audioRecorder.stop().catch(() => undefined);
        recordingRunIdRef.current = null;
        if (speechRunIdRef.current === runId) {
          setAssistantStatus('idle');
        }
        return;
      }

      voiceStartedAtRef.current = Date.now();
      setVoiceActive(true);
      setAssistantStatus('listening');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      console.warn('Unable to start recording:', error);
      recordingRunIdRef.current = null;
      if (speechRunIdRef.current === runId) {
        setAssistantStatus('idle');
      }
      Alert.alert('Voice unavailable', 'Voice recording could not start on this device.');
    } finally {
      voiceStartInFlightRef.current = false;
      const shouldRestartVoiceStart =
        voiceRestartRequestedRef.current &&
        voiceHoldActiveRef.current &&
        voiceHoldIdRef.current !== holdId &&
        !audioRecorder.isRecording;

      voiceRestartRequestedRef.current = false;
      if (shouldRestartVoiceStart) {
        void startVoice();
      }
    }
  }, [
    audioRecorder,
    cancelAssistantWork,
    isAdmin,
    micPermissionGranted,
    requestMicPermission,
    stopAssistantPlayback,
    userProfile?.id,
    voiceActive,
  ]);

  const stopVoice = useCallback(async () => {
    voiceHoldActiveRef.current = false;

    if (!voiceActive && !audioRecorder.isRecording) {
      return;
    }

    const runId = recordingRunIdRef.current ?? speechRunIdRef.current;
    const recordedSeconds = voiceStartedAtRef.current
      ? (Date.now() - voiceStartedAtRef.current) / 1000
      : audioRecorder.currentTime;

    try {
      await audioRecorder.stop();
    } catch (error) {
      console.warn('Unable to stop recording:', error);
    }

    voiceStartedAtRef.current = null;
    recordingRunIdRef.current = null;
    setVoiceActive(false);
    if (speechRunIdRef.current === runId) {
      setAssistantStatus('thinking');
    }
    void flushPendingDeviceVoiceUsage(true);

    if (speechRunIdRef.current !== runId) {
      return;
    }

    if (recordedSeconds < 1.2) {
      setAssistantStatus('idle');
      Alert.alert('No speech detected', 'Try again with a slightly longer voice note.');
      return;
    }

    const transcriptionAbortController = new AbortController();
    transcriptionAbortControllerRef.current = transcriptionAbortController;

    try {
      const transcript = audioRecorder.uri
        ? await transcribeRecording(audioRecorder.uri, { signal: transcriptionAbortController.signal })
        : null;

      if (speechRunIdRef.current !== runId || transcriptionAbortController.signal.aborted) {
        return;
      }

      if (transcript && !isLikelyVoiceHallucination(transcript, recordedSeconds)) {
        submitQuestion(transcript, 'general', true);
        return;
      }

      setAssistantStatus('idle');
      Alert.alert('No speech detected', 'No clear question was detected. Please try again.');
    } catch (error) {
      if (isAbortError(error) || speechRunIdRef.current !== runId) {
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : 'Voice transcription is not available yet.';

      setAssistantStatus('idle');
      Alert.alert('Voice transcription failed', message);
    } finally {
      if (transcriptionAbortControllerRef.current === transcriptionAbortController) {
        transcriptionAbortControllerRef.current = null;
      }
    }
  }, [audioRecorder, submitQuestion, voiceActive]);

  const handleVoiceHoldStart = () => {
    voiceHoldActiveRef.current = true;
    voiceHoldIdRef.current += 1;
    startVoice();
  };

  const handleVoiceHoldEnd = () => {
    voiceHoldActiveRef.current = false;
    stopVoice();
  };

  useEffect(() => {
    if (isAdmin) {
      return;
    }

    if (remainingVoiceSeconds <= 30 && remainingVoiceSeconds > 0 && !voiceWarningShown) {
      setVoiceWarningShown(true);
      Alert.alert('Voice time warning', 'You only have 30 seconds of voice assistance left on this device.');
    }

    if (remainingVoiceSeconds <= 0 && voiceActive) {
      stopVoice();
      return;
    }

    if (voiceNeedsBackendValidation && voiceActive) {
      stopVoice();
    }
  }, [isAdmin, remainingVoiceSeconds, stopVoice, voiceActive, voiceNeedsBackendValidation, voiceWarningShown]);

  const showPaymentPending = () => {
    Alert.alert(
      'Payment Pending',
      'Payment gateway is not available yet. This feature is coming soon.',
    );
  };

  const requireAdmin = () => {
    if (isAdmin) {
      return true;
    }

    Alert.alert('Admin only', 'Log in with an admin account to manage users, FAQs, public info, announcements, and categories.');
    setScreen('account');
    return false;
  };

  const unlockAdmin = () => {
    const expectedCode = env.adminAccessCode.trim();
    if (!expectedCode) {
      Alert.alert('Admin setup needed', 'Admin access code is not configured.');
      return;
    }

    if (adminCode.trim() !== expectedCode) {
      Alert.alert('Incorrect code', 'Please enter the admin access code.');
      return;
    }

    setUserRole('admin');
    setAdminCode('');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const lockAdmin = () => {
    setUserRole('student');
    setAdminCode('');
    setScreen('home');
    Haptics.selectionAsync();
  };

  const submitAuth = async () => {
    if (!supabase) {
      Alert.alert('Supabase needed', 'Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to use login.');
      return;
    }

    const email = authDraft.email.trim().toLowerCase();
    const password = authDraft.password;

    if (!email || !password || (authMode === 'signup' && !authDraft.displayName.trim())) {
      Alert.alert('Missing details', authMode === 'signup' ? 'Add name, email, and password.' : 'Add email and password.');
      return;
    }

    setAuthBusy(true);
    setAuthStatus('');

    try {
      if (authMode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              display_name: authDraft.displayName.trim(),
            },
          },
        });

        if (error) {
          throw error;
        }

        setAuthStatus('Verification email sent. Open your inbox, confirm your email, then log in.');
        Alert.alert('Verify your email', 'We sent a confirmation link. Confirm your email before logging in.');
        setAuthMode('login');
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        throw error;
      }

      if (!data.user || !isEmailConfirmed(data.user)) {
        await supabase.auth.signOut();
        setAuthStatus('Email is not verified yet. Please check your inbox and confirm your account.');
        return;
      }

      await loadAccountFromSession(data.session, guestUserId || (await getOrCreateGuestUserId()));
      setAuthDraft({ email: '', password: '', displayName: '' });
      setAuthStatus('Logged in successfully.');
      setScreen('home');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed.';
      setAuthStatus(message);
      Alert.alert('Login failed', message);
    } finally {
      setAuthBusy(false);
    }
  };

  const resendVerification = async () => {
    if (!supabase) {
      return;
    }

    const email = authDraft.email.trim().toLowerCase();
    if (!email) {
      Alert.alert('Email needed', 'Enter your email first.');
      return;
    }

    const { error } = await supabase.auth.resend({ type: 'signup', email });
    if (error) {
      setAuthStatus(error.message);
      Alert.alert('Could not resend', error.message);
      return;
    }

    setAuthStatus('Verification email resent.');
  };

  const signOut = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }

    const nextGuestUserId = await getOrCreateGuestUserId();
    const guestUsage = await loadVoiceUsage();
    setAuthSession(null);
    setUserProfile(null);
    setUserRole('student');
    setRecentQuestions([]);
    setGuestUserId(nextGuestUserId);
    setConversationId(`conversation-${nextGuestUserId}`);
    if (supabase) {
      await loadDeviceVoiceUsage(deviceIdentityRef.current, null);
    } else {
      setVoiceUsage({
        freeSeconds: guestUsage.freeSeconds || GUEST_FREE_VOICE_SECONDS,
        purchasedSeconds: guestUsage.purchasedSeconds,
        usedSeconds: guestUsage.usedSeconds,
      });
    }
    setScreen('home');
  };

  const addMinutesToUser = async (userId: string) => {
    if (!requireAdmin() || !supabase) {
      return;
    }

    const minutes = Number(userMinuteDrafts[userId]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      Alert.alert('Minutes needed', 'Enter a positive number of minutes to add.');
      return;
    }

    const user = managedUsers.find((item) => item.id === userId);
    if (!user) {
      return;
    }

    const nextPurchasedSeconds = user.purchasedSeconds + Math.round(minutes * 60);
    await upsertRecord('voice_usage', {
      user_id: userId,
      free_seconds: user.freeSeconds || MEMBER_FREE_VOICE_SECONDS,
      purchased_seconds: nextPurchasedSeconds,
      used_seconds: user.usedSeconds,
      updated_at: new Date().toISOString(),
    });

    setUserMinuteDrafts((current) => ({ ...current, [userId]: '' }));
    await loadManagedUsers();
    Alert.alert('Time added', `${minutes} minute${minutes === 1 ? '' : 's'} added to ${user.displayName}.`);
  };

  const saveFaq = () => {
    if (!requireAdmin()) {
      return;
    }

    if (!faqDraft.question.trim() || !faqDraft.answer.trim()) {
      Alert.alert('Missing details', 'Please add both a question and an answer.');
      return;
    }

    const id = faqDraft.id || createId('faq');
    const nextFaq: FAQ = {
      id,
      categoryId: selectedCategory.id,
      question: faqDraft.question.trim(),
      answer: faqDraft.answer.trim(),
      tags: normalizeTags(`${faqDraft.question} ${faqDraft.answer}`),
      isActive: true,
      updatedAt: new Date().toISOString(),
    };

    setFaqs((current) => [nextFaq, ...current.filter((item) => item.id !== id)]);
    upsertRecord('faqs', {
      id: nextFaq.id,
      category_id: nextFaq.categoryId,
      question: nextFaq.question,
      answer: nextFaq.answer,
      tags: nextFaq.tags,
      is_active: nextFaq.isActive,
      updated_at: nextFaq.updatedAt,
    });
    setFaqDraft({ id: '', question: '', answer: '' });
  };

  const saveInfo = () => {
    if (!requireAdmin()) {
      return;
    }

    if (!infoDraft.title.trim() || !infoDraft.body.trim()) {
      Alert.alert('Missing details', 'Please add a title and information.');
      return;
    }

    const requirements = infoDraft.requirements
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const id = infoDraft.id || createId('info');
    const nextInfo: PublicInfo = {
      id,
      categoryId: selectedCategory.id,
      title: infoDraft.title.trim(),
      body: infoDraft.body.trim(),
      type: infoDraft.type,
      tags: normalizeTags(`${infoDraft.title} ${infoDraft.body}`),
      locationName: infoDraft.locationName.trim() || undefined,
      requirements: requirements.length ? requirements : undefined,
      updatedAt: new Date().toISOString(),
    };

    setPublicInfo((current) => [nextInfo, ...current.filter((item) => item.id !== id)]);
    upsertRecord('public_information', {
      id: nextInfo.id,
      category_id: nextInfo.categoryId,
      title: nextInfo.title,
      body: nextInfo.body,
      info_type: nextInfo.type,
      tags: nextInfo.tags,
      location_name: nextInfo.locationName,
      requirements: nextInfo.requirements ?? [],
      updated_at: nextInfo.updatedAt,
    });
    setInfoDraft({
      id: '',
      title: '',
      body: '',
      type: 'general',
      locationName: '',
      requirements: '',
    });
  };

  const saveAnnouncement = () => {
    if (!requireAdmin()) {
      return;
    }

    if (!announcementDraft.title.trim() || !announcementDraft.body.trim()) {
      Alert.alert('Missing details', 'Please add a title and announcement.');
      return;
    }

    const id = announcementDraft.id || createId('announcement');
    const nextAnnouncement: Announcement = {
      id,
      categoryId: selectedCategory.id,
      title: announcementDraft.title.trim(),
      body: announcementDraft.body.trim(),
      priority: 'important',
      postedAt: new Date().toISOString(),
    };

    setAnnouncements((current) => [
      nextAnnouncement,
      ...current.filter((item) => item.id !== id),
    ]);
    upsertRecord('announcements', {
      id: nextAnnouncement.id,
      category_id: nextAnnouncement.categoryId,
      title: nextAnnouncement.title,
      body: nextAnnouncement.body,
      priority: nextAnnouncement.priority,
      posted_at: nextAnnouncement.postedAt,
    });
    setAnnouncementDraft({ id: '', title: '', body: '' });
  };

  const saveCategory = () => {
    if (!requireAdmin()) {
      return;
    }

    if (!categoryDraft.name.trim()) {
      Alert.alert('Missing details', 'Please add a category name.');
      return;
    }

    const id =
      categoryDraft.id ||
      categoryDraft.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

    const nextCategory: Category = {
      id,
      key: id,
      name: categoryDraft.name.trim(),
      description: categoryDraft.description.trim() || 'Public information support.',
      color: categoryDraft.color,
      icon: categoryDraft.icon,
      isActive: true,
    };

    setCategories((current) => [nextCategory, ...current.filter((item) => item.id !== id)]);
    upsertRecord('categories', {
      id: nextCategory.id,
      key: nextCategory.key,
      name: nextCategory.name,
      description: nextCategory.description,
      color: nextCategory.color,
      icon: nextCategory.icon,
      is_active: nextCategory.isActive,
    });
    setCategoryDraft({
      id: '',
      name: '',
      description: '',
      color: '#3B82F6',
      icon: 'sparkles-outline',
    });
  };

  const submitFeedback = () => {
    if (!feedbackDraft.trim()) {
      Alert.alert('Add feedback', 'Please type your feedback first.');
      return;
    }

    const nextFeedback: FeedbackItem = {
      id: createId('feedback'),
      categoryId: selectedCategory.id,
      message: feedbackDraft.trim(),
      rating: feedbackRating,
      createdAt: new Date().toISOString(),
    };

    setFeedback((current) => [nextFeedback, ...current]);
    upsertRecord('feedback', {
      id: nextFeedback.id,
      user_id: userProfile?.id ?? null,
      category_id: nextFeedback.categoryId,
      message: nextFeedback.message,
      rating: nextFeedback.rating,
      created_at: nextFeedback.createdAt,
    });
    setFeedbackDraft('');
    Alert.alert('Thank you', 'Your feedback was saved.');
  };

  const deleteItem = (table: string, id: string) => {
    if (!requireAdmin()) {
      return;
    }

    if (table === 'faqs') {
      setFaqs((current) => current.filter((item) => item.id !== id));
    }
    if (table === 'public_information') {
      setPublicInfo((current) => current.filter((item) => item.id !== id));
    }
    if (table === 'announcements') {
      setAnnouncements((current) => current.filter((item) => item.id !== id));
    }
    if (table === 'categories') {
      setCategories((current) => current.filter((item) => item.id !== id));
    }
    deleteRecord(table, id);
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.safeArea, isDarkMode && styles.safeAreaDark]}>
        <StatusBar style={isDarkMode ? 'light' : 'dark'} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardAvoiding}
        >
          <LinearGradient colors={appGradientColors} style={styles.appShell}>
          <View style={[styles.header, isDarkMode && styles.headerDark]}>
            <View style={styles.headerTitleWrap}>
              <Text style={[styles.appName, isDarkMode && styles.appNameDark]}>{APP_TITLE}</Text>
              <Text style={[styles.headerMeta, isDarkMode && styles.headerMetaDark]}>
                {selectedCategory.name} mode · {isAdmin ? 'Admin' : 'Student'} · {supabaseMode}
              </Text>
            </View>
            <View style={styles.headerControls}>
              <Pressable
                accessibilityLabel="Toggle simple words mode"
                onPress={() => setSimpleMode((current) => !current)}
                style={[
                  styles.simpleToggle,
                  isDarkMode && styles.simpleToggleDark,
                  simpleMode && styles.simpleToggleActive,
                ]}
              >
                <Ionicons
                  name={simpleMode ? 'chatbubble-ellipses' : 'chatbubble-ellipses-outline'}
                  size={18}
                  color={simpleMode ? '#FFFFFF' : isDarkMode ? '#CBD5E1' : '#334155'}
                />
                <Text
                  style={[
                    styles.simpleToggleText,
                    isDarkMode && styles.simpleToggleTextDark,
                    simpleMode && styles.simpleToggleTextActive,
                  ]}
                >
                  Simple
                </Text>
              </Pressable>
              <ThemeToggle mode={themeMode} onChange={setThemeMode} />
            </View>
          </View>

          <CategorySelector
            categories={categories.filter((category) => category.isActive)}
            selectedCategoryId={selectedCategory.id}
            onSelect={handleSelectCategory}
            isDarkMode={isDarkMode}
          />

          <Animated.View style={[styles.screenBody, screenAnimatedStyle]}>
            {screen === 'home' ? (
              <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <QuickActions
                  category={selectedCategory}
                  onAction={handleQuickAction}
                  isDarkMode={isDarkMode}
                />

                {activeAnnouncements[0] ? (
                  <InfoBand
                    icon="megaphone-outline"
                    color="#F59E0B"
                    title={activeAnnouncements[0].title}
                    body={activeAnnouncements[0].body}
                    isDarkMode={isDarkMode}
                  />
                ) : null}

                {safetyInfo ? (
                  <InfoBand
                    icon="shield-checkmark-outline"
                    color="#10B981"
                    title="Emergency/Public Safety"
                    body={safetyInfo.body}
                    isDarkMode={isDarkMode}
                  />
                ) : null}

                <ChatPanel
                  messages={messages}
                  typingMessageId={typingMessageId}
                  typedText={typedText}
                  input={input}
                  onInputChange={setInput}
                  onSubmit={() => submitQuestion(input)}
                  selectedColor={selectedCategory.color}
                  isDarkMode={isDarkMode}
                />

                {recentQuestions.length ? (
                  <View style={styles.sectionBlock}>
                    <Text style={[styles.sectionTitle, isDarkMode && styles.sectionTitleDark]}>Recent Questions</Text>
                    <View style={styles.recentList}>
                      {recentQuestions.map((question) => (
                        <Pressable
                          key={question}
                          style={[styles.recentButton, isDarkMode && styles.recentButtonDark]}
                          onPress={() => submitQuestion(question)}
                        >
                          <Ionicons name="time-outline" size={15} color={isDarkMode ? '#CBD5E1' : '#475569'} />
                          <Text style={[styles.recentText, isDarkMode && styles.recentTextDark]}>{question}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : null}
                <AppFooter isDarkMode={isDarkMode} />
              </ScrollView>
            ) : null}

            {screen === 'account' ? (
              <AccountScreen
                authMode={authMode}
                authDraft={authDraft}
                authBusy={authBusy}
                authStatus={authStatus}
                isSupabaseConfigured={Boolean(supabase)}
                session={authSession}
                profile={userProfile}
                guestUserId={guestUserId}
                voiceUsage={voiceUsage}
                isAdmin={isAdmin}
                adminCode={adminCode}
                onAuthModeChange={setAuthMode}
                onAuthDraftChange={setAuthDraft}
                onSubmitAuth={submitAuth}
                onResendVerification={resendVerification}
                onSignOut={signOut}
                onAdminCodeChange={setAdminCode}
                onPrototypeAdminUnlock={unlockAdmin}
                isDarkMode={isDarkMode}
              />
            ) : null}

            {screen === 'admin' && isAdmin ? (
              <AdminPanel
                section={adminSection}
                onSectionChange={setAdminSection}
                selectedCategory={selectedCategory}
                categories={categories}
                faqs={faqs}
                publicInfo={publicInfo}
                announcements={announcements}
                feedback={feedback}
                managedUsers={managedUsers}
                userMinuteDrafts={userMinuteDrafts}
                faqDraft={faqDraft}
                setFaqDraft={setFaqDraft}
                infoDraft={infoDraft}
                setInfoDraft={setInfoDraft}
                announcementDraft={announcementDraft}
                setAnnouncementDraft={setAnnouncementDraft}
                categoryDraft={categoryDraft}
                setCategoryDraft={setCategoryDraft}
                onSaveFaq={saveFaq}
                onSaveInfo={saveInfo}
                onSaveAnnouncement={saveAnnouncement}
                onSaveCategory={saveCategory}
                onDelete={deleteItem}
                onLockAdmin={lockAdmin}
                onReloadUsers={loadManagedUsers}
                onUserMinuteDraftChange={(userId, value) =>
                  setUserMinuteDrafts((current) => ({ ...current, [userId]: value }))
                }
                onAddUserMinutes={addMinutesToUser}
                isDarkMode={isDarkMode}
              />
            ) : null}

            {screen === 'admin' && !isAdmin ? (
              <AccountScreen
                authMode={authMode}
                authDraft={authDraft}
                authBusy={authBusy}
                authStatus="Admin dashboard needs a verified admin account."
                isSupabaseConfigured={Boolean(supabase)}
                session={authSession}
                profile={userProfile}
                guestUserId={guestUserId}
                voiceUsage={voiceUsage}
                isAdmin={isAdmin}
                adminCode={adminCode}
                onAuthModeChange={setAuthMode}
                onAuthDraftChange={setAuthDraft}
                onSubmitAuth={submitAuth}
                onResendVerification={resendVerification}
                onSignOut={signOut}
                onAdminCodeChange={setAdminCode}
                onPrototypeAdminUnlock={unlockAdmin}
                isDarkMode={isDarkMode}
              />
            ) : null}

            {screen === 'feedback' ? (
              <FeedbackScreen
                selectedCategory={selectedCategory}
                feedbackDraft={feedbackDraft}
                rating={feedbackRating}
                onFeedbackChange={setFeedbackDraft}
                onRatingChange={setFeedbackRating}
                onSubmit={submitFeedback}
                voicePackages={defaultVoicePackages}
                onBuyPress={showPaymentPending}
                isDarkMode={isDarkMode}
              />
            ) : null}
          </Animated.View>

          {screen === 'home' ? (
            <FloatingVoiceButton
              state={voiceControlState}
              remainingSeconds={remainingVoiceSeconds}
              isUnlimited={isAdmin}
              onHoldStart={handleVoiceHoldStart}
              onHoldEnd={handleVoiceHoldEnd}
              isDarkMode={isDarkMode}
            />
          ) : null}

          <BottomNav screen={screen} onChange={setScreen} isAdmin={isAdmin} isDarkMode={isDarkMode} />
          </LinearGradient>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function CategorySelector({
  categories,
  selectedCategoryId,
  onSelect,
  isDarkMode,
}: {
  categories: Category[];
  selectedCategoryId: string;
  onSelect: (id: string) => void;
  isDarkMode: boolean;
}) {
  return (
    <View style={styles.categoryWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryList}>
        {categories.map((category) => {
          const selected = category.id === selectedCategoryId;
          return (
            <Pressable
              key={category.id}
              onPress={() => onSelect(category.id)}
              style={[
                styles.categoryPill,
                isDarkMode && styles.categoryPillDark,
                selected && { backgroundColor: category.color, borderColor: category.color },
              ]}
            >
              <Ionicons
                name={category.icon as IconName}
                size={18}
                color={selected ? '#FFFFFF' : category.color}
              />
              <Text style={[styles.categoryText, isDarkMode && styles.categoryTextDark, selected && styles.categoryTextActive]}>
                {category.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function VoiceTimeCard({
  remainingSeconds,
  isUnlimited,
  voiceLocked,
  voiceActive,
  onVoicePress,
  onBuyPress,
}: {
  remainingSeconds: number;
  isUnlimited: boolean;
  voiceLocked: boolean;
  voiceActive: boolean;
  onVoicePress: () => void;
  onBuyPress: () => void;
}) {
  return (
    <Animated.View style={styles.voiceCard}>
      <View style={styles.voiceInfo}>
        <Text style={styles.voiceLabel}>Voice Time Remaining</Text>
        <Text style={[styles.voiceTime, !isUnlimited && remainingSeconds <= 120 && styles.voiceTimeLow]}>
          {isUnlimited ? 'Unlimited' : `${formatVoiceTime(remainingSeconds)} minutes`}
        </Text>
        <Text style={styles.voiceSubLabel}>
          {isUnlimited ? 'Admin account has no voice limit.' : 'Each device gets 2 free voice minutes.'}
        </Text>
      </View>
      <View style={styles.voiceActions}>
        <Pressable
          accessibilityLabel={voiceActive ? 'Stop voice assistance' : 'Start voice assistance'}
          onPress={onVoicePress}
          style={[styles.micButton, voiceActive && styles.micButtonActive, voiceLocked && styles.micButtonLocked]}
        >
          <Ionicons
            name={voiceActive ? 'stop' : voiceLocked ? 'lock-closed-outline' : 'mic-outline'}
            size={22}
            color="#FFFFFF"
          />
        </Pressable>
        {isUnlimited ? null : (
          <Pressable onPress={onBuyPress} style={styles.buyVoiceButton}>
            <Text style={styles.buyVoiceText}>Buy More Voice Time</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

function VoiceStyleSelector({
  selectedVoiceId,
  onSelect,
}: {
  selectedVoiceId: AssistantVoiceId;
  onSelect: (voiceId: AssistantVoiceId) => void;
}) {
  return (
    <View style={styles.voiceSelectorCard}>
      <View style={styles.voiceSelectorHeader}>
        <View>
          <Text style={styles.voiceSelectorTitle}>Assistant Voice</Text>
          <Text style={styles.voiceSelectorSubtitle}>Piliin ang mas malinaw sa Tagalog o English.</Text>
        </View>
        <Ionicons name="volume-high-outline" size={20} color="#0F766E" />
      </View>

      <View style={styles.voiceChoiceGrid}>
        {assistantVoiceOptions.map((voice) => {
          const selected = voice.id === selectedVoiceId;
          return (
            <Pressable
              key={voice.id}
              accessibilityLabel={`Select ${voice.label} assistant voice`}
              onPress={() => onSelect(voice.id)}
              style={[styles.voiceChoice, selected && styles.voiceChoiceActive]}
            >
              <View style={[styles.voiceChoiceIcon, selected && styles.voiceChoiceIconActive]}>
                <Ionicons
                  name={voice.provider === 'elevenlabs' ? 'sparkles-outline' : 'phone-portrait-outline'}
                  size={16}
                  color={selected ? '#FFFFFF' : '#0F766E'}
                />
              </View>
              <View style={styles.voiceChoiceTextWrap}>
                <Text style={[styles.voiceChoiceLabel, selected && styles.voiceChoiceLabelActive]}>
                  {voice.label}
                </Text>
                <Text
                  numberOfLines={2}
                  style={[styles.voiceChoiceDescription, selected && styles.voiceChoiceDescriptionActive]}
                >
                  {voice.description}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function CompanionAvatar({ status, color }: { status: AssistantStatus; color: string }) {
  const breath = useRef(new Animated.Value(0)).current;
  const talk = useRef(new Animated.Value(0)).current;
  const listen = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const breathAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    breathAnimation.start();
    return () => breathAnimation.stop();
  }, [breath]);

  useEffect(() => {
    const talkAnimation =
      status === 'speaking'
        ? Animated.loop(
            Animated.sequence([
              Animated.timing(talk, {
                toValue: 1,
                duration: 260,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
              }),
              Animated.timing(talk, {
                toValue: 0,
                duration: 260,
                easing: Easing.in(Easing.quad),
                useNativeDriver: true,
              }),
            ]),
          )
        : Animated.timing(talk, {
            toValue: 0,
            duration: 180,
            useNativeDriver: true,
          });

    const listenAnimation =
      status === 'listening' || status === 'thinking' || status === 'preparing_voice'
        ? Animated.loop(
            Animated.sequence([
              Animated.timing(listen, {
                toValue: 1,
                duration: status === 'listening' ? 1050 : 820,
                easing: Easing.inOut(Easing.ease),
                useNativeDriver: true,
              }),
              Animated.timing(listen, {
                toValue: 0,
                duration: status === 'listening' ? 1050 : 820,
                easing: Easing.inOut(Easing.ease),
                useNativeDriver: true,
              }),
            ]),
          )
        : Animated.timing(listen, {
            toValue: 0,
            duration: 240,
            useNativeDriver: true,
          });

    talkAnimation.start();
    listenAnimation.start();

    return () => {
      talkAnimation.stop();
      listenAnimation.stop();
    };
  }, [listen, status, talk]);

  const avatarStyle = {
    transform: [
      {
        translateY: breath.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -7],
        }),
      },
      {
        scale: talk.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 1.015],
        }),
      },
    ],
  };

  const ringStyle = {
    opacity: listen.interpolate({
      inputRange: [0, 1],
      outputRange: [0.18, 0.5],
    }),
    transform: [
      {
        scale: listen.interpolate({
          inputRange: [0, 1],
          outputRange: [0.96, 1.12],
        }),
      },
    ],
  };

  const mouthStyle = {
    transform: [
      {
        scaleY: talk.interpolate({
          inputRange: [0, 1],
          outputRange: [0.55, 0.95],
        }),
      },
      {
        scaleX: talk.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0.82],
        }),
      },
    ],
  };

  const thinkingDotStyle = {
    transform: [
      {
        translateY: listen.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -5],
        }),
      },
    ],
    opacity:
      status === 'thinking'
        ? listen.interpolate({
            inputRange: [0, 1],
            outputRange: [0.35, 1],
          })
        : 0,
  };

  return (
    <View style={styles.avatarOuter}>
      <Animated.View style={[styles.avatarRing, { borderColor: color }, ringStyle]} />
      <Animated.View style={[styles.avatarBody, avatarStyle]}>
        <LinearGradient colors={['#FFFFFF', '#E0F2FE']} style={styles.avatarFace}>
          <View style={styles.avatarGlow} />
          <View style={styles.eyeRow}>
            <View style={[styles.eye, { backgroundColor: color }]} />
            <View style={[styles.eye, { backgroundColor: color }]} />
          </View>
          <Animated.View style={[styles.mouth, { backgroundColor: color }, mouthStyle]} />
        </LinearGradient>
        <View style={[styles.avatarBadge, { backgroundColor: color }]}>
          <Ionicons name="sparkles" size={20} color="#FFFFFF" />
        </View>
      </Animated.View>
      <View style={styles.thinkingDots}>
        {[0, 1, 2].map((item) => (
          <Animated.View
            key={item}
            style={[
              styles.thinkingDot,
              { backgroundColor: color, marginTop: item * 3 },
              thinkingDotStyle,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

function QuickActions({
  category,
  onAction,
  isDarkMode,
}: {
  category: Category;
  onAction: (intent: CompanionIntent, prompt: string) => void;
  isDarkMode: boolean;
}) {
  return (
    <View style={styles.quickGrid}>
      {quickActions.map((action) => (
        <Pressable
          key={action.label}
          onPress={() => onAction(action.intent, action.prompt(category))}
          style={[styles.quickButton, isDarkMode && styles.quickButtonDark]}
        >
          <View style={[styles.quickIcon, { backgroundColor: `${category.color}18` }]}>
            <Ionicons name={action.icon} size={22} color={category.color} />
          </View>
          <Text style={[styles.quickText, isDarkMode && styles.quickTextDark]}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function InfoBand({
  icon,
  color,
  title,
  body,
  isDarkMode,
}: {
  icon: IconName;
  color: string;
  title: string;
  body: string;
  isDarkMode: boolean;
}) {
  return (
    <Animated.View style={[styles.infoBand, isDarkMode && styles.infoBandDark]}>
      <View style={[styles.infoIcon, { backgroundColor: `${color}18` }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <View style={styles.infoTextWrap}>
        <Text style={[styles.infoTitle, isDarkMode && styles.infoTitleDark]}>{title}</Text>
        <Text style={[styles.infoBody, isDarkMode && styles.infoBodyDark]}>{body}</Text>
      </View>
    </Animated.View>
  );
}

function ChatPanel({
  messages,
  typingMessageId,
  typedText,
  input,
  onInputChange,
  onSubmit,
  selectedColor,
  isDarkMode,
}: {
  messages: ChatMessage[];
  typingMessageId: string | null;
  typedText: string;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  selectedColor: string;
  isDarkMode: boolean;
}) {
  return (
    <View style={[styles.chatWrap, isDarkMode && styles.chatWrapDark]}>
      <Text style={[styles.sectionTitle, isDarkMode && styles.sectionTitleDark]}>Ask {APP_SHORT_TITLE}</Text>
      <View style={styles.messageList}>
        {messages.slice(-5).map((message) => {
          const isUser = message.role === 'user';
          const displayText = message.id === typingMessageId ? typedText : message.text;
          return (
            <Animated.View
              key={message.id}
              style={[
                styles.messageBubble,
                isUser ? styles.userBubble : styles.assistantBubble,
                isDarkMode && !isUser && styles.assistantBubbleDark,
              ]}
            >
              <Text style={[styles.messageText, isDarkMode && !isUser && styles.messageTextDark, isUser && styles.userMessageText]}>
                {displayText || 'Thinking...'}
              </Text>
            </Animated.View>
          );
        })}
      </View>
      <View style={[styles.inputRow, isDarkMode && styles.inputRowDark]}>
        <TextInput
          value={input}
          onChangeText={onInputChange}
          placeholder="Ask about enrollment, forms, directions..."
          placeholderTextColor={isDarkMode ? '#64748B' : '#94A3B8'}
          style={[styles.textInput, isDarkMode && styles.textInputDark]}
          multiline
        />
        <Pressable
          accessibilityLabel="Send question"
          onPress={onSubmit}
          style={[styles.sendButton, { backgroundColor: selectedColor }]}
        >
          <Ionicons name="send" size={20} color="#FFFFFF" />
        </Pressable>
      </View>
    </View>
  );
}

function AdminAccessPanel({
  adminCode,
  onAdminCodeChange,
  onUnlock,
}: {
  adminCode: string;
  onAdminCodeChange: (value: string) => void;
  onUnlock: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <View style={styles.adminAccessPanel}>
        <View style={styles.adminAccessIcon}>
          <Ionicons name="lock-closed-outline" size={26} color="#0F766E" />
        </View>
        <Text style={styles.adminTitle}>Admin Access</Text>
        <Text style={styles.adminMeta}>
          Students can ask questions, send feedback, and use voice time. Saving public answers is for admins only.
        </Text>

        <TextInput
          value={adminCode}
          onChangeText={onAdminCodeChange}
          placeholder="Admin access code"
          placeholderTextColor="#94A3B8"
          secureTextEntry
          autoCapitalize="none"
          style={styles.adminInput}
        />

        <Pressable onPress={onUnlock} style={styles.adminSaveButton}>
          <Ionicons name="shield-checkmark-outline" size={18} color="#FFFFFF" />
          <Text style={styles.adminSaveText}>Unlock Admin</Text>
        </Pressable>
      </View>

      <View style={styles.feedbackPanel}>
        <Text style={styles.sectionTitle}>Student Access</Text>
        <PermissionRow icon="chatbubble-ellipses-outline" text="Ask the AI companion" />
        <PermissionRow icon="heart-outline" text="Send feedback" />
        <PermissionRow icon="mic-outline" text="Use voice assistance" />
        <PermissionRow icon="card-outline" text="View voice packages" />
      </View>
      <AppFooter />
    </ScrollView>
  );
}

function PermissionRow({ icon, text, isDarkMode }: { icon: IconName; text: string; isDarkMode?: boolean }) {
  return (
    <View style={styles.permissionRow}>
      <Ionicons name={icon} size={18} color={isDarkMode ? '#5EEAD4' : '#0F766E'} />
      <Text style={[styles.permissionText, isDarkMode && styles.permissionTextDark]}>{text}</Text>
    </View>
  );
}

function AppFooter({ isDarkMode = false }: { isDarkMode?: boolean }) {
  return (
    <View style={[styles.pageFooter, isDarkMode && styles.pageFooterDark]}>
      <Text style={[styles.pageFooterText, isDarkMode && styles.pageFooterTextDark]}>
        {APP_TITLE} | BSCS 2026–2027 | ARELLANO UNIVERSITY – JOSE RIZAL CAMPUS | GROUP 1 SYSTEM
      </Text>
    </View>
  );
}

function ThemeToggle({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <View style={styles.themeToggle}>
      {(['light', 'dark'] as ThemeMode[]).map((item) => {
        const active = mode === item;
        return (
          <Pressable
            key={item}
            accessibilityLabel={`Use ${item} mode`}
            onPress={() => onChange(item)}
            style={[styles.themeToggleButton, active && styles.themeToggleButtonActive]}
          >
            <Ionicons
              name={item === 'dark' ? 'moon' : 'sunny'}
              size={16}
              color={active ? '#FFFFFF' : '#64748B'}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function FloatingVoiceButton({
  state,
  remainingSeconds,
  isUnlimited,
  onHoldStart,
  onHoldEnd,
  isDarkMode: _isDarkMode,
}: {
  state: VoiceControlState;
  remainingSeconds: number;
  isUnlimited: boolean;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  isDarkMode?: boolean;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const isListening = state === 'listening';
  const disabled = false;
  const statusStateStyle =
    state === 'listening'
      ? styles.floatingVoiceStatusListening
      : state === 'processing'
        ? styles.floatingVoiceStatusProcessing
        : state === 'speaking'
          ? styles.floatingVoiceStatusSpeaking
          : state === 'locked'
            ? styles.floatingVoiceStatusLocked
            : styles.floatingVoiceStatusIdle;
  const buttonStateStyle =
    state === 'listening'
      ? styles.floatingMicButtonListening
      : state === 'processing'
        ? styles.floatingMicButtonProcessing
        : state === 'speaking'
          ? styles.floatingMicButtonSpeaking
          : state === 'locked'
            ? styles.floatingMicButtonLocked
            : styles.floatingMicButtonIdle;

  useEffect(() => {
    if (!isListening) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return undefined;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 760,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 760,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [isListening, pulse]);

  const ringStyle = {
    opacity: pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [0.16, 0.4],
    }),
    transform: [
      {
        scale: pulse.interpolate({
          inputRange: [0, 1],
          outputRange: [0.92, 1.32],
        }),
      },
    ],
  };

  const micIcon = state === 'locked'
    ? 'lock-closed-outline'
    : state === 'processing'
      ? 'sync-outline'
      : state === 'speaking'
        ? 'volume-high-outline'
        : 'mic-outline';

  return (
    <View pointerEvents="box-none" style={styles.floatingVoiceWrap}>
      <View style={[styles.floatingVoiceStatus, statusStateStyle]}>
        {isListening ? (
          <View style={styles.voiceWaveform}>
            {[0, 1, 2].map((item) => (
              <Animated.View
                key={item}
                style={[
                  styles.voiceWaveBar,
                  {
                    transform: [
                      {
                        scaleY: pulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: item === 1 ? [0.45, 1.3] : [0.35, 0.95],
                        }),
                      },
                    ],
                  },
                ]}
              />
            ))}
          </View>
        ) : null}
        <Text style={[styles.floatingVoiceStatusText, state === 'locked' && styles.floatingVoiceStatusTextLocked]}>
          {getVoiceControlLabel(state, remainingSeconds, isUnlimited)}
        </Text>
      </View>

      <Pressable
        accessibilityLabel="Hold to talk"
        disabled={disabled}
        onPressIn={onHoldStart}
        onPressOut={onHoldEnd}
        style={({ pressed }) => [
          styles.floatingMicButton,
          buttonStateStyle,
          pressed && !disabled && styles.floatingMicButtonPressed,
          disabled && styles.floatingMicButtonDisabled,
        ]}
      >
        {isListening ? <Animated.View pointerEvents="none" style={[styles.floatingMicPulse, ringStyle]} /> : null}
        <Ionicons name={micIcon as IconName} size={28} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

function AccountScreen({
  authMode,
  authDraft,
  authBusy,
  authStatus,
  isSupabaseConfigured,
  session,
  profile,
  guestUserId,
  voiceUsage,
  isAdmin,
  adminCode,
  onAuthModeChange,
  onAuthDraftChange,
  onSubmitAuth,
  onResendVerification,
  onSignOut,
  onAdminCodeChange,
  onPrototypeAdminUnlock,
  isDarkMode,
}: {
  authMode: AuthMode;
  authDraft: AuthDraft;
  authBusy: boolean;
  authStatus: string;
  isSupabaseConfigured: boolean;
  session: Session | null;
  profile: UserProfile | null;
  guestUserId: string;
  voiceUsage: VoiceUsage;
  isAdmin: boolean;
  adminCode: string;
  onAuthModeChange: (mode: AuthMode) => void;
  onAuthDraftChange: (draft: AuthDraft) => void;
  onSubmitAuth: () => void;
  onResendVerification: () => void;
  onSignOut: () => void;
  onAdminCodeChange: (value: string) => void;
  onPrototypeAdminUnlock: () => void;
  isDarkMode: boolean;
}) {
  const signedInEmail = profile?.email ?? session?.user.email ?? '';
  const remaining = getRemainingVoiceSeconds(voiceUsage);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <View style={[styles.adminAccessPanel, isDarkMode && styles.adminAccessPanelDark]}>
        <View style={[styles.adminAccessIcon, isDarkMode && styles.adminAccessIconDark]}>
          <Ionicons name={profile ? 'person-circle-outline' : 'person-add-outline'} size={26} color={isDarkMode ? '#5EEAD4' : '#0F766E'} />
        </View>
        <Text style={[styles.adminTitle, isDarkMode && styles.textDark]}>{profile ? 'Account' : 'Login or Register'}</Text>
        <Text style={[styles.adminMeta, isDarkMode && styles.metaDark]}>
          {profile
            ? `${profile.role === 'admin' ? 'Admin' : 'Verified user'} account`
            : 'Each device gets 2 free voice minutes. Recent questions sync only after login.'}
        </Text>

        {profile ? (
          <>
            <View style={styles.accountSummaryGrid}>
              <AccountStat label="Name" value={profile.displayName} isDarkMode={isDarkMode} />
              <AccountStat label="Email" value={signedInEmail || 'No email'} isDarkMode={isDarkMode} />
              <AccountStat label="User ID" value={profile.id} compact isDarkMode={isDarkMode} />
              <AccountStat label="Voice Time" value={isAdmin ? 'Unlimited' : `${formatVoiceTime(remaining)} min`} isDarkMode={isDarkMode} />
            </View>
            <Pressable onPress={onSignOut} style={[styles.secondaryButton, isDarkMode && styles.secondaryButtonDark]}>
              <Ionicons name="log-out-outline" size={18} color={isDarkMode ? '#CBD5E1' : '#334155'} />
              <Text style={[styles.secondaryButtonText, isDarkMode && styles.secondaryButtonTextDark]}>Sign Out</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={[styles.authModeRow, isDarkMode && styles.authModeRowDark]}>
              {(['login', 'signup'] as AuthMode[]).map((mode) => (
                <Pressable
                  key={mode}
                  onPress={() => onAuthModeChange(mode)}
                  style={[styles.authModeButton, authMode === mode && styles.authModeButtonActive]}
                >
                  <Text style={[styles.authModeText, isDarkMode && styles.authModeTextDark, authMode === mode && styles.authModeTextActive]}>
                    {mode === 'login' ? 'Login' : 'Register'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {!isSupabaseConfigured ? (
              <View style={styles.noticeBox}>
                <Ionicons name="cloud-offline-outline" size={18} color="#B45309" />
                <Text style={styles.noticeText}>
                  Add Supabase URL and anon key in `.env.local` to test real user login.
                </Text>
              </View>
            ) : null}

            {authMode === 'signup' ? (
              <AdminInput
                label="Full name"
                value={authDraft.displayName}
                onChange={(displayName) => onAuthDraftChange({ ...authDraft, displayName })}
                isDarkMode={isDarkMode}
              />
            ) : null}
            <View style={styles.adminInputWrap}>
              <Text style={[styles.adminInputLabel, isDarkMode && styles.adminInputLabelDark]}>Email</Text>
              <TextInput
                value={authDraft.email}
                onChangeText={(email) => onAuthDraftChange({ ...authDraft, email })}
                placeholder="Email"
                placeholderTextColor={isDarkMode ? '#475569' : '#94A3B8'}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={[styles.adminInput, isDarkMode && styles.adminInputDark]}
              />
            </View>
            <View style={styles.adminInputWrap}>
              <Text style={[styles.adminInputLabel, isDarkMode && styles.adminInputLabelDark]}>Password</Text>
              <TextInput
                value={authDraft.password}
                onChangeText={(password) => onAuthDraftChange({ ...authDraft, password })}
                placeholder="Password"
                placeholderTextColor={isDarkMode ? '#475569' : '#94A3B8'}
                secureTextEntry
                autoCapitalize="none"
                style={[styles.adminInput, isDarkMode && styles.adminInputDark]}
              />
            </View>
            <Pressable
              disabled={authBusy || !isSupabaseConfigured}
              onPress={onSubmitAuth}
              style={[styles.adminSaveButton, (authBusy || !isSupabaseConfigured) && styles.buttonDisabled]}
            >
              <Ionicons name={authMode === 'login' ? 'log-in-outline' : 'mail-outline'} size={18} color="#FFFFFF" />
              <Text style={styles.adminSaveText}>
                {authBusy ? 'Please wait' : authMode === 'login' ? 'Login' : 'Create Account'}
              </Text>
            </Pressable>
            <Pressable disabled={!isSupabaseConfigured} onPress={onResendVerification} style={[styles.secondaryButton, isDarkMode && styles.secondaryButtonDark]}>
              <Ionicons name="refresh-outline" size={18} color={isDarkMode ? '#CBD5E1' : '#334155'} />
              <Text style={[styles.secondaryButtonText, isDarkMode && styles.secondaryButtonTextDark]}>Resend Verification Email</Text>
            </Pressable>
            {authStatus ? <Text style={styles.authStatus}>{authStatus}</Text> : null}
            <AccountStat label="Guest ID" value={guestUserId || 'Loading'} compact isDarkMode={isDarkMode} />
          </>
        )}
      </View>

      {!isSupabaseConfigured ? (
        <View style={[styles.feedbackPanel, isDarkMode && styles.feedbackPanelDark]}>
          <Text style={[styles.sectionTitle, isDarkMode && styles.textDark]}>Prototype Admin Unlock</Text>
          <Text style={[styles.adminMeta, isDarkMode && styles.metaDark]}>
            This is only for local demo mode. Real admin access comes from a verified Supabase account with role admin.
          </Text>
          <TextInput
            value={adminCode}
            onChangeText={onAdminCodeChange}
            placeholder="Admin access code"
            placeholderTextColor={isDarkMode ? '#475569' : '#94A3B8'}
            secureTextEntry
            autoCapitalize="none"
            style={[styles.adminInput, isDarkMode && styles.adminInputDark]}
          />
          <Pressable onPress={onPrototypeAdminUnlock} style={styles.adminSaveButton}>
            <Ionicons name="shield-checkmark-outline" size={18} color="#FFFFFF" />
            <Text style={styles.adminSaveText}>Unlock Admin</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.feedbackPanel, isDarkMode && styles.feedbackPanelDark]}>
        <Text style={[styles.sectionTitle, isDarkMode && styles.textDark]}>Access Rules</Text>
        <PermissionRow icon="timer-outline" text="Guest voice: 2 free minutes" isDarkMode={isDarkMode} />
        <PermissionRow icon="checkmark-circle-outline" text="Verified user voice: 10 free minutes" isDarkMode={isDarkMode} />
        <PermissionRow icon="infinite-outline" text="Admin voice: no time limit" isDarkMode={isDarkMode} />
        <PermissionRow icon="mail-outline" text="New accounts must verify email before login" isDarkMode={isDarkMode} />
      </View>
      <AppFooter isDarkMode={isDarkMode} />
    </ScrollView>
  );
}

function AccountStat({ label, value, compact, isDarkMode }: { label: string; value: string; compact?: boolean; isDarkMode?: boolean }) {
  return (
    <View style={[styles.accountStat, isDarkMode && styles.accountStatDark]}>
      <Text style={[styles.accountStatLabel, isDarkMode && styles.metaDark]}>{label}</Text>
      <Text style={[styles.accountStatValue, compact && styles.accountStatValueCompact, isDarkMode && styles.textDark]} numberOfLines={compact ? 2 : 1}>
        {value}
      </Text>
    </View>
  );
}

function AdminPanel({
  section,
  onSectionChange,
  selectedCategory,
  categories,
  faqs,
  publicInfo,
  announcements,
  feedback,
  managedUsers,
  userMinuteDrafts,
  faqDraft,
  setFaqDraft,
  infoDraft,
  setInfoDraft,
  announcementDraft,
  setAnnouncementDraft,
  categoryDraft,
  setCategoryDraft,
  onSaveFaq,
  onSaveInfo,
  onSaveAnnouncement,
  onSaveCategory,
  onDelete,
  onLockAdmin,
  onReloadUsers,
  onUserMinuteDraftChange,
  onAddUserMinutes,
  isDarkMode,
}: {
  section: AdminSection;
  onSectionChange: (section: AdminSection) => void;
  selectedCategory: Category;
  categories: Category[];
  faqs: FAQ[];
  publicInfo: PublicInfo[];
  announcements: Announcement[];
  feedback: FeedbackItem[];
  managedUsers: ManagedUser[];
  userMinuteDrafts: Record<string, string>;
  faqDraft: { id: string; question: string; answer: string };
  setFaqDraft: (value: { id: string; question: string; answer: string }) => void;
  infoDraft: {
    id: string;
    title: string;
    body: string;
    type: PublicInfo['type'];
    locationName: string;
    requirements: string;
  };
  setInfoDraft: (value: {
    id: string;
    title: string;
    body: string;
    type: PublicInfo['type'];
    locationName: string;
    requirements: string;
  }) => void;
  announcementDraft: { id: string; title: string; body: string };
  setAnnouncementDraft: (value: { id: string; title: string; body: string }) => void;
  categoryDraft: { id: string; name: string; description: string; color: string; icon: string };
  setCategoryDraft: (value: { id: string; name: string; description: string; color: string; icon: string }) => void;
  onSaveFaq: () => void;
  onSaveInfo: () => void;
  onSaveAnnouncement: () => void;
  onSaveCategory: () => void;
  onDelete: (table: string, id: string) => void;
  onLockAdmin: () => void;
  onReloadUsers: () => void;
  onUserMinuteDraftChange: (userId: string, value: string) => void;
  onAddUserMinutes: (userId: string) => void;
  isDarkMode: boolean;
}) {
  const categoryFaqs = faqs.filter((faq) => faq.categoryId === selectedCategory.id);
  const categoryInfo = publicInfo.filter((info) => info.categoryId === selectedCategory.id);
  const categoryAnnouncements = announcements.filter((announcement) => announcement.categoryId === selectedCategory.id);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <View style={styles.adminHeader}>
        <View style={styles.adminHeaderRow}>
          <View style={styles.adminHeaderText}>
            <Text style={styles.adminTitle}>Admin Panel</Text>
            <Text style={styles.adminMeta}>{selectedCategory.name} content</Text>
          </View>
          <Pressable onPress={onLockAdmin} style={styles.adminLockButton}>
            <Ionicons name="lock-closed-outline" size={17} color="#334155" />
            <Text style={styles.adminLockText}>Lock</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.adminTabs}>
        {adminSections.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => onSectionChange(item.id)}
            style={[styles.adminTab, section === item.id && styles.adminTabActive]}
          >
            <Ionicons
              name={item.icon}
              size={17}
              color={section === item.id ? '#FFFFFF' : '#475569'}
            />
            <Text style={[styles.adminTabText, section === item.id && styles.adminTabTextActive]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {section === 'faqs' ? (
        <View style={styles.adminSection}>
          <AdminInput label="Question" value={faqDraft.question} onChange={(question) => setFaqDraft({ ...faqDraft, question })} />
          <AdminInput label="Answer" value={faqDraft.answer} onChange={(answer) => setFaqDraft({ ...faqDraft, answer })} multiline />
          <AdminSaveButton label={faqDraft.id ? 'Update FAQ' : 'Add FAQ'} onPress={onSaveFaq} />
          {categoryFaqs.map((faq) => (
            <AdminRow
              key={faq.id}
              title={faq.question}
              body={faq.answer}
              onEdit={() => setFaqDraft({ id: faq.id, question: faq.question, answer: faq.answer })}
              onDelete={() => onDelete('faqs', faq.id)}
            />
          ))}
        </View>
      ) : null}

      {section === 'info' ? (
        <View style={styles.adminSection}>
          <AdminInput label="Title" value={infoDraft.title} onChange={(title) => setInfoDraft({ ...infoDraft, title })} />
          <AdminInput label="Information" value={infoDraft.body} onChange={(body) => setInfoDraft({ ...infoDraft, body })} multiline />
          <AdminInput label="Location" value={infoDraft.locationName} onChange={(locationName) => setInfoDraft({ ...infoDraft, locationName })} />
          <AdminInput label="Requirements, comma separated" value={infoDraft.requirements} onChange={(requirements) => setInfoDraft({ ...infoDraft, requirements })} />
          <View style={styles.typeRow}>
            {(['general', 'procedure', 'requirements', 'location', 'rule', 'safety'] as PublicInfo['type'][]).map((type) => (
              <Pressable
                key={type}
                onPress={() => setInfoDraft({ ...infoDraft, type })}
                style={[styles.typeChip, infoDraft.type === type && styles.typeChipActive]}
              >
                <Text style={[styles.typeChipText, infoDraft.type === type && styles.typeChipTextActive]}>
                  {type}
                </Text>
              </Pressable>
            ))}
          </View>
          <AdminSaveButton label={infoDraft.id ? 'Update Info' : 'Add Public Info'} onPress={onSaveInfo} />
          {categoryInfo.map((info) => (
            <AdminRow
              key={info.id}
              title={info.title}
              body={info.body}
              onEdit={() =>
                setInfoDraft({
                  id: info.id,
                  title: info.title,
                  body: info.body,
                  type: info.type,
                  locationName: info.locationName ?? '',
                  requirements: info.requirements?.join(', ') ?? '',
                })
              }
              onDelete={() => onDelete('public_information', info.id)}
            />
          ))}
        </View>
      ) : null}

      {section === 'announcements' ? (
        <View style={styles.adminSection}>
          <AdminInput label="Title" value={announcementDraft.title} onChange={(title) => setAnnouncementDraft({ ...announcementDraft, title })} />
          <AdminInput label="Announcement" value={announcementDraft.body} onChange={(body) => setAnnouncementDraft({ ...announcementDraft, body })} multiline />
          <AdminSaveButton label={announcementDraft.id ? 'Update Announcement' : 'Post Announcement'} onPress={onSaveAnnouncement} />
          {categoryAnnouncements.map((announcement) => (
            <AdminRow
              key={announcement.id}
              title={announcement.title}
              body={announcement.body}
              onEdit={() => setAnnouncementDraft({ id: announcement.id, title: announcement.title, body: announcement.body })}
              onDelete={() => onDelete('announcements', announcement.id)}
            />
          ))}
        </View>
      ) : null}

      {section === 'categories' ? (
        <View style={styles.adminSection}>
          <AdminInput label="Name" value={categoryDraft.name} onChange={(name) => setCategoryDraft({ ...categoryDraft, name })} />
          <AdminInput label="Description" value={categoryDraft.description} onChange={(description) => setCategoryDraft({ ...categoryDraft, description })} />
          <AdminInput label="Icon name" value={categoryDraft.icon} onChange={(icon) => setCategoryDraft({ ...categoryDraft, icon })} />
          <AdminSaveButton label={categoryDraft.id ? 'Update Category' : 'Add Category'} onPress={onSaveCategory} />
          {categories.map((category) => (
            <AdminRow
              key={category.id}
              title={category.name}
              body={category.description}
              onEdit={() =>
                setCategoryDraft({
                  id: category.id,
                  name: category.name,
                  description: category.description,
                  color: category.color,
                  icon: category.icon,
                })
              }
              onDelete={() => onDelete('categories', category.id)}
            />
          ))}
        </View>
      ) : null}

      {section === 'feedback' ? (
        <View style={styles.adminSection}>
          {feedback.map((item) => (
            <View key={item.id} style={styles.feedbackRow}>
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingBadgeText}>{item.rating}</Text>
              </View>
              <Text style={styles.feedbackMessage}>{item.message}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {section === 'users' ? (
        <View style={styles.adminSection}>
          <View style={styles.feedbackPanel}>
            <View style={styles.adminHeaderRow}>
              <View style={styles.adminHeaderText}>
                <Text style={styles.sectionTitle}>Manage Users</Text>
                <Text style={styles.adminMeta}>Add voice minutes by user ID or verified account.</Text>
              </View>
              <Pressable onPress={onReloadUsers} style={styles.adminIconButton}>
                <Ionicons name="refresh-outline" size={18} color="#334155" />
              </Pressable>
            </View>
          </View>

          {managedUsers.length ? (
            managedUsers.map((user) => (
              <View key={user.id} style={styles.userManageRow}>
                <View style={styles.userManageTop}>
                  <View style={styles.userManageText}>
                    <Text style={styles.adminRowTitle}>{user.displayName}</Text>
                    <Text style={styles.adminRowBody}>{user.email || 'No email saved'}</Text>
                    <Text style={styles.userIdText}>ID: {user.id}</Text>
                  </View>
                  <View style={[styles.roleBadge, user.role === 'admin' && styles.roleBadgeAdmin]}>
                    <Text style={[styles.roleBadgeText, user.role === 'admin' && styles.roleBadgeTextAdmin]}>
                      {user.role}
                    </Text>
                  </View>
                </View>

                <View style={styles.userTimeGrid}>
                  <AccountStat label="Free" value={`${Math.round(user.freeSeconds / 60)} min`} />
                  <AccountStat label="Added" value={`${Math.round(user.purchasedSeconds / 60)} min`} />
                  <AccountStat
                    label="Remaining"
                    value={user.role === 'admin' ? 'Unlimited' : `${formatManagedUserTime(user.remainingSeconds)}`}
                  />
                </View>

                {user.role === 'admin' ? null : (
                  <View style={styles.addMinutesRow}>
                    <TextInput
                      value={userMinuteDrafts[user.id] ?? ''}
                      onChangeText={(value) => onUserMinuteDraftChange(user.id, value.replace(/[^0-9.]/g, ''))}
                      placeholder="Minutes"
                      placeholderTextColor="#94A3B8"
                      keyboardType="numeric"
                      style={[styles.adminInput, styles.minutesInput]}
                    />
                    <Pressable onPress={() => onAddUserMinutes(user.id)} style={styles.addMinutesButton}>
                      <Ionicons name="add-outline" size={18} color="#FFFFFF" />
                      <Text style={styles.addMinutesText}>Add</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))
          ) : (
            <View style={styles.feedbackPanel}>
              <Text style={styles.adminMeta}>No verified users loaded yet.</Text>
            </View>
          )}
        </View>
      ) : null}

      {section === 'smtp' ? (
        <View style={styles.adminSection}>
          <View style={styles.feedbackPanel}>
            <Text style={styles.sectionTitle}>SMTP Setup</Text>
            <Text style={styles.adminMeta}>
              Email verification is required. Configure SMTP in Supabase Auth so signup confirmation emails are reliable.
            </Text>
            <PermissionRow icon="settings-outline" text="Supabase Dashboard > Authentication > Emails > SMTP Settings" />
            <PermissionRow icon="mail-outline" text="Add sender email, SMTP host, port, username, and password there" />
            <PermissionRow icon="checkmark-circle-outline" text="Enable Confirm email in Authentication settings" />
            <PermissionRow icon="link-outline" text="Set Site URL and Redirect URLs for your Expo or production app" />
          </View>
          <View style={styles.noticeBox}>
            <Ionicons name="shield-checkmark-outline" size={18} color="#0F766E" />
            <Text style={styles.noticeText}>
              SMTP passwords cannot be saved safely inside this mobile app. Use the Supabase dashboard, or a server-only
              admin tool if you later want one-click SMTP provisioning.
            </Text>
          </View>
        </View>
      ) : null}
      <AppFooter isDarkMode={isDarkMode} />
    </ScrollView>
  );
}

function FeedbackScreen({
  selectedCategory,
  feedbackDraft,
  rating,
  onFeedbackChange,
  onRatingChange,
  onSubmit,
  voicePackages,
  onBuyPress,
  isDarkMode,
}: {
  selectedCategory: Category;
  feedbackDraft: string;
  rating: number;
  onFeedbackChange: (value: string) => void;
  onRatingChange: (value: number) => void;
  onSubmit: () => void;
  voicePackages: typeof defaultVoicePackages;
  onBuyPress: () => void;
  isDarkMode: boolean;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <View style={[styles.feedbackPanel, isDarkMode && styles.feedbackPanelDark]}>
        <Text style={[styles.adminTitle, isDarkMode && styles.textDark]}>Feedback</Text>
        <Text style={[styles.adminMeta, isDarkMode && styles.metaDark]}>{selectedCategory.name}</Text>
        <TextInput
          value={feedbackDraft}
          onChangeText={onFeedbackChange}
          placeholder="Type your feedback..."
          placeholderTextColor={isDarkMode ? '#475569' : '#94A3B8'}
          multiline
          style={[styles.adminInput, styles.adminMultiline, isDarkMode && styles.adminInputDark]}
        />
        <View style={styles.ratingRow}>
          {[1, 2, 3, 4, 5].map((value) => (
            <Pressable
              key={value}
              onPress={() => onRatingChange(value)}
              style={[styles.ratingButton, isDarkMode && styles.ratingButtonDark, rating === value && styles.ratingButtonActive]}
            >
              <Text style={[styles.ratingButtonText, isDarkMode && styles.ratingButtonTextDark, rating === value && styles.ratingButtonTextActive]}>
                {value}
              </Text>
            </Pressable>
          ))}
        </View>
        <AdminSaveButton label="Send Feedback" onPress={onSubmit} />
      </View>

      <View style={[styles.feedbackPanel, isDarkMode && styles.feedbackPanelDark]}>
        <Text style={[styles.sectionTitle, isDarkMode && styles.textDark]}>Voice Packages</Text>
        {voicePackages.map((item) => (
          <Pressable key={item.id} onPress={onBuyPress} style={[styles.packageRow, isDarkMode && styles.packageRowDark]}>
            <View style={styles.packageInfo}>
              <Text style={[styles.packageLabel, isDarkMode && styles.textDark]}>{item.label}</Text>
              <Text style={[styles.packageStatus, isDarkMode && styles.metaDark]}>Pending / For Future Integration</Text>
            </View>
            <Text style={[styles.packagePrice, isDarkMode && styles.textDark]}>₱{item.pricePesos}</Text>
          </Pressable>
        ))}
      </View>
      <AppFooter isDarkMode={isDarkMode} />
    </ScrollView>
  );
}

function AdminInput({
  label,
  value,
  onChange,
  multiline,
  isDarkMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  isDarkMode?: boolean;
}) {
  return (
    <View style={styles.adminInputWrap}>
      <Text style={[styles.adminInputLabel, isDarkMode && styles.adminInputLabelDark]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor={isDarkMode ? '#475569' : '#94A3B8'}
        multiline={multiline}
        style={[styles.adminInput, multiline && styles.adminMultiline, isDarkMode && styles.adminInputDark]}
      />
    </View>
  );
}

function AdminSaveButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.adminSaveButton}>
      <Ionicons name="save-outline" size={18} color="#FFFFFF" />
      <Text style={styles.adminSaveText}>{label}</Text>
    </Pressable>
  );
}

function AdminRow({
  title,
  body,
  onEdit,
  onDelete,
}: {
  title: string;
  body: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.adminRow}>
      <View style={styles.adminRowText}>
        <Text style={styles.adminRowTitle}>{title}</Text>
        <Text style={styles.adminRowBody} numberOfLines={3}>
          {body}
        </Text>
      </View>
      <View style={styles.adminRowActions}>
        <Pressable accessibilityLabel="Edit" onPress={onEdit} style={styles.adminIconButton}>
          <Ionicons name="create-outline" size={18} color="#334155" />
        </Pressable>
        <Pressable accessibilityLabel="Delete" onPress={onDelete} style={styles.adminIconButton}>
          <Ionicons name="trash-outline" size={18} color="#DC2626" />
        </Pressable>
      </View>
    </View>
  );
}

function BottomNav({
  screen,
  onChange,
  isAdmin,
  isDarkMode,
}: {
  screen: ScreenName;
  onChange: (screen: ScreenName) => void;
  isAdmin: boolean;
  isDarkMode: boolean;
}) {
  const tabs: Array<{ id: ScreenName; label: string; icon: IconName }> = [
    { id: 'home', label: 'Home', icon: 'home-outline' },
    { id: 'account', label: 'Account', icon: 'person-circle-outline' },
    ...(isAdmin ? [{ id: 'admin' as ScreenName, label: 'Admin', icon: 'settings-outline' as IconName }] : []),
    { id: 'feedback', label: 'Feedback', icon: 'heart-outline' },
  ];

  return (
    <View style={[styles.bottomNav, isDarkMode && styles.bottomNavDark]}>
      {tabs.map((tab) => {
        const active = screen === tab.id;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            style={[styles.navItem, active && (isDarkMode ? styles.navItemActiveDark : styles.navItemActive)]}
          >
            <Ionicons
              name={active ? (tab.icon.replace('-outline', '') as IconName) : tab.icon}
              size={21}
              color={active ? (isDarkMode ? '#E2E8F0' : '#0F172A') : (isDarkMode ? '#64748B' : '#64748B')}
            />
            <Text style={[styles.navText, isDarkMode && styles.navTextDark, active && (isDarkMode ? styles.navTextActiveDark : styles.navTextActive)]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const adminSections: Array<{ id: AdminSection; label: string; icon: IconName }> = [
  { id: 'faqs', label: 'FAQs', icon: 'help-circle-outline' },
  { id: 'info', label: 'Info', icon: 'document-text-outline' },
  { id: 'announcements', label: 'Posts', icon: 'megaphone-outline' },
  { id: 'categories', label: 'Categories', icon: 'grid-outline' },
  { id: 'feedback', label: 'Feedback', icon: 'chatbox-ellipses-outline' },
  { id: 'users', label: 'Users', icon: 'people-outline' },
  { id: 'smtp', label: 'SMTP', icon: 'mail-outline' },
];

function normalizeTags(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 3),
    ),
  ).slice(0, 8);
}

function isEmailConfirmed(user: User) {
  const confirmationFields = user as User & {
    confirmed_at?: string | null;
    email_confirmed_at?: string | null;
  };

  return Boolean(confirmationFields.email_confirmed_at || confirmationFields.confirmed_at);
}

function mapUserProfile(row: Record<string, unknown>): UserProfile {
  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : undefined,
    email: row.email ? String(row.email) : undefined,
    displayName: String(row.display_name ?? row.email ?? 'Student'),
    role: row.role === 'admin' ? 'admin' : 'student',
    institutionName: row.institution_name ? String(row.institution_name) : undefined,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

function isDuplicateProfileError(error: unknown) {
  const candidate = error as { code?: string; message?: string };
  return candidate.code === '23505' || Boolean(candidate.message?.includes('duplicate key value'));
}

function normalizeRecentQuestion(question: string) {
  return question.trim().replace(/\s+/g, ' ').toLowerCase();
}

function mapVoiceUsageRow(row: unknown): VoiceUsage {
  const candidate = row as {
    free_seconds?: number | string | null;
    purchased_seconds?: number | string | null;
    used_seconds?: number | string | null;
  } | null;

  return {
    freeSeconds: Number(candidate?.free_seconds ?? GUEST_FREE_VOICE_SECONDS),
    purchasedSeconds: Number(candidate?.purchased_seconds ?? 0),
    usedSeconds: Number(candidate?.used_seconds ?? 0),
  };
}

function isAbortError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError') {
    return true;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes('fetch request has been canceled') ||
    msg.includes('aborted') ||
    msg.includes('cancelled') ||
    msg.includes('canceled')
  );
}

function isAudioRecorderAlreadyPreparedError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const msg = error.message.toLowerCase();
  return msg.includes('already been prepared') || msg.includes('already prepared');
}

async function stopDeviceSpeechQueue() {
  try {
    await Speech.stop();
  } catch (error) {
    console.warn('Unable to stop device speech:', error);
  }
}

function stopDeviceSpeechNow() {
  void stopDeviceSpeechQueue();
}

function getVoiceControlLabel(state: VoiceControlState, remainingSeconds: number, isUnlimited: boolean) {
  if (state === 'listening') {
    return 'Listening';
  }
  if (state === 'processing') {
    return 'Processing';
  }
  if (state === 'speaking') {
    return 'Answering';
  }
  if (state === 'locked') {
    return 'Locked';
  }

  return isUnlimited ? 'Voice' : formatVoiceTime(remainingSeconds);
}

function formatManagedUserTime(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return 'Unlimited';
  }

  return `${formatVoiceTime(seconds)} min`;
}

function statusLabel(status: AssistantStatus) {
  if (status === 'listening') {
    return 'Listening...';
  }
  if (status === 'thinking') {
    return 'Thinking...';
  }
  if (status === 'preparing_voice') {
    return 'Preparing voice...';
  }
  if (status === 'speaking') {
    return 'Speaking...';
  }
  return 'Ready to help';
}

function findDeviceVoice(deviceVoices: DeviceSpeechVoice[], preferredLanguage: string) {
  const preferred = preferredLanguage.toLowerCase();
  const preferredBase = preferred.split('-')[0];
  const fallbackLanguages = preferredBase === 'fil' || preferredBase === 'tl'
    ? ['fil-ph', 'tl-ph', 'fil', 'tl', 'en-ph', 'en-us']
    : ['en-ph', 'en-us', 'en'];

  const normalizedVoices = deviceVoices.map((voice) => ({
    voice,
    language: voice.language.toLowerCase(),
  }));

  return (
    normalizedVoices.find((item) => item.language === preferred)?.voice ??
    fallbackLanguages
      .map((language) => normalizedVoices.find((item) => item.language === language)?.voice)
      .find(Boolean) ??
    normalizedVoices.find((item) => item.language.startsWith(`${preferredBase}-`))?.voice ??
    normalizedVoices.find((item) => item.language.startsWith('en-'))?.voice ??
    deviceVoices[0]
  );
}

function cleanSpokenReplyText(text: string) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/^\s*(\d+)[.)]\s+/gm, '$1. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSpokenReplyIntoChunks(text: string) {
  const normalized = cleanSpokenReplyText(text);
  if (!normalized) {
    return [];
  }

  const maxChunkLength = Math.min(280, Math.max(120, Speech.maxSpeechInputLength || 280));
  const sentencePieces = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [normalized];
  const chunks: string[] = [];
  let current = '';

  const pushChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
  };

  sentencePieces.forEach((sentence) => {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) {
      return;
    }

    if (trimmedSentence.length > maxChunkLength) {
      pushChunk(current);
      current = '';
      splitLongSpokenChunk(trimmedSentence, maxChunkLength).forEach(pushChunk);
      return;
    }

    const next = current ? `${current} ${trimmedSentence}` : trimmedSentence;
    if (next.length > maxChunkLength) {
      pushChunk(current);
      current = trimmedSentence;
      return;
    }

    current = next;
  });

  pushChunk(current);
  return chunks;
}

function splitLongSpokenChunk(text: string, maxLength: number) {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current = '';

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength) {
      if (current) {
        chunks.push(current);
      }
      current = word;
      return;
    }

    current = next;
  });

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function isLikelyVoiceHallucination(transcript: string, recordedSeconds: number) {
  const normalized = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const genericClosings = new Set([
    'thank you',
    'thanks',
    'thank you so much',
    'salamat',
    'salamat po',
    'maraming salamat',
    'okay',
    'ok',
  ]);

  if (genericClosings.has(normalized)) {
    return true;
  }

  const wordCount = normalized ? normalized.split(' ').length : 0;
  return recordedSeconds < 2.5 && wordCount <= 2;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F7FAFC',
  },
  keyboardAvoiding: {
    flex: 1,
  },
  appShell: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) + 12 : 12,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  appName: {
    color: '#0F172A',
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '800',
    maxWidth: 250,
  },
  headerMeta: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 3,
    fontWeight: '600',
  },
  simpleToggle: {
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  simpleToggleActive: {
    backgroundColor: '#0F172A',
    borderColor: '#0F172A',
  },
  simpleToggleText: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '800',
  },
  simpleToggleTextActive: {
    color: '#FFFFFF',
  },
  categoryWrap: {
    minHeight: 54,
  },
  categoryList: {
    paddingHorizontal: 18,
    paddingVertical: 6,
    gap: 8,
  },
  categoryPill: {
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  categoryText: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
  },
  categoryTextActive: {
    color: '#FFFFFF',
  },
  screenBody: {
    flex: 1,
  },
  scrollContent: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 100,
    gap: 14,
  },
  pageFooter: {
    borderTopWidth: 1,
    borderColor: '#DDE8E3',
    paddingTop: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  pageFooterText: {
    color: '#475569',
    fontSize: 11,
    lineHeight: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  voiceCard: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    shadowColor: '#0F172A',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  voiceInfo: {
    flex: 1,
  },
  voiceLabel: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '700',
  },
  voiceTime: {
    color: '#0F172A',
    fontSize: 22,
    fontWeight: '900',
    marginTop: 2,
  },
  voiceTimeLow: {
    color: '#DC2626',
  },
  voiceSubLabel: {
    color: '#64748B',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    marginTop: 3,
  },
  voiceActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  micButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonActive: {
    backgroundColor: '#DC2626',
  },
  micButtonLocked: {
    backgroundColor: '#94A3B8',
  },
  buyVoiceButton: {
    minHeight: 32,
    borderRadius: 16,
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buyVoiceText: {
    color: '#3730A3',
    fontSize: 12,
    fontWeight: '800',
  },
  voiceSelectorCard: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
    shadowColor: '#0F172A',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 2,
  },
  voiceSelectorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  voiceSelectorTitle: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '900',
  },
  voiceSelectorSubtitle: {
    color: '#64748B',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    marginTop: 2,
  },
  voiceChoiceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 8,
  },
  voiceChoice: {
    width: '48%',
    minHeight: 74,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DCE8E5',
    backgroundColor: '#F8FAFC',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  voiceChoiceActive: {
    backgroundColor: '#0F766E',
    borderColor: '#0F766E',
  },
  voiceChoiceIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#DFF7EF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceChoiceIconActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  voiceChoiceTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  voiceChoiceLabel: {
    color: '#0F172A',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
  },
  voiceChoiceLabelActive: {
    color: '#FFFFFF',
  },
  voiceChoiceDescription: {
    color: '#64748B',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    marginTop: 2,
  },
  voiceChoiceDescriptionActive: {
    color: '#DFF7EF',
  },
  companionStage: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 4,
    paddingBottom: 2,
  },
  avatarOuter: {
    width: 210,
    height: 210,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarRing: {
    position: 'absolute',
    width: 184,
    height: 184,
    borderRadius: 92,
    borderWidth: 2,
  },
  avatarBody: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  avatarFace: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  avatarGlow: {
    position: 'absolute',
    top: 20,
    width: 88,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    opacity: 0.72,
  },
  eyeRow: {
    flexDirection: 'row',
    gap: 30,
    marginBottom: 18,
  },
  eye: {
    width: 15,
    height: 22,
    borderRadius: 8,
  },
  mouth: {
    height: 8,
    width: 30,
    borderRadius: 12,
  },
  avatarBadge: {
    position: 'absolute',
    right: 0,
    bottom: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  thinkingDots: {
    position: 'absolute',
    right: 22,
    top: 44,
    flexDirection: 'row',
    gap: 5,
  },
  thinkingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
    marginTop: -4,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  quickButton: {
    width: '48%',
    minHeight: 74,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: '#0F172A',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 2,
  },
  quickIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickText: {
    flex: 1,
    color: '#0F172A',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  infoBand: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  infoIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoTextWrap: {
    flex: 1,
  },
  infoTitle: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '900',
  },
  infoBody: {
    color: '#475569',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
    fontWeight: '600',
  },
  sectionBlock: {
    gap: 9,
  },
  sectionTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '900',
  },
  recentList: {
    gap: 8,
  },
  recentButton: {
    minHeight: 42,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recentText: {
    flex: 1,
    color: '#475569',
    fontSize: 13,
    fontWeight: '700',
  },
  chatWrap: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
    shadowColor: '#0F172A',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  messageList: {
    gap: 8,
  },
  messageBubble: {
    maxWidth: '90%',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#F1F5F9',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0F172A',
  },
  messageText: {
    color: '#263445',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  inputRow: {
    minHeight: 54,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 6,
    gap: 8,
  },
  textInput: {
    flex: 1,
    maxHeight: 92,
    color: '#0F172A',
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 10,
    fontWeight: '600',
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adminHeader: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 16,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  adminHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  adminHeaderText: {
    flex: 1,
  },
  adminTitle: {
    color: '#0F172A',
    fontSize: 22,
    fontWeight: '900',
  },
  adminMeta: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  adminAccessPanel: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 18,
    gap: 12,
    shadowColor: '#0F172A',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  adminAccessIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#DFF7EF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountSummaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  accountStat: {
    width: '48%',
    minHeight: 62,
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 11,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  accountStatLabel: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '800',
  },
  accountStatValue: {
    color: '#0F172A',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
    marginTop: 3,
  },
  accountStatValueCompact: {
    fontSize: 11,
    lineHeight: 15,
  },
  authModeRow: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  authModeButton: {
    flex: 1,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authModeButtonActive: {
    backgroundColor: '#0F172A',
  },
  authModeText: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '900',
  },
  authModeTextActive: {
    color: '#FFFFFF',
  },
  noticeBox: {
    borderRadius: 8,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  noticeText: {
    flex: 1,
    color: '#92400E',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryButtonText: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '900',
  },
  authStatus: {
    color: '#0F766E',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '800',
  },
  adminLockButton: {
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  adminLockText: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '900',
  },
  permissionRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  permissionText: {
    flex: 1,
    color: '#334155',
    fontSize: 13,
    fontWeight: '800',
  },
  adminTabs: {
    gap: 8,
  },
  adminTab: {
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  adminTabActive: {
    backgroundColor: '#0F172A',
    borderColor: '#0F172A',
  },
  adminTabText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
  },
  adminTabTextActive: {
    color: '#FFFFFF',
  },
  adminSection: {
    gap: 10,
  },
  adminInputWrap: {
    gap: 6,
  },
  adminInputLabel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
  },
  adminInput: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '600',
  },
  adminMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  adminSaveButton: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: '#0F172A',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonDisabled: {
    backgroundColor: '#94A3B8',
  },
  adminSaveText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  adminRow: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  adminRowText: {
    flex: 1,
  },
  adminRowTitle: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '900',
  },
  adminRowBody: {
    color: '#64748B',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    fontWeight: '600',
  },
  adminRowActions: {
    flexDirection: 'row',
    gap: 6,
  },
  adminIconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userManageRow: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    gap: 12,
  },
  userManageTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  userManageText: {
    flex: 1,
  },
  userIdText: {
    color: '#64748B',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    marginTop: 3,
  },
  roleBadge: {
    minHeight: 28,
    borderRadius: 14,
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleBadgeAdmin: {
    backgroundColor: '#DCFCE7',
  },
  roleBadgeText: {
    color: '#0369A1',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  roleBadgeTextAdmin: {
    color: '#166534',
  },
  userTimeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 8,
  },
  addMinutesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  minutesInput: {
    flex: 1,
  },
  addMinutesButton: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  addMinutesText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  typeChip: {
    minHeight: 34,
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeChipActive: {
    backgroundColor: '#E0F2FE',
    borderColor: '#38BDF8',
  },
  typeChipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
  },
  typeChipTextActive: {
    color: '#0369A1',
  },
  feedbackRow: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  ratingBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#DCFCE7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingBadgeText: {
    color: '#166534',
    fontWeight: '900',
  },
  feedbackMessage: {
    flex: 1,
    color: '#475569',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  feedbackPanel: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  ratingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  ratingButton: {
    flexBasis: 44,
    flexGrow: 1,
    maxWidth: 66,
    minWidth: 44,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingButtonActive: {
    backgroundColor: '#0F172A',
    borderColor: '#0F172A',
  },
  ratingButtonText: {
    color: '#475569',
    fontWeight: '900',
  },
  ratingButtonTextActive: {
    color: '#FFFFFF',
  },
  packageRow: {
    minHeight: 62,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  packageInfo: {
    flex: 1,
    minWidth: 180,
  },
  packageLabel: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '900',
  },
  packageStatus: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  packagePrice: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '900',
    flexShrink: 0,
  },
  floatingVoiceWrap: {
    position: 'absolute',
    right: 22,
    bottom: 102,
    alignItems: 'flex-end',
    zIndex: 20,
  },
  floatingVoiceStatus: {
    minHeight: 34,
    maxWidth: 220,
    borderRadius: 17,
    paddingHorizontal: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginBottom: 9,
    shadowColor: '#0F172A',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  floatingVoiceStatusIdle: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
  },
  floatingVoiceStatusListening: {
    backgroundColor: '#ECFDF5',
    borderColor: '#99F6E4',
  },
  floatingVoiceStatusProcessing: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  floatingVoiceStatusSpeaking: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  floatingVoiceStatusLocked: {
    backgroundColor: '#F8FAFC',
    borderColor: '#CBD5E1',
  },
  floatingVoiceStatusText: {
    color: '#0F172A',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '900',
  },
  floatingVoiceStatusTextLocked: {
    color: '#64748B',
  },
  voiceWaveform: {
    width: 28,
    height: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  voiceWaveBar: {
    width: 4,
    height: 14,
    borderRadius: 2,
    backgroundColor: '#0F766E',
  },
  floatingMicButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  floatingMicButtonIdle: {
    backgroundColor: '#0F172A',
  },
  floatingMicButtonListening: {
    backgroundColor: '#0F766E',
  },
  floatingMicButtonProcessing: {
    backgroundColor: '#D97706',
  },
  floatingMicButtonSpeaking: {
    backgroundColor: '#2563EB',
  },
  floatingMicButtonLocked: {
    backgroundColor: '#94A3B8',
  },
  floatingMicButtonPressed: {
    transform: [{ scale: 0.96 }],
  },
  floatingMicButtonDisabled: {
    opacity: 0.86,
  },
  floatingMicPulse: {
    position: 'absolute',
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: '#14B8A6',
  },
  bottomNav: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 14,
    height: 66,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 4,
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  navItem: {
    flex: 1,
    height: 54,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 2,
  },
  navItemActive: {
    backgroundColor: '#EEF2FF',
  },
  navText: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
  },
  navTextActive: {
    color: '#0F172A',
  },

  // ── Header layout ────────────────────────────────────────────────
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },

  // ── Theme toggle ─────────────────────────────────────────────────
  themeToggle: {
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
    gap: 2,
  },
  themeToggleButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeToggleButtonActive: {
    backgroundColor: '#0F172A',
  },


  safeAreaDark: {
    backgroundColor: '#07111F',
  },
  headerDark: {
    backgroundColor: 'transparent',
  },
  appNameDark: {
    color: '#F1F5F9',
  },
  headerMetaDark: {
    color: '#94A3B8',
  },
  simpleToggleDark: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
  },
  simpleToggleTextDark: {
    color: '#CBD5E1',
  },
  categoryPillDark: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
  },
  categoryTextDark: {
    color: '#CBD5E1',
  },
  // Generic reusable dark tokens
  textDark: {
    color: '#F1F5F9',
  },
  metaDark: {
    color: '#94A3B8',
  },

  // ── Quick actions ────────────────────────────────────────────────
  quickButtonDark: {
    backgroundColor: '#1E293B',
  },
  quickTextDark: {
    color: '#F1F5F9',
  },

  // ── InfoBand ─────────────────────────────────────────────────────
  infoBandDark: {
    backgroundColor: '#1E293B',
  },
  infoTitleDark: {
    color: '#F1F5F9',
  },
  infoBodyDark: {
    color: '#94A3B8',
  },

  // ── Recent questions ─────────────────────────────────────────────
  sectionTitleDark: {
    color: '#F1F5F9',
  },
  recentButtonDark: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
  },
  recentTextDark: {
    color: '#CBD5E1',
  },

  // ── Chat panel ───────────────────────────────────────────────────
  chatWrapDark: {
    backgroundColor: '#1E293B',
  },
  assistantBubbleDark: {
    backgroundColor: '#0F2030',
  },
  messageTextDark: {
    color: '#CBD5E1',
  },
  inputRowDark: {
    backgroundColor: '#182231',
    borderColor: '#334155',
  },
  textInputDark: {
    color: '#F1F5F9',
  },

  // ── Page footer ──────────────────────────────────────────────────
  pageFooterDark: {
    borderColor: '#1E293B',
  },
  pageFooterTextDark: {
    color: '#64748B',
  },

  // ── Account / Auth panels ────────────────────────────────────────
  adminAccessPanelDark: {
    backgroundColor: '#1E293B',
  },
  adminAccessIconDark: {
    backgroundColor: '#0F2030',
  },
  accountStatDark: {
    backgroundColor: '#0F2030',
    borderColor: '#334155',
  },
  authModeRowDark: {
    backgroundColor: '#0F2030',
    borderColor: '#334155',
  },
  authModeTextDark: {
    color: '#94A3B8',
  },
  secondaryButtonDark: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
  },
  secondaryButtonTextDark: {
    color: '#CBD5E1',
  },

  // ── Admin inputs ─────────────────────────────────────────────────
  adminInputLabelDark: {
    color: '#94A3B8',
  },
  adminInputDark: {
    backgroundColor: '#0F2030',
    borderColor: '#334155',
    color: '#F1F5F9',
  },

  // ── Feedback / shared panels ─────────────────────────────────────
  feedbackPanelDark: {
    backgroundColor: '#1E293B',
  },
  packageRowDark: {
    backgroundColor: '#0F2030',
    borderColor: '#334155',
  },
  permissionTextDark: {
    color: '#CBD5E1',
  },
  ratingButtonDark: {
    backgroundColor: '#0F2030',
    borderColor: '#334155',
  },
  ratingButtonTextDark: {
    color: '#94A3B8',
  },

  // ── Bottom nav ───────────────────────────────────────────────────
  bottomNavDark: {
    backgroundColor: 'rgba(15,23,42,0.97)',
    borderColor: '#1E293B',
  },
  navTextDark: {
    color: '#64748B',
  },
  navItemActiveDark: {
    backgroundColor: '#1E293B',
  },
  navTextActiveDark: {
    color: '#E2E8F0',
  },
});
