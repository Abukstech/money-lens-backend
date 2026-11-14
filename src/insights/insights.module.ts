import { Module } from '@nestjs/common';
import { AuthGuard } from '../auth/auth';
import { FinancialContext } from './context';
import { FinancialFacts } from './facts';
import { InsightsController } from './controller';
import { OpenAIInsights } from './openai';
import { Insights } from './service';
import { InsightsSessionsModule } from './sessions';
@Module({
  imports: [InsightsSessionsModule],
  controllers: [InsightsController],
  providers: [AuthGuard, FinancialContext, FinancialFacts, OpenAIInsights, Insights],
})
export class InsightsModule {}
