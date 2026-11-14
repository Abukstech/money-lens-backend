
import { createApp } from './bootstrap';
import { Config } from './common/config';

process.stdout.write('Starting MoneyLens backend...\n');

void createApp()
  .then(async (app) => {
    const port = app.get(Config).values.PORT;

    const server = await app.listen(port, '0.0.0.0');

    server.requestTimeout = 130000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;

    process.stdout.write(
      `MoneyLens backend ready: http://localhost:${port}/api\n` +
      `Health: http://localhost:${port}/api/health\n`,
    );
  })
  .catch((error: unknown) => {
    process.stderr.write('\n========== STARTUP FAILED ==========\n');

    if (error instanceof Error) {
      process.stderr.write(`Error Name: ${error.name}\n`);
      process.stderr.write(`Error Message: ${error.message}\n`);
      process.stderr.write(`Stack Trace:\n${error.stack}\n`);
    } else {
      process.stderr.write(`Unknown Error: ${String(error)}\n`);
    }

    process.stderr.write('====================================\n');

    process.exitCode = 1;
  });

