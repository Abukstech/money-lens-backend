import { Inject, Injectable } from '@nestjs/common';
import { Db } from '../common/db';
import { contextInput } from './contracts';
import { z } from 'zod';
@Injectable()
export class FinancialContext {
  constructor(@Inject(Db) private readonly db: Db) {}
  async get(userId: string, month: string) {
    const value = await this.db.monthlyFinancialContext.findUnique({
      where: { userId_month: { userId, month } },
    });
    return {
      month,
      currency: 'NGN' as const,
      takeHomeIncome: value?.takeHomeIncome?.toFixed(2) ?? null,
      savingsTarget: value?.savingsTarget?.toFixed(2) ?? null,
      spendingCoverageConfirmed: value?.spendingCoverageConfirmed ?? false,
      updatedAt: value?.updatedAt.toISOString() ?? null,
    };
  }
  async put(userId: string, month: string, input: z.infer<typeof contextInput>) {
    await this.db.monthlyFinancialContext.upsert({
      where: { userId_month: { userId, month } },
      create: { userId, month, ...input },
      update: input,
    });
    return this.get(userId, month);
  }
  async delete(userId: string, month: string) {
    await this.db.monthlyFinancialContext.deleteMany({ where: { userId, month } });
    return { deleted: true };
  }
}
