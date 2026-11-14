import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightsSessions } from '../src/insights/sessions';
afterEach(() => vi.useRealTimers());
describe('ephemeral financial conversations', () => {
  it('enforces ownership and per-user capacity', () => {
    const s = new InsightsSessions();
    const a = s.create('owner', '2026-09');
    expect(() => s.acquire('other', a.conversationId)).toThrow('CONVERSATION_NOT_FOUND');
    s.create('owner', '2026-09');
    s.create('owner', '2026-09');
    expect(() => s.create('owner', '2026-09')).toThrow('INSIGHTS_SESSION_CAPACITY_EXCEEDED');
  });
  it('expires at idle and absolute deadlines', () => {
    vi.useFakeTimers();
    const s = new InsightsSessions();
    const a = s.create('u', '2026-09');
    vi.advanceTimersByTime(30 * 60000);
    expect(() => s.acquire('u', a.conversationId)).toThrow('CONVERSATION_EXPIRED');
    const b = s.create('u', '2026-09');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20 * 60000);
      s.append('u', b.conversationId, 'q', 'a', 'version');
    }
    vi.advanceTimersByTime(20 * 60000);
    expect(() => s.acquire('u', b.conversationId)).toThrow('CONVERSATION_EXPIRED');
  });
  it('serializes messages and bounds exchanges', () => {
    const s = new InsightsSessions();
    const a = s.create('u', '2026-09');
    const lease = s.acquire('u', a.conversationId);
    expect(() => s.acquire('u', a.conversationId)).toThrow('CONVERSATION_BUSY');
    lease.release();
    for (let i = 0; i < 12; i++) s.append('u', a.conversationId, 'q', 'a', 'version');
    expect(() => s.acquire('u', a.conversationId)).toThrow('CONVERSATION_LIMIT_REACHED');
  });
  it('clears only the owner and cancels active work', () => {
    const s = new InsightsSessions();
    const a = s.create('u', '2026-09');
    const b = s.create('other', '2026-09');
    const op = s.operation('u');
    s.clearUser('u');
    expect(op.signal.aborted).toBe(true);
    expect(() => s.acquire('u', a.conversationId)).toThrow('CONVERSATION_NOT_FOUND');
    expect(s.acquire('other', b.conversationId).session.month).toBe('2026-09');
    op.release();
  });
  it('has no conversation history after restart', () => {
    const s = new InsightsSessions();
    const a = s.create('u', '2026-09');
    s.append('u', a.conversationId, 'PRIVATE QUESTION', 'PRIVATE RESPONSE', 'v');
    expect(() => new InsightsSessions().acquire('u', a.conversationId)).toThrow(
      'CONVERSATION_NOT_FOUND',
    );
    s.onModuleDestroy();
    expect(() => s.acquire('u', a.conversationId)).toThrow('CONVERSATION_NOT_FOUND');
  });
});
