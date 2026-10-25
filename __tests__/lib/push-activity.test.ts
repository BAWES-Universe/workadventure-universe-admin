import { FRONT_FRESH_MS, JUST_LEFT_HOLD_MS, MAX_FRONT_TABS, isFront, messageDecision, nextActivity, readActivityReport, type Activity } from '@/lib/push-activity';

jest.mock('@/lib/db', () => ({ prisma: {} }));

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 18, 0, seconds));
const empty: Activity = { fronts: {}, leftChatRoomId: null, leftChatAt: null };
const frontAt = (time: Date): Activity => ({ ...empty, fronts: { t: { at: time.getTime(), chatRoomId: null } } });

describe('where someone is in Universe', () => {
  it('reads a report, and drops the chat when Universe is not in front', () => {
    expect(readActivityReport({ tabId: 'tab-12345', front: true, chatRoomId: '!dm:chat' })).toEqual({ tabId: 'tab-12345', front: true, chatRoomId: '!dm:chat' });
    expect(readActivityReport({ tabId: 'tab-12345', front: false, chatRoomId: '!dm:chat' })).toEqual({ tabId: 'tab-12345', front: false, chatRoomId: null });
    expect(readActivityReport({ tabId: 'x', front: true })).toBeNull();
    expect(readActivityReport({ tabId: 'tab-12345', front: 'yes' })).toBeNull();
  });

  it('notes the chat just left when another opens, and when Universe goes to the back', () => {
    const open = nextActivity(null, { tabId: 'tab-a', front: true, chatRoomId: '!dm:chat' }, at(0));
    expect(open).toMatchObject({ fronts: { 'tab-a': { at: at(0).getTime(), chatRoomId: '!dm:chat' } }, leftChatRoomId: null });

    const switched = nextActivity(open, { tabId: 'tab-a', front: true, chatRoomId: '!other:chat' }, at(10));
    expect(switched).toMatchObject({ fronts: { 'tab-a': { chatRoomId: '!other:chat' } }, leftChatRoomId: '!dm:chat', leftChatAt: at(10) });

    const back = nextActivity(switched, { tabId: 'tab-a', front: false, chatRoomId: null }, at(20));
    expect(back).toEqual({ fronts: {}, leftChatRoomId: '!other:chat', leftChatAt: at(20) });
    expect(isFront(back, at(20))).toBe(false);
  });

  it('keeps each device in front on its own: one going to the back leaves the other in front', () => {
    const phone = nextActivity(null, { tabId: 'tab-a', front: true, chatRoomId: null }, at(0));
    const both = nextActivity(phone, { tabId: 'tab-b', front: true, chatRoomId: '!dm:chat' }, at(5));
    // The one that reported last goes to the back: the other is still in front
    const laptopBack = nextActivity(both, { tabId: 'tab-b', front: false, chatRoomId: null }, at(10));
    expect(isFront(laptopBack, at(10))).toBe(true);
    expect(Object.keys(laptopBack.fronts)).toEqual(['tab-a']);
    expect(laptopBack).toMatchObject({ leftChatRoomId: '!dm:chat', leftChatAt: at(10) });
    // Until the other stops reporting
    expect(isFront(laptopBack, new Date(at(0).getTime() + FRONT_FRESH_MS))).toBe(false);
  });

  it('forgets tabs that stopped reporting, and keeps at most the newest few', () => {
    let activity: Activity | null = nextActivity(null, { tabId: 'tab-old', front: true, chatRoomId: null }, at(0));
    activity = nextActivity(activity, { tabId: 'tab-new', front: true, chatRoomId: null }, at(50));
    expect(Object.keys(activity.fronts)).toEqual(['tab-new']);
    for (let tab = 0; tab < MAX_FRONT_TABS + 3; tab++) {
      activity = nextActivity(activity, { tabId: `tab-${tab}`, front: true, chatRoomId: null }, at(51 + tab));
    }
    expect(Object.keys(activity.fronts)).toHaveLength(MAX_FRONT_TABS);
    expect(activity.fronts[`tab-${MAX_FRONT_TABS + 2}`]).toBeDefined();
  });

  it('counts Universe in front only while its reports are fresh', () => {
    const front = frontAt(at(0));
    expect(isFront(front, new Date(at(0).getTime() + FRONT_FRESH_MS - 1))).toBe(true);
    expect(isFront(front, new Date(at(0).getTime() + FRONT_FRESH_MS))).toBe(false);
  });
});

describe('a new direct message', () => {
  it('sends nothing while Universe is in front on any device', () => {
    expect(messageDecision(frontAt(at(0)), '!dm:chat', at(10))).toEqual({ skip: true });
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
