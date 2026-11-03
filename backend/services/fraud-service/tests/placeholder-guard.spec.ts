/** assertNoPlaceholders (packages/common/src/http/server.ts): .env.example placeholders never reach production */
import { assertNoPlaceholders } from '@banksphere/common';

describe('assertNoPlaceholders', () => {
  const names = ['DATABASE_URL', 'KAFKA_PASSWORD', 'JWT_VERIFY_KEYS'];

  it('refuses to start in production when a secret still is, or contains, CHANGE_ME (and never echoes the value)', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://fraud_app:CHANGE_ME@postgres:5432/banksphere',
      KAFKA_PASSWORD: 'CHANGE_ME',
      JWT_VERIFY_KEYS: 'kid:abc',
    };
    let message = '';
    try {
      assertNoPlaceholders(names, env);
    } catch (err: any) {
      message = err.message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/KAFKA_PASSWORD/);
    expect(message).not.toMatch(/JWT_VERIFY_KEYS/);
    expect(message).not.toContain('postgresql://');
  });

  it('matches the placeholder case-insensitively', () => {
    expect(() => assertNoPlaceholders(['SMTP_PASSWORD'], { NODE_ENV: 'production', SMTP_PASSWORD: 'change_me' })).toThrow(/SMTP_PASSWORD/);
  });

  it('accepts real values and unset variables (those are checked by each service)', () => {
    expect(() => assertNoPlaceholders(names, { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@h/db' })).not.toThrow();
  });

  it('does not interfere outside production', () => {
    expect(() => assertNoPlaceholders(names, { NODE_ENV: 'development', KAFKA_PASSWORD: 'CHANGE_ME' })).not.toThrow();
  });
});
