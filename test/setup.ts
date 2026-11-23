process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://unused:unused@localhost:1/unused';
process.env.JWT_SECRET = 'test-only-jwt-secret-at-least-32-characters';
process.env.IDENTIFIER_HASH_KEY = 'test-only-distinct-hash-key-at-least-32-characters';
process.env.JOBS_ENABLED = 'false';
if (process.env.JEV_BENCH_LIVE !== '1') {
  process.env.JEV_API_KEY = '';
}
process.env.MISTRAL_API_KEY = 'synthetic-test-key';
process.env.PADDLE_OCR_URL = '';
delete process.env.PADDLE_OCR_TOKEN;

process.env.CORS_ORIGINS = 'http://localhost:8089';

process.env.EMAIL_DELIVERY_MODE = 'resend';

process.env.OPENAI_API_KEY = '';
