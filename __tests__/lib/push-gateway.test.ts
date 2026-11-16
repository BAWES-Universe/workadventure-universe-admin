import { handleGatewayNotification, isDirectMessage, isOurBot, messageLine, OWN_INITIATIVE_KEY, pushText, readNotification } from '@/lib/push-gateway';
import { sendPush } from '@/lib/push';
import { getActivity } from '@/lib/push-activity';
import { DEFAULT_PUSH_SETTINGS, getPushSettings } from '@/lib/push-settings';
import { sharesMemberWorld } from '@/lib/friends';
import { prisma } from '@/lib/db';

jest.mock('@/lib/push', () => ({ sendPush: jest.fn(async () => 1) }));
jest.mock('@/lib/push-activity', () => ({ ...jest.requireActual('@/lib/push-activity'), getActivity: jest.fn(async () => null) }));
jest.mock('@/lib/push-settings', () => ({ ...jest.requireActual('@/lib/push-settings'), getPushSettings: jest.fn() }));
jest.mock('@/lib/friends', () => ({ ...jest.requireActual('@/lib/friends'), sharesMemberWorld: jest.fn(async () => false) }));
jest.mock('@/lib/db', () => ({
  prisma: {
    pushDevice: { findMany: jest.fn() },
    user: { findFirst: jest.fn() },
    friendship: { findUnique: jest.fn() },
  },
}));

const SECRET = 's'.repeat(43);
const device = { id: 'd1', userId: 'user-k', gatewaySecret: SECRET, user: { matrixChatId: '@khalid:chat' } };

function post(overrides: Record<string, unknown> = {}, deviceOverrides: Record<string, unknown> = {}) {
  return {
    notification: {
      event_id: '$event',
      room_id: '!dm:chat',
      type: 'm.room.message',
      sender: '@sara:chat',
      sender_display_name: 'Sara',
      content: { msgtype: 'm.text', body: 'are you coming to standup?' },
      counts: { unread: 1 },
      devices: [{ app_id: 'net.bawes.universe.web', pushkey: 'd1', data: { url: 'x', secret: SECRET }, tweaks: { sound: 'default' }, ...deviceOverrides }],
      ...overrides,
    },
  };
}

