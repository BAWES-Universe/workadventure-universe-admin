import { FRONT_FRESH_MS, JUST_LEFT_HOLD_MS, isFront, messageDecision, nextActivity, readActivityReport, type Activity } from '@/lib/push-activity';

jest.mock('@/lib/db', () => ({ prisma: {} }));

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 18, 0, seconds));
const empty: Activity = { frontAt: null, frontTabId: null, openChatRoomId: null, leftChatRoomId: null, leftChatAt: null };

describe('where someone is in Universe', () => {
  it('reads a report, and drops the chat when Universe is not in front', () => {
    expect(readActivityReport({ tabId: 'tab-12345', front: true, chatRoomId: '!dm:chat' })).toEqual({ tabId: 'tab-12345', front: true, chatRoomId: '!dm:chat' });
    expect(readActivityReport({ tabId: 'tab-12345', front: false, chatRoomId: '!dm:chat' })).toEqual({ tabId: 'tab-12345', front: false, chatRoomId: null });
    expect(readActivityReport({ tabId: 'x', front: true })).toBeNull();
    expect(readActivityReport({ tabId: 'tab-12345', front: 'yes' })).toBeNull();
  });

  it('notes the chat just left when another opens, and when Universe goes to the back', () => {
    const open = nextActivity(null, { tabId: 'tab-a', front: true, chatRoomId: '!dm:chat' }, at(0));
    expect(open).toMatchObject({ frontAt: at(0), openChatRoomId: '!dm:chat', leftChatRoomId: null });

    const switched = nextActivity(open, { tabId: 'tab-a', front: true, chatRoomId: '!other:chat' }, at(10));
    expect(switched).toMatchObject({ openChatRoomId: '!other:chat', leftChatRoomId: '!dm:chat', leftChatAt: at(10) });

    const back = nextActivity(switched, { tabId: 'tab-a', front: false, chatRoomId: null }, at(20));
    expect(back).toMatchObject({ frontAt: null, openChatRoomId: null, leftChatRoomId: '!other:chat', leftChatAt: at(20) });
  });

  it('keeps another tab in front when one tab goes to the back, until that tab stops reporting', () => {
    const front = nextActivity(null, { tabId: 'tab-a', front: true, chatRoomId: null }, at(0));
    expect(nextActivity(front, { tabId: 'tab-b', front: false, chatRoomId: null }, at(5))).toBe(front);
    expect(nextActivity(front, { tabId: 'tab-b', front: false, chatRoomId: null }, at(50)).frontAt).toBeNull();
  });

  it('counts Universe in front only while its reports are fresh', () => {
    const front = { ...empty, frontAt: at(0) };
    expect(isFront(front, new Date(at(0).getTime() + FRONT_FRESH_MS - 1))).toBe(true);
    expect(isFront(front, new Date(at(0).getTime() + FRONT_FRESH_MS))).toBe(false);
  });
});

describe('a new direct message', () => {
  it('sends nothing while Universe is in front on any device', () => {
    expect(messageDecision({ ...empty, frontAt: at(0) }, '!dm:chat', at(10))).toEqual({ skip: true });
  });

  it('waits out the minute after its chat was left', () => {
    const left = { ...empty, leftChatRoomId: '!dm:chat', leftChatAt: at(0) };
    expect(messageDecision(left, '!dm:chat', at(20))).toEqual({ waitMs: JUST_LEFT_HOLD_MS - 20_000 });
    expect(messageDecision(left, '!dm:chat', at(60))).toEqual({ send: true });
    expect(messageDecision(left, '!other:chat', at(20))).toEqual({ send: true });
  });

  it('notifies someone who is not in Universe', () => {
    expect(messageDecision(null, '!dm:chat', at(0))).toEqual({ send: true });
  });
});
