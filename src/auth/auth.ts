import {
  Inject,
  CanActivate,
  ConflictException,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Db } from '../common/db';
import { Config } from '../common/config';
import { hashToken } from '../common/privacy';
import { credentials, registration, passwordReset } from './auth.dto';
import { EmailVerification } from './email';
import { InsightsSessions } from '../insights/sessions';

type AuthRequest = Request & { userId: string; sessionId: string };
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthRequest>().userId,
);

@Injectable()
export class AuthService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Config) private readonly config: Config,
    @Inject(EmailVerification) private readonly emailVerification: EmailVerification,
    @Inject(InsightsSessions) private readonly insightsSessions: InsightsSessions,
  ) {}
  private async tokens(userId: string, client: Prisma.TransactionClient = this.db) {
    const refreshToken = randomBytes(48).toString('hex');
    const session = await client.session.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    return {
      accessToken: jwt.sign({ sid: session.id }, this.config.values.JWT_SECRET, {
        subject: userId,
        issuer: 'moneylens',
        audience: 'moneylens-api',
        expiresIn: '15m',
        algorithm: 'HS256',
      }),
      refreshToken,
      expiresIn: 900,
    };
  }
  async register(input: z.infer<typeof registration>) {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      return await this.db.$transaction(async (tx) => {
        await this.emailVerification.consume(
          tx,
          input.email,
          'registration',
          input.registrationGrant,
        );
        const user = await tx.user.create({
          data: { email: input.email, passwordHash, emailVerifiedAt: new Date() },
        });
        return this.tokens(user.id, tx);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('ACCOUNT_UNAVAILABLE');
      throw e;
    }
  }
  async resetPassword(input: z.infer<typeof passwordReset>) {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await this.db.$transaction(async (tx) => {
      await this.emailVerification.consume(tx, input.email, 'password_reset', input.grant);
      const user = await tx.user.update({
        where: { email: input.email },
        data: { passwordHash, emailVerifiedAt: new Date() },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    const owner = await this.db.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (owner) this.insightsSessions.clearUser(owner.id);
    return { updated: true };
  }
  async login(input: z.infer<typeof credentials>) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "email" = ${input.email} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { email: input.email } });
      if (!user) {
        await argon2.hash(input.password, { type: argon2.argon2id });
        throw new UnauthorizedException('INVALID_CREDENTIALS');
      }
      if (!(await argon2.verify(user.passwordHash, input.password)))
        throw new UnauthorizedException('INVALID_CREDENTIALS');
      return this.tokens(user.id, tx);
    });
  }
  async refresh(refreshToken: string) {
    return this.db.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
      });
      if (session)
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${session.userId} FOR UPDATE`;
      if (!session || session.revokedAt || session.expiresAt <= new Date())
        throw new UnauthorizedException('INVALID_SESSION');
      const updated = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (updated.count !== 1) throw new UnauthorizedException('INVALID_SESSION');
      return this.tokens(session.userId, tx);
    });
  }
  async logout(refreshToken: string) {
    const owner = await this.db.session.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      select: { userId: true },
    });
    await this.db.session.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (owner) this.insightsSessions.clearUser(owner.userId);
    return { loggedOut: true };
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Config) private readonly config: Config,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new Error();
      const payload = jwt.verify(header.slice(7), this.config.values.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'moneylens',
        audience: 'moneylens-api',
      });
      if (
        typeof payload === 'string' ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string'
      )
        throw new Error();
      const session = await this.db.session.findFirst({
        where: {
          id: payload.sid,
          userId: payload.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!session) throw new Error();
      req.userId = session.userId;
      req.sessionId = session.id;
      return true;
    } catch {
      throw new UnauthorizedException('UNAUTHORIZED');
    }
  }
}