/** Lets the sending that goes on after the answer finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the push gateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.pushDevice.findMany as jest.Mock).mockResolvedValue([device]);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'user-s' });
    (prisma.friendship.findUnique as jest.Mock).mockResolvedValue({ status: 'accepted' });
    (getPushSettings as jest.Mock).mockResolvedValue(DEFAULT_PUSH_SETTINGS);
    (getActivity as jest.Mock).mockResolvedValue(null);
    (sharesMemberWorld as jest.Mock).mockResolvedValue(false);
  });

  it('notifies this one device of a friend’s direct message: name, line, one per chat', async () => {
    expect(await handleGatewayNotification(post())).toEqual({ rejected: [] });
    await settle();
    expect(sendPush).toHaveBeenCalledWith(
      'user-k',
      'directMessages',
      { title: 'Sara', body: 'are you coming to standup?', tag: 'chat:!dm:chat', chatRoomId: '!dm:chat' },
      { urgency: 'high', deviceIds: ['d1'] },
    );
  });

  it('drops a device that is gone, or whose secret no longer matches, and sends it nothing', async () => {
    (prisma.pushDevice.findMany as jest.Mock).mockResolvedValue([{ ...device, gatewaySecret: 'other'.repeat(9) }]);
    expect(await handleGatewayNotification(post())).toEqual({ rejected: ['d1'] });
    (prisma.pushDevice.findMany as jest.Mock).mockResolvedValue([]);
    expect(await handleGatewayNotification(post())).toEqual({ rejected: ['d1'] });
    await settle();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('ignores pushers of other apps, and answers null to something that is not a notification', async () => {
    expect(await handleGatewayNotification(post({}, { app_id: 'im.vector.app' }))).toEqual({ rejected: [] });
    expect(await handleGatewayNotification({ nope: true })).toBeNull();
  });

  it.each([
    ['an unread count change', { event_id: undefined }, {}],
    ['a message in a group chat', {}, { tweaks: {} }],
    ['a mention in a named group chat', { room_name: 'Main Hall' }, { tweaks: { sound: 'default', highlight: true } }],
    ['someone joining', { type: 'm.room.member' }, {}],
    ['their own message from another device', { sender: '@khalid:chat' }, {}],
  ])('sends nothing for %s', async (_label, overrides, deviceOverrides) => {
    await handleGatewayNotification(post(overrides, deviceOverrides));
    await settle();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('notifies a mention in a direct message', async () => {
    await handleGatewayNotification(post({}, { tweaks: { sound: 'default', highlight: true } }));
    await settle();
    expect(sendPush).toHaveBeenCalled();
  });

  it('lets a bot reply through, whatever "from" says', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, dmFrom: 'friends' });
    await handleGatewayNotification(post({ sender: '@bot_nova:chat', sender_display_name: 'Nova' }));
    await settle();
    expect(sendPush).toHaveBeenCalledWith('user-k', 'directMessages', expect.objectContaining({ title: 'Nova' }), expect.anything());
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('treats a bot name from another server as anyone else: blocked and "from" still apply', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, dmFrom: 'friends' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await handleGatewayNotification(post({ sender: '@bot_nova:other.server', sender_display_name: 'Nova' }));
    await settle();
    expect(sendPush).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { matrixChatId: '@bot_nova:other.server' } }));
  });

  it('follows "Direct messages from": members of a shared world pass with Friends and members only', async () => {
    (prisma.friendship.findUnique as jest.Mock).mockResolvedValue(null);
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).not.toHaveBeenCalled();

    (sharesMemberWorld as jest.Mock).mockResolvedValue(true);
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).toHaveBeenCalledTimes(1);

    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, dmFrom: 'friends' });
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('never notifies from someone blocked, even with Anyone; strangers only with Anyone', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, dmFrom: 'anyone' });
    (prisma.friendship.findUnique as jest.Mock).mockResolvedValue({ status: 'blocked' });
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).not.toHaveBeenCalled();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('sends nothing with direct messages switched off', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, directMessages: false });
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('sends nothing while Universe is in front on any of their devices', async () => {
    (getActivity as jest.Mock).mockResolvedValue({ fronts: { t: { at: Date.now(), chatRoomId: null } }, leftChatRoomId: null, leftChatAt: null });
    await handleGatewayNotification(post());
    await settle();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('waits a minute after the chat was left, and sends nothing if they came back', async () => {
    jest.useFakeTimers();
    try {
      const left = { fronts: {}, leftChatRoomId: '!dm:chat', leftChatAt: new Date() };
      (getActivity as jest.Mock).mockResolvedValueOnce(left).mockResolvedValueOnce({ ...left, fronts: { t: { at: Date.now() + 59_000, chatRoomId: null } } });
      await handleGatewayNotification(post());
      await jest.advanceTimersByTimeAsync(30_000);
      expect(sendPush).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(31_000);
      expect(sendPush).not.toHaveBeenCalled();

      (getActivity as jest.Mock).mockResolvedValueOnce({ ...left, leftChatAt: new Date() }).mockResolvedValueOnce(left);
      await handleGatewayNotification(post());
      await jest.advanceTimersByTimeAsync(61_000);
      expect(sendPush).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('one of our bots', () => {
  it('is @bot_… on the recipient’s own homeserver, nowhere else', () => {
    expect(isOurBot('@bot_nova:chat.bawes.net', '@khalid:chat.bawes.net')).toBe(true);
    expect(isOurBot('@bot_nova:other.server', '@khalid:chat.bawes.net')).toBe(false);
    expect(isOurBot('@bot_nova:bawes.net', '@khalid:chat.bawes.net')).toBe(false);
    expect(isOurBot('@sara:chat.bawes.net', '@khalid:chat.bawes.net')).toBe(false);
    expect(isOurBot('@bot_nova:chat.bawes.net', null)).toBe(false);
  });
});

describe('what a locked phone shows for a Brick that spoke by itself (game #2002, t-3-lock)', () => {
  const alone = (body: string, extra: Record<string, unknown> = {}) =>
    readNotification(post({ sender: '@bot_nova:chat', sender_display_name: 'Brick', content: { msgtype: 'm.text', body, [OWN_INITIATIVE_KEY]: true, ...extra } }))!;

  it('puts the news in the title and the rest after the Brick’s name', () => {
    const notification = alone('Your visa is approved. It is in our chat and saved in my files. Goal done.');
    expect(pushText(notification, true, 'Brick', true)).toEqual({
      title: 'Your visa is approved',
      body: 'Brick: It is in our chat and saved in my files. Goal done.',
    });
  });

  it('reads past formatting, and answers with the Brick’s name alone when there is nothing after the news', () => {
    expect(pushText(alone('**Visa approved!** See [your visa](https://example.com/v) in the chat.'), true, 'Brick', true)).toEqual({
      title: 'Visa approved',
      body: 'Brick: See your visa in the chat.',
    });
    expect(pushText(alone('Nothing scheduled today.'), true, 'Brick', true)).toEqual({ title: 'Nothing scheduled today', body: 'Brick' });
  });

  it('does not cut the news at an abbreviation or an initial, and cuts at the end of a sentence in any script', () => {
    expect(pushText(alone('Dr. Lee approved your visa. Goal done.'), true, 'Brick', true)).toEqual({ title: 'Dr. Lee approved your visa', body: 'Brick: Goal done.' });
    expect(pushText(alone('J. Smith sent the form. Please check it.'), true, 'Brick', true).title).toBe('J. Smith sent the form');
    // A lowercase letter before the stop is the end of a sentence, not an initial
    expect(pushText(alone('The visa is option a. Please check it.'), true, 'Brick', true)).toEqual({ title: 'The visa is option a', body: 'Brick: Please check it.' });
    // Everyday words that end a sentence are not abbreviations
    expect(pushText(alone('The answer from the office is no. Please check it.'), true, 'Brick', true).title).toBe('The answer from the office is no');
    // An Arabic question mark and a full stop in Chinese end one too
    expect(pushText(alone('هل تمت الموافقة على التأشيرة؟ تم الأمر في المحادثة.'), true, 'Brick', true)).toEqual({
      title: 'هل تمت الموافقة على التأشيرة',
      body: 'Brick: تم الأمر في المحادثة.',
    });
    expect(pushText(alone('签证已批准。已保存在聊天中。'), true, 'Brick', true).title).toBe('签证已批准');
    // A Hindi danda ends one too
    expect(pushText(alone('वीज़ा स्वीकृत है। चैट में सहेजा गया।'), true, 'Brick', true)).toEqual({ title: 'वीज़ा स्वीकृत है', body: 'Brick: चैट में सहेजा गया।' });
    // A closing quote after the stop stays with the sentence; an abbreviation inside quotes does not end it
    expect(pushText(alone('\u201CVisa approved.\u201D Details are in chat.'), true, 'Brick', true)).toEqual({ title: '\u201CVisa approved\u201D', body: 'Brick: Details are in chat.' });
    expect(pushText(alone('\u201CWe met Dr.\u201D Lee approved it. Done.'), true, 'Brick', true).title).toBe('\u201CWe met Dr.\u201D Lee approved it');
    // Too short to be a title
    expect(pushText(alone('Ok. Done and saved.'), true, 'Brick', true).title).toBe('Brick');
  });

  it('removes only paired formatting, so names and addresses stay as written', () => {
    expect(pushText(alone('doc_id_42 is ready. Done.'), true, 'Brick', true).title).toBe('doc_id_42 is ready');
    expect(pushText(alone('[page](https://x.test/a_(b)) is live. Ok.'), true, 'Brick', true).title).toBe('page is live');
    expect(pushText(alone('## __Visa__ approved! *Goal* done in `the chat`.'), true, 'Brick', true)).toEqual({
      title: 'Visa approved',
      body: 'Brick: Goal done in the chat.',
    });
    expect(pushText(alone('Paid 5 * 3 in #42 today. Done.'), true, 'Brick', true).title).toBe('Paid 5 * 3 in #42 today');
  });

  it('shows everything else the ordinary way', () => {
    const own = alone('Your visa is approved. Goal done.');
    // Not marked as its own doing: an answer in a chat
    const answer = readNotification(post({ sender: '@bot_nova:chat', sender_display_name: 'Brick', content: { msgtype: 'm.text', body: 'Your visa is approved. Goal done.' } }))!;
    expect(pushText(answer, true, 'Brick', true)).toEqual({ title: 'Brick', body: 'Your visa is approved. Goal done.' });
    // Marked, but not by one of our bots: anyone could set the mark
    expect(pushText(own, true, 'Brick', false)).toEqual({ title: 'Brick', body: 'Your visa is approved. Goal done.' });
    // Message text switched off
    expect(pushText(own, false, 'Brick', true)).toEqual({ title: 'Brick', body: 'New message from Brick' });
    // A first sentence too long for a title, and one with no end
    const long = alone(`${'a'.repeat(90)}. Done.`);
    expect(pushText(long, true, 'Brick', true).title).toBe('Brick');
    expect(pushText(alone('no sentence end here'), true, 'Brick', true).title).toBe('Brick');
    // A file or an image
    expect(pushText(alone('x', { msgtype: 'm.image' }), true, 'Brick', true)).toEqual({ title: 'Brick', body: 'sent an image' });
  });

  it('reaches the device that way through the gateway, for our bot only', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue(DEFAULT_PUSH_SETTINGS);
    await handleGatewayNotification(
      post({ sender: '@bot_nova:chat', sender_display_name: 'Brick', content: { msgtype: 'm.text', body: 'Your visa is approved. Goal done.', [OWN_INITIATIVE_KEY]: true } }),
    );
    await settle();
    expect(sendPush).toHaveBeenCalledWith(
      'user-k',
      'directMessages',
      expect.objectContaining({ title: 'Your visa is approved', body: 'Brick: Goal done.', tag: 'chat:!dm:chat' }),
      expect.anything(),
    );
  });
});

describe('reading the gateway body', () => {
  it('takes at most 20 devices, so a big body cannot force a big query', () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ app_id: 'net.bawes.universe.web', pushkey: `d${index}`, data: {}, tweaks: {} }));
    const read = readNotification({ notification: { devices: many } })!;
    expect(read.devices).toHaveLength(20);
    expect(read.devices[0].pushkey).toBe('d0');
  });
});

describe('a direct message notification', () => {
  const notification = readNotification(post())!;

  it('shows the text, or what was sent, or "New message from Sara" with text off', () => {
    expect(messageLine(notification, true, 'Sara')).toBe('are you coming to standup?');
    expect(messageLine(notification, false, 'Sara')).toBe('New message from Sara');
    expect(messageLine({ ...notification, content: { msgtype: 'm.image', body: 'cat.png' } }, true, 'Sara')).toBe('sent an image');
    expect(messageLine({ ...notification, content: { msgtype: 'm.audio', body: 'Voice message.m4a', 'org.matrix.msc3245.voice': {} } }, true, 'Sara')).toBe('sent a voice message');
    expect(messageLine({ ...notification, content: { msgtype: 'm.audio', body: 'Voice message.ogg', 'm.voice': {} } }, true, 'Sara')).toBe('sent a voice message');
    expect(messageLine({ ...notification, content: { msgtype: 'm.audio', body: 'signal.mp3' } }, true, 'Sara')).toBe('sent an audio file');
    expect(messageLine({ ...notification, type: 'm.room.encrypted', content: { ciphertext: 'x' } }, true, 'Sara')).toBe('New message from Sara');
    const long = messageLine({ ...notification, content: { msgtype: 'm.text', body: 'a'.repeat(300) } }, true, 'Sara');
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is only about chats of two', () => {
    expect(isDirectMessage(notification, { sound: 'default' })).toBe(true);
    expect(isDirectMessage(notification, {})).toBe(false);
    expect(isDirectMessage({ ...notification, type: 'm.room.encrypted' }, { sound: 'default' })).toBe(true);
  });
});
