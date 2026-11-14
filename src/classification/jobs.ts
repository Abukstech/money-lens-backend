import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { Db } from '../common/db';
import { Config } from '../common/config';
import { Classifier } from './classifier';
@Injectable()
export class ClassificationJobs implements OnModuleInit, OnModuleDestroy {
  private boss?: PgBoss;
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Config) private readonly config: Config,
    @Inject(Classifier) private readonly classifier: Classifier,
  ) {}
  async onModuleInit() {
    if (!this.config.values.JOBS_ENABLED) return;
    this.boss = new PgBoss({
      connectionString: this.config.values.DATABASE_URL,
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
      expireInSeconds: 120,
      retentionDays: 1,
      deleteAfterDays: 1,
    });
    this.boss.on('error', () => process.stderr.write('CLASSIFICATION_QUEUE_ERROR\n'));
    await this.boss.start();
    await this.boss.createQueue('classify-transaction');
    await this.boss.work<{ transactionId: string; taskId: string }>(
      'classify-transaction',
      { batchSize: Math.min(4, this.config.values.JEV_CONCURRENCY) },
      async (jobs) => {
        await Promise.all(
          jobs.map(async (job) => {
            try {
              const task = await this.db.classificationTask.findUnique({
                where: { id: job.data.taskId },
              });
              if (!task || task.status === 'done' || task.transactionId !== job.data.transactionId)
                return;
              await this.classifier.run(task.transactionId, task.revision);
              await this.db.classificationTask.updateMany({
                where: { id: task.id },
                data: { status: 'done' },
              });
            } catch {
              throw new Error('CLASSIFICATION_JOB_FAILED');
            }
          }),
        );
      },
    );
    await this.dispatch();
    this.timer = setInterval(() => void this.dispatch(), 5000);
    this.timer.unref();
  }
  async dispatch() {
    if (!this.boss || this.dispatching) return;
    this.dispatching = true;
    try {
      const tasks = await this.db.classificationTask.findMany({
        where: {
          status: 'pending',
          OR: [
            { lastDispatchedAt: null },
            { lastDispatchedAt: { lt: new Date(Date.now() - 180000) } },
          ],
        },
        take: 100,
        orderBy: { createdAt: 'asc' },
      });
      for (const task of tasks) {
        await this.boss.send(
          'classify-transaction',
          { transactionId: task.transactionId, taskId: task.id },
          { singletonKey: task.id },
        );
        await this.db.classificationTask.updateMany({
          where: { id: task.id },
          data: { lastDispatchedAt: new Date() },
        });
      }
    } catch {
      process.stderr.write('CLASSIFICATION_DISPATCH_ERROR\n');
    } finally {
      this.dispatching = false;
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.boss) await this.boss.stop({ graceful: true, timeout: 10000 });
  }
}
