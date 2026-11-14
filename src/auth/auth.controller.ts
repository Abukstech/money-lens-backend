import { Inject, Body, Controller, Delete, Get, Post, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Request } from 'express';
import { EmailVerification } from './email';
import { Db } from '../common/db';
import { InsightsSessions } from '../insights/sessions';
import { SchemaPipe } from '../common/http';
import { AuthGuard, AuthService, CurrentUser } from './auth';
import {
  credentials,
  refreshInput,
  registration,
  emailRequest,
  emailVerification,
  passwordReset,
  profileUpdate,
} from './auth.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Db) private readonly db: Db,
    @Inject(EmailVerification) private readonly verification: EmailVerification,
    @Inject(InsightsSessions) private readonly insightsSessions: InsightsSessions,
  ) {}
  @Post('register')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password', 'registrationGrant'],
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 12 },
        registrationGrant: { type: 'string' },
      },
    },
  })
  register(@Body(new SchemaPipe(registration)) input: z.infer<typeof registration>) {
    return this.auth.register(input);
  }
  @Post('email/request-code')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'purpose'],
      properties: {
        email: { type: 'string', format: 'email' },
        purpose: { type: 'string', enum: ['registration', 'password_reset'] },
      },
    },
  })
  requestCode(
    @Body(new SchemaPipe(emailRequest)) input: z.infer<typeof emailRequest>,
    @Req() req: Request,
  ) {
    return this.verification.request(input.email, input.purpose, req.ip ?? 'unknown');
  }
  @Post('email/verify-code')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'purpose', 'challengeId', 'code'],
      properties: {
        email: { type: 'string', format: 'email' },
        purpose: { type: 'string', enum: ['registration', 'password_reset'] },
        challengeId: { type: 'string', format: 'uuid' },
        code: { type: 'string', pattern: '^\\d{6}$' },
      },
    },
  })
  verifyCode(@Body(new SchemaPipe(emailVerification)) input: z.infer<typeof emailVerification>) {
    return this.verification.verify(input.challengeId, input.email, input.purpose, input.code);
  }
  @Post('password/reset')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password', 'grant'],
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 12, maxLength: 128 },
        grant: { type: 'string' },
      },
    },
  })
  resetPassword(@Body(new SchemaPipe(passwordReset)) input: z.infer<typeof passwordReset>) {
    return this.auth.resetPassword(input);
  }
  @Patch('me')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['firstName'],
      properties: { firstName: { type: 'string', minLength: 1, maxLength: 80 } },
    },
  })
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async updateMe(
    @CurrentUser() userId: string,
    @Body(new SchemaPipe(profileUpdate)) input: z.infer<typeof profileUpdate>,
  ) {
    await this.db.user.update({ where: { id: userId }, data: input });
    return this.me(userId);
  }
  @Post('login')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password'],
      properties: { email: { type: 'string' }, password: { type: 'string' } },
    },
  })
  login(@Body(new SchemaPipe(credentials)) input: z.infer<typeof credentials>) {
    return this.auth.login(input);
  }
  @Post('refresh')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: { type: 'string' } },
    },
  })
  refresh(@Body(new SchemaPipe(refreshInput)) input: z.infer<typeof refreshInput>) {
    return this.auth.refresh(input.refreshToken);
  }
  @Post('logout')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: { type: 'string' } },
    },
  })
  logout(@Body(new SchemaPipe(refreshInput)) input: z.infer<typeof refreshInput>) {
    return this.auth.logout(input.refreshToken);
  }
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async me(@CurrentUser() userId: string) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, firstName: true, emailVerifiedAt: true },
    });
    return { userId, ...user };
  }
  @Delete('account')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async deleteAccount(@CurrentUser() userId: string) {
    await this.db.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.emailChallenge.deleteMany({ where: { email: user.email } });
      await tx.authRateBucket.deleteMany({ where: { key: `insights:${userId}` } });
      await tx.user.delete({ where: { id: userId } });
    });
    this.insightsSessions.clearUser(userId);
    return { deleted: true };
  }
}
