import { VOICE_LIMITS_RECOMMENDED, VOICE_RANGES, checkVoiceLimits, readVoiceLimits, textReserve, voiceReplies } from '@/lib/voice-limit-values';

describe('voice limits', () => {
  it('start on the recommended values', () => {
    expect(readVoiceLimits(null)).toEqual(VOICE_LIMITS_RECOMMENDED);
    expect(VOICE_LIMITS_RECOMMENDED).toEqual({
      textReserveShare: 6,
      guestVoiceReplies: 3,
      turnSeconds: 180,
      replyCharacters: 600,
      replySeconds: 60,
      listenMinutesPerDay: 60,
      followUpSeconds: 30,
    });
  });

  it('read back what is saved, and the recommended value for anything missing or out of range', () => {
    expect(readVoiceLimits({ turnSeconds: 120, replyCharacters: 5, followUpSeconds: 'soon', guestVoiceReplies: 2.5, extra: 1 })).toEqual({
      ...VOICE_LIMITS_RECOMMENDED,
      turnSeconds: 120,
    });
    expect(readVoiceLimits([1, 2])).toEqual(VOICE_LIMITS_RECOMMENDED);
  });

  it('accept a change to any of the limits and say which one is wrong', () => {
    expect(checkVoiceLimits({ turnSeconds: 90, listenMinutesPerDay: 0 })).toEqual({ ok: true, value: { turnSeconds: 90, listenMinutesPerDay: 0 } });
    expect(checkVoiceLimits({ turnSeconds: 1 })).toEqual({ ok: false, error: 'turnSeconds must be a whole number from 5 to 3,600' });
    expect(checkVoiceLimits({ replySeconds: 10.5 }).ok).toBe(false);
    expect(checkVoiceLimits({ followUpSeconds: '30' }).ok).toBe(false);
    expect(checkVoiceLimits({ speed: 3 })).toEqual({ ok: false, error: 'Unknown limit: speed' });
    expect(checkVoiceLimits({ constructor: 3 }).ok).toBe(false);
    expect(checkVoiceLimits('turnSeconds')).toEqual({ ok: false, error: 'Expected an object' });
  });

  it('keep every recommended value inside the values that can be saved', () => {
    for (const [key, range] of Object.entries(VOICE_RANGES)) {
      const value = VOICE_LIMITS_RECOMMENDED[key as keyof typeof VOICE_LIMITS_RECOMMENDED];
      expect(value).toBeGreaterThanOrEqual(range.min);
      expect(value).toBeLessThanOrEqual(range.max);
    }
  });
});

describe('the replies kept back for text', () => {
  it('keep 5 of 30 and 2 of 10', () => {
    expect(textReserve(30, 6)).toBe(5);
    expect(textReserve(10, 6)).toBe(2);
  });

  it('keep at least one, and never all but a window of one', () => {
    expect(textReserve(2, 6)).toBe(1);
    expect(textReserve(3, 2)).toBe(2);
    expect(textReserve(1, 6)).toBe(1);
    expect(textReserve(0, 6)).toBe(0);
  });

  it('follow the share', () => {
    expect(textReserve(30, 3)).toBe(10);
    expect(textReserve(30, 100)).toBe(1);
  });

  it('leave a person 25 voice replies of 30 and a guest 3 of 10', () => {
    expect(voiceReplies(30, VOICE_LIMITS_RECOMMENDED, false)).toBe(25);
    expect(voiceReplies(10, VOICE_LIMITS_RECOMMENDED, true)).toBe(3);
    expect(voiceReplies(10, VOICE_LIMITS_RECOMMENDED, false)).toBe(8);
  });

  it('leave a window of one text-only, and a guest never more than the window leaves', () => {
    expect(voiceReplies(1, VOICE_LIMITS_RECOMMENDED, false)).toBe(0);
    expect(voiceReplies(2, VOICE_LIMITS_RECOMMENDED, true)).toBe(1);
    expect(voiceReplies(10, { ...VOICE_LIMITS_RECOMMENDED, guestVoiceReplies: 0 }, true)).toBe(0);
  });
});
