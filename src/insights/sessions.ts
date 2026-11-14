import {
  Global,
  GoneException,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChatMessage } from './contracts';
interface Session {
  id: string;
  userId: string;
  month: string;
  createdAt: number;
  lastUsedAt: number;
  turns: number;
  history: ChatMessage[];
  busy: boolean;
  dataVersion: string | null;
}
@Injectable()
export class InsightsSessions implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();
  private readonly operations = new Map<string, Set<AbortController>>();
  private timer?: NodeJS.Timeout;
  onModuleInit() {
    this.timer = setInterval(() => this.sweep(), 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const set of this.operations.values()) for (const c of set) c.abort();
    this.operations.clear();
    this.sessions.clear();
  }
  private expired(s: Session) {
    return Date.now() - s.lastUsedAt >= 30 * 60000 || Date.now() - s.createdAt >= 2 * 3600000;
  }
  sweep() {
    for (const [id, s] of this.sessions) if (this.expired(s)) this.sessions.delete(id);
  }
  create(userId: string, month: string) {
    this.sweep();
    if (
      this.sessions.size >= 128 ||
      [...this.sessions.values()].filter((s) => s.userId === userId).length >= 3
    )
      throw new ServiceUnavailableException('INSIGHTS_SESSION_CAPACITY_EXCEEDED');
    const now = Date.now();
    const s: Session = {
      id: randomUUID(),
      userId,
      month,
      createdAt: now,
      lastUsedAt: now,
      turns: 0,
      history: [],
      busy: false,
      dataVersion: null,
    };
    this.sessions.set(s.id, s);
    return this.present(s);
  }
  private owned(userId: string, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.userId !== userId) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if (this.expired(s)) {
      this.sessions.delete(id);
      throw new GoneException('CONVERSATION_EXPIRED');
    }
    return s;
  }
  present(s: Session) {
    return {
      conversationId: s.id,
      month: s.month,
      expiresAt: new Date(
        Math.min(s.lastUsedAt + 30 * 60000, s.createdAt + 2 * 3600000),
      ).toISOString(),
      remainingExchanges: 12 - s.turns,
    };
  }
  acquire(userId: string, id: string) {
    const s = this.owned(userId, id);
    if (s.busy) throw new ConflictException('CONVERSATION_BUSY');
    if (s.turns >= 12) throw new GoneException('CONVERSATION_LIMIT_REACHED');
    s.busy = true;
    return {
      session: s,
      release: () => {
        s.busy = false;
      },
    };
  }
  current(userId: string, id: string) {
    return this.owned(userId, id);
  }
  append(userId: string, id: string, question: string, answer: string, dataVersion: string) {
    const s = this.owned(userId, id);
    s.history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer.slice(0, 4000) },
    );
    while (s.history.reduce((sum, m) => sum + m.content.length, 0) > 24000 && s.history.length > 2)
      s.history.splice(0, 2);
    s.turns++;
    s.lastUsedAt = Date.now();
    s.dataVersion = dataVersion;
    return this.present(s);
  }
  delete(userId: string, id: string) {
    this.owned(userId, id);
    this.sessions.delete(id);
    return { deleted: true };
  }
  clearUser(userId: string) {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
    for (const c of this.operations.get(userId) ?? []) c.abort();
    this.operations.delete(userId);
  }
  operation(userId: string) {
    const c = new AbortController();
    const set = this.operations.get(userId) ?? new Set<AbortController>();
    set.add(c);
    this.operations.set(userId, set);
    return {
      signal: c.signal,
      release: () => {
        set.delete(c);
        if (!set.size && this.operations.get(userId) === set) this.operations.delete(userId);
      },
    };
  }
}
@Global()
@Module({ providers: [InsightsSessions], exports: [InsightsSessions] })
export class InsightsSessionsModule {}
