import {
  Inject,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard, CurrentUser } from '../auth/auth';
import { SchemaPipe } from '../common/http';
import { categories, ONTOLOGY_VERSION, definitions } from '../classification/ontology';
import { Transactions } from './service';
import { correctionInput, feedbackInput, ruleUpdate, transactionInput } from './contracts';
const transactionProperties = {
  id: { type: 'string' },
  date: { type: 'string', format: 'date' },
  description: { type: 'string' },
  amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
  direction: { type: 'string', enum: ['debit', 'credit'] },
  currency: { type: 'string', enum: ['NGN'] },
  balance: { type: 'string' },
  reference: { type: 'string' },
  recipientIdentifier: { type: 'string' },
};
@ApiTags('Transactions')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('moneylens')
export class TransactionsController {
  constructor(@Inject(Transactions) private readonly transactions: Transactions) {}
  @Post('transactions/classify')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Persist a normalized transaction and queue classification; id is a user-scoped idempotency key',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['id', 'date', 'amount', 'direction'],
      properties: transactionProperties,
    },
  })
  submit(
    @CurrentUser() userId: string,
    @Body(new SchemaPipe(transactionInput)) input: z.infer<typeof transactionInput>,
  ) {
    return this.transactions.submit(userId, input);
  }
  @Post('transactions/:id/classify')
  @HttpCode(202)
  classify(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.transactions.requeue(userId, id);
  }
  @Get('transactions/pending')
  pending(@CurrentUser() userId: string, @Query('cursor') cursor?: string) {
    return this.transactions.list(userId, true, cursor);
  }
  @Get('transactions')
  list(@CurrentUser() userId: string, @Query('cursor') cursor?: string) {
    return this.transactions.list(userId, false, cursor);
  }
  @Get('transactions/:id')
  async get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.transactions.present(await this.transactions.owned(userId, id));
  }
  @Get('transactions/:id/classification/history')
  history(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.transactions.history(userId, id);
  }
  @Patch('transactions/:id/extraction')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['revision', 'date', 'amount', 'direction'],
      properties: {
        ...Object.fromEntries(
          Object.entries(transactionProperties).filter(([key]) => key !== 'id'),
        ),
        revision: { type: 'integer', minimum: 0 },
      },
    },
  })
  correct(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body(new SchemaPipe(correctionInput)) input: z.infer<typeof correctionInput>,
  ) {
    return this.transactions.correct(userId, id, input);
  }
  @Patch('transactions/:id/classification')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['revision', 'category'],
      properties: {
        revision: { type: 'integer', minimum: 0 },
        category: { type: 'string', enum: [...categories] },
        rememberForFuture: { type: 'boolean' },
        conditions: {
          type: 'object',
          required: ['direction', 'currency', 'minAmount', 'maxAmount', 'narrationTokens'],
          properties: {
            direction: { type: 'string', enum: ['debit', 'credit'] },
            currency: { type: 'string', enum: ['NGN'] },
            minAmount: { type: 'string' },
            maxAmount: { type: 'string' },
            narrationTokens: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  })
  feedback(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body(new SchemaPipe(feedbackInput)) input: z.infer<typeof feedbackInput>,
  ) {
    return this.transactions.feedback(userId, id, input);
  }
  @Get('classification/categories')
  categories() {
    return {
      ontologyVersion: ONTOLOGY_VERSION,
      categories: categories.map((id) => ({ id, definition: definitions[id] })),
    };
  }
  @Get('classification/summary')
  summary(@CurrentUser() userId: string) {
    return this.transactions.summary(userId);
  }
  @Get('classification/rules')
  rules(@CurrentUser() userId: string) {
    return this.transactions.rules(userId);
  }
  @Patch('classification/rules/:id')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['version', 'category', 'conditions'],
      properties: {
        version: { type: 'integer' },
        category: { type: 'string', enum: [...categories] },
        conditions: { type: 'object' },
      },
    },
  })
  updateRule(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body(new SchemaPipe(ruleUpdate)) input: z.infer<typeof ruleUpdate>,
  ) {
    return this.transactions.updateRule(userId, id, input);
  }
  @Delete('classification/rules/:id')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['version'],
      properties: { version: { type: 'integer', minimum: 1 } },
    },
  })
  deleteRule(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body(new SchemaPipe(z.object({ version: z.number().int().min(1) }).strict()))
    input: { version: number },
  ) {
    return this.transactions.updateRule(userId, id, { ...input, deleted: true });
  }
}
