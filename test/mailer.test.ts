import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mailer } from '../src/auth/email';
import { Config } from '../src/common/config';

afterEach(() => vi.unstubAllEnvs());

describe('email delivery configuration', () => {
  it('defaults to Resend and still requires its configuration', () => {
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'resend');
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('RESEND_FROM', '');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(() => new Mailer(new Config()).assertAvailable()).toThrow('EMAIL_NOT_CONFIGURED');
    expect(write).not.toHaveBeenCalled();
  });

  for (const purpose of ['registration', 'password_reset'] as const) {
    it(`prints ${purpose} codes only in explicitly enabled development mode`, async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('EMAIL_DELIVERY_MODE', 'console');
      const fetch = vi.spyOn(globalThis, 'fetch');
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      await new Mailer(new Config()).sendCode(
        'developer@example.test',
        '012345',
        purpose,
        'challenge-fixture',
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledOnce();
      const output = String(write.mock.calls[0][0]);
      expect(output).toContain('[MoneyLens development email]');
      expect(JSON.parse(output.slice(output.indexOf('{')))).toEqual({
        email: 'developer@example.test',
        purpose,
        code: '012345',
        challengeId: 'challenge-fixture',
        expiresIn: 600,
      });
    });
  }

  for (const environment of ['production', 'test'] as const) {
    it(`rejects console delivery in ${environment}`, () => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('EMAIL_DELIVERY_MODE', 'console');
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      expect(() => new Config()).toThrow('DEVELOPMENT_EMAIL_MODE_REQUIRED');
      expect(write).not.toHaveBeenCalled();
    });
  }

  it('fails closed if the environment changes after configuration', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'console');
    const config = new Config();
    config.values.NODE_ENV = 'production';
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(
      new Mailer(config).sendCode('developer@example.test', '012345', 'registration', 'fixture'),
    ).rejects.toThrow('DEVELOPMENT_EMAIL_MODE_REQUIRED');
    expect(write).not.toHaveBeenCalled();
  });
});
