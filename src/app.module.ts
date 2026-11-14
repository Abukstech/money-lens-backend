import { Inject, Controller, Get, Module } from '@nestjs/common';
import { Db } from './common/db';
import { CoreModule } from './common/core.module';
import { InsightsModule } from './insights/insights.module';
import { AuthGuard, AuthService } from './auth/auth';
import { EmailVerification, Mailer } from './auth/email';
import { AuthController } from './auth/auth.controller';
import { Registry } from './merchants/registry';
import { Policy } from './classification/policy';
import { JevClient } from './classification/jev';
import { Classifier } from './classification/classifier';
import { ClassificationJobs } from './classification/jobs';
import { Transactions } from './transactions/service';
import { TransactionsController } from './transactions/controller';
import { Statements } from './statements/service';
import { OcrClient } from './statements/ocr';
import { PaddleOcrClient } from './statements/paddle-ocr';
import { StatementExtractor } from './statements/extraction/statement-extractor';
import { MemoryUpload } from './statements/upload';
import { StatementsController } from './statements/controller';
import { ExtractionDraftService } from './statements/extraction/extraction-draft.service';
import { ExtractionDraftController } from './statements/extraction/extraction-draft.controller';
@Controller('health')
class HealthController {
  constructor(@Inject(Db) private readonly db: Db) {}
  @Get() async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
@Module({
  imports: [CoreModule, InsightsModule],
  controllers: [
    AuthController,
    TransactionsController,
    StatementsController,
    HealthController,
    ExtractionDraftController,
  ],
  providers: [
    AuthService,
    EmailVerification,
    Mailer,
    AuthGuard,
    Registry,
    Policy,
    ExtractionDraftService,
    JevClient,
    Classifier,
    ClassificationJobs,
    Transactions,
    Statements,
    OcrClient,
    PaddleOcrClient,
    StatementExtractor,
    MemoryUpload,
  ],
})
export class AppModule {}
