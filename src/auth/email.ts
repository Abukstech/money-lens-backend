import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Db } from '../common/db';
import { Config } from '../common/config';

export type EmailPurpose = 'registration' | 'password_reset';
@Injectable()
export class Mailer {
  constructor(@Inject(Config) private readonly config: Config) {}
  assertAvailable() {
    if (this.config.values.EMAIL_DELIVERY_MODE === 'console') {
      if (this.config.values.NODE_ENV !== 'development')
        throw new ServiceUnavailableException('DEVELOPMENT_EMAIL_MODE_REQUIRED');
      return;
    }
    if (!this.config.values.RESEND_API_KEY || !this.config.values.RESEND_FROM)
      throw new ServiceUnavailableException('EMAIL_NOT_CONFIGURED');
  }
 
async sendCode(
  email: string,
  code: string,
  purpose: EmailPurpose,
  requestId: string,
) {
  this.assertAvailable();

  if (this.config.values.EMAIL_DELIVERY_MODE === 'console') {
    process.stdout.write(
      `[MoneyLens development email] ${JSON.stringify({
        email,
        purpose,
        code,
        challengeId: requestId,
        expiresIn: 600,
      })}\n`,
    );
    return;
  }

  try {
    const response = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization:
            `Bearer ${this.config.values.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': requestId,
        },
        body: JSON.stringify({
          from: this.config.values.RESEND_FROM,
          to: [email],
          subject:
            purpose === 'registration'
              ? 'Verify your MoneyLens email'
              : 'Reset your MoneyLens password',
          text:
            `Your MoneyLens verification code is ${code}. ` +
            'It expires in 10 minutes.',
        }),
      },
    );

    
if (!response.ok) {
  const error = await response.json().catch(() => null) as {
    name?: string;
    message?: string;
    statusCode?: number;
  } | null;

  const safeMessage = error?.message
    ?.replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      '[redacted-email]',
    )
    .slice(0, 500);

  console.error('[RESEND DELIVERY FAILED]', {
    status: response.status,
    errorType: error?.name ?? 'UNKNOWN',
    message: safeMessage ?? 'No message returned',
  });

  throw new ServiceUnavailableException(
    'EMAIL_DELIVERY_FAILED',
  );
}

  } catch (error) {
    if (error instanceof ServiceUnavailableException) {
      throw error;
    }

    console.error('[RESEND CONNECTION ERROR]', {
      type: error instanceof Error
        ? error.name
        : 'UNKNOWN',
      cause:
        error instanceof Error &&
        error.cause instanceof Error
          ? error.cause.message
          : undefined,
    });

    throw new ServiceUnavailableException(
      'EMAIL_DELIVERY_FAILED',
    );
  }
}

}
@Injectable()
export class EmailVerification {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Config) private readonly config: Config,
    @Inject(Mailer) private readonly mail: Mailer,
  ) {}
  hash(value: string) {
    return createHmac('sha256', this.config.values.IDENTIFIER_HASH_KEY)
      .update(`auth:${value}`)
      .digest('hex');
  }


async request(
  email: string,
  purpose: EmailPurpose,
  ip: string,
) {
  this.mail.assertAvailable();

  // Keep the parameter for compatibility with existing callers.
  void ip;

  // Generate a secure 6-digit verification code.
  const code = randomInt(0, 1000000)
    .toString()
    .padStart(6, '0');

  const challenge = await this.db.$transaction(
    async (tx) => {
      const now = new Date();

      // Check whether the email is already registered.
      const user = await tx.user.findUnique({
        where: { email },
      });

      // Invalidate previous verification challenges.
      await tx.emailChallenge.deleteMany({
        where: {
          email,
          purpose,
        },
      });

      // Create a new verification challenge.
      return tx.emailChallenge.create({
        data: {
          email,
          purpose,
          eligible:
            purpose === 'registration'
              ? !user
              : !!user,
          codeHash: this.hash(
            `${email}:${purpose}:${code}`,
          ),
          expiresAt: new Date(
            now.getTime() + 600000,
          ),
        },
      });
    },
  );

  // Send the verification email if eligible.
  if (challenge.eligible) {
    try {
      await this.mail.sendCode(
        email,
        code,
        purpose,
        challenge.id,
      );
    } catch (error) {
      // Clean up the challenge if email delivery fails.
      await this.db.emailChallenge.deleteMany({
        where: {
          id: challenge.id,
        },
      });

      throw error;
    }
  }

  return {
    challengeId: challenge.id,
    expiresIn: 600,
    resendAfter: 0,
  };
}

  // async request(email: string, purpose: EmailPurpose, ip: string) {
  //   this.mail.assertAvailable();
  //   const code = randomInt(0, 1000000).toString().padStart(6, '0');
  //   const challenge = await this.db.$transaction(async (tx) => {
  //     const now = new Date();
  //     // Shared database locks also serialize limits across API processes.
  //     for (const [key, limit, cooldown] of [
  //       [`ip:${this.hash(ip)}`, 30, false],
  //       [`email:${this.hash(email)}`, 5, true],
  //     ] as const) {
  //       await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
  //       const bucket = await tx.authRateBucket.findUnique({ where: { key } });
  //       const inWindow = bucket && now.getTime() - bucket.windowStartedAt.getTime() < 3600000;
  //       if (
  //         (inWindow && bucket.count >= limit) ||
  //         (cooldown && bucket && now.getTime() - bucket.lastRequestedAt.getTime() < 60000)
  //       )
  //         throw new HttpException('CODE_RATE_LIMITED', 429);
  //       await tx.authRateBucket.upsert({
  //         where: { key },
  //         create: { key, count: 1, windowStartedAt: now, lastRequestedAt: now },
  //         update: {
  //           count: inWindow ? bucket.count + 1 : 1,
  //           windowStartedAt: inWindow ? bucket.windowStartedAt : now,
  //           lastRequestedAt: now,
  //         },
  //       });
  //     }
  //     const user = await tx.user.findUnique({ where: { email } });
  //     await tx.emailChallenge.deleteMany({ where: { email, purpose } });
  //     return tx.emailChallenge.create({
  //       data: {
  //         email,
  //         purpose,
  //         eligible: purpose === 'registration' ? !user : !!user,
  //         codeHash: this.hash(`${email}:${purpose}:${code}`),
  //         expiresAt: new Date(now.getTime() + 600000),
  //       },
  //     });
  //   });
  //   if (challenge.eligible) {
  //     try {
  //       await this.mail.sendCode(email, code, purpose, challenge.id);
  //     } catch (error) {
  //       await this.db.emailChallenge.deleteMany({ where: { id: challenge.id } });
  //       throw error;
  //     }
  //   }
  //   return { challengeId: challenge.id, expiresIn: 600, resendAfter: 60 };
  // }
  async verify(challengeId: string, email: string, purpose: EmailPurpose, code: string) {
    const grant = randomBytes(48).toString('hex');
    const valid = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "EmailChallenge" WHERE "id" = ${challengeId} FOR UPDATE`;
      const row = await tx.emailChallenge.findUnique({ where: { id: challengeId } });
      if (
        !row ||
        row.email !== email ||
        row.purpose !== purpose ||
        row.consumedAt ||
        row.attempts >= 5 ||
        row.expiresAt <= new Date()
      )
        return false;
      const matches = row.codeHash === this.hash(`${email}:${purpose}:${code}`) && row.eligible;
      await tx.emailChallenge.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          ...(matches
            ? {
                consumedAt: new Date(),
                grantHash: this.hash(grant),
                grantExpiresAt: new Date(Date.now() + 600000),
              }
            : {}),
        },
      });
      return matches;
    });
    if (!valid) throw new UnauthorizedException('INVALID_OR_EXPIRED_CODE');
    return { grant, expiresIn: 600 };
  }
  async consume(tx: Prisma.TransactionClient, email: string, purpose: EmailPurpose, grant: string) {
    const result = await tx.emailChallenge.updateMany({
      where: {
        email,
        purpose,
        eligible: true,
        grantHash: this.hash(grant),
        grantConsumedAt: null,
        grantExpiresAt: { gt: new Date() },
        consumedAt: { not: null },
      },
      data: { grantConsumedAt: new Date() },
    });
    if (result.count !== 1) throw new UnauthorizedException('INVALID_OR_EXPIRED_GRANT');
  }
}
