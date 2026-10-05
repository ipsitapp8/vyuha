import type { TFunction } from 'i18next';
import { ApiRequestError } from '@/lib/api';
import en from '@/i18n/en.json';

type ErrorCode = keyof typeof en.errors;
const isKnownCode = (code: string): code is ErrorCode => code in en.errors;

/** Errors whose server text is just a generic sentence are shown in the user's language. */
export function apiErrorText(t: TFunction, err: unknown, fallback?: string): string {
  if (err instanceof ApiRequestError) {
    if (isKnownCode(err.code)) return t(`errors.${err.code}`);
    return err.message; // VALIDATION_ERROR / CONFLICT carry specific detail from the server
  }
  return fallback ?? t('common.genericError');
}

/** Same for typed socket acknowledgements. */
export function ackErrorText(t: TFunction, error: { code: string; message: string }): string {
  return isKnownCode(error.code) ? t(`errors.${error.code}`) : error.message;
}

const VALIDATION_KEYS = {
  'Enter a valid email address': 'validation.email',
  'Name must be at least 2 characters': 'validation.name',
  'Password must be at least 8 characters': 'validation.passwordLength',
  'Password must contain a letter': 'validation.passwordLetter',
  'Password must contain a digit': 'validation.passwordDigit',
  'Password is required': 'validation.passwordRequired',
  'Session code is 6 letters/digits': 'validation.code',
} as const;

/** Form schemas live in the shared package (English); show their messages in the active language. */
export function validationText(t: TFunction, message: string | undefined): string | undefined {
  if (!message) return undefined;
  const key = (
    VALIDATION_KEYS as Record<string, (typeof VALIDATION_KEYS)[keyof typeof VALIDATION_KEYS]>
  )[message];
  return key ? t(key) : message;
}

const REASON_KEYS = {
  'unknown player': 'reasons.unknownPlayer',
  'your unit is out of action': 'reasons.unitOutOfAction',
  'invalid recipient': 'reasons.invalidRecipient',
  'message must be 1-500 characters': 'reasons.messageLength',
  'you cannot command that unit': 'reasons.cannotCommand',
  'destination outside the exercise area': 'reasons.outOfArea',
  'unit cannot move': 'reasons.cannotMove',
  'no ISR asset on your team': 'reasons.noIsr',
  'unknown contact': 'reasons.unknownContact',
  'no such order': 'reasons.noSuchOrder',
  'already authenticated or pending': 'reasons.alreadyAuth',
  'already on that channel': 'reasons.alreadyChannel',
  'confidence must be 0-100': 'reasons.confidenceRange',
  'rationale must be at least 10 characters': 'reasons.rationaleShort',
  'unknown message': 'reasons.unknownMessage',
  'that probe is closed': 'reasons.probeClosed',
  'you have already answered this probe': 'reasons.probeAnswered',
  'invalid position': 'reasons.invalidPosition',
  'not available in a baseline run': 'reasons.baselineRun',
} as const;

/** The engine refuses actions with short English reasons; translate the ones we know. */
export function reasonText(t: TFunction, reason: string): string {
  const key = (REASON_KEYS as Record<string, (typeof REASON_KEYS)[keyof typeof REASON_KEYS]>)[
    reason
  ];
  return key ? t(key) : reason;
}

export const REASON_TEXTS: readonly string[] = Object.keys(REASON_KEYS);
export const VALIDATION_TEXTS: readonly string[] = Object.keys(VALIDATION_KEYS);
