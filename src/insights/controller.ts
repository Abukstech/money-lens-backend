import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
  Inject,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard, CurrentUser } from '../auth/auth';
import { SchemaPipe } from '../common/http';
import { FinancialContext } from './context';
import { Insights } from './service';
import { analysisInput, contextInput, messageInput, monthSchema } from './contracts';

@ApiTags('Financial insights')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('moneylens/insights')
export class InsightsController {
  constructor(
    @Inject(FinancialContext) private readonly context: FinancialContext,
    @Inject(Insights) private readonly insights: Insights,
  ) {}
  @Get('context/:month')
  getContext(
    @CurrentUser() userId: string,
    @Param('month', new SchemaPipe(monthSchema)) month: string,
  ) {
    return this.context.get(userId, month);
  }
  @Put('context/:month')
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['takeHomeIncome', 'savingsTarget', 'spendingCoverageConfirmed'],
      properties: {
        takeHomeIncome: { type: 'string', nullable: true },
        savingsTarget: { type: 'string', nullable: true },
        spendingCoverageConfirmed: { type: 'boolean' },
        currency: { type: 'string', enum: ['NGN'] },
      },
    },
  })
  putContext(
    @CurrentUser() userId: string,
    @Param('month', new SchemaPipe(monthSchema)) month: string,
    @Body(new SchemaPipe(contextInput)) input: z.infer<typeof contextInput>,
  ) {
    return this.context.put(userId, month, input);
  }
  @Delete('context/:month')
  deleteContext(
    @CurrentUser() userId: string,
    @Param('month', new SchemaPipe(monthSchema)) month: string,
  ) {
    return this.context.delete(userId, month);
  }
  @Post('analyze')
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['month'],
      properties: { month: { type: 'string', example: '2026-09' } },
    },
  })
  analyze(
    @CurrentUser() userId: string,
    @Body(new SchemaPipe(analysisInput)) input: z.infer<typeof analysisInput>,
  ) {
    return this.insights.analyze(userId, input.month);
  }
  @Post('conversations')
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['month'],
      properties: { month: { type: 'string', example: '2026-09' } },
    },
  })
  create(
    @CurrentUser() userId: string,
    @Body(new SchemaPipe(analysisInput)) input: z.infer<typeof analysisInput>,
  ) {
    return this.insights.createConversation(userId, input.month);
  }
  @Post('conversations/:id/messages')
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string', minLength: 1, maxLength: 2000 } },
    },
  })
  message(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body(new SchemaPipe(messageInput)) input: z.infer<typeof messageInput>,
  ) {
    return this.insights.message(userId, id, input.message);
  }
  @Delete('conversations/:id')
  delete(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.insights.deleteConversation(userId, id);
  }
}
