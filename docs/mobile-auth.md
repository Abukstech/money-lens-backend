# Mobile authentication

Apply migration `20261020020000_mobile_auth` and regenerate Prisma before running the updated backend. Existing accounts retain login compatibility and may have null `firstName` / `emailVerifiedAt` until completing personalization or a verified reset.

## API sequence

All routes below use the `/api` prefix.

1. `POST /auth/email/request-code` with `{email,purpose}`. Purpose is `registration` or `password_reset`. Returns `{challengeId,expiresIn:600,resendAfter:60}`. Responses are neutral for existing registration emails and unknown reset emails; those requests do not send a code.
2. `POST /auth/email/verify-code` with `{email,purpose,challengeId,code}`. Code is a six-digit string, including leading zeroes. Returns `{grant,expiresIn:600}`. Verification consumes the code once.
3. Register through `POST /auth/register` with `{email,password,registrationGrant}`. Reset through `POST /auth/password/reset` with `{email,password,grant}`. Each grant is scoped to its email and purpose and is consumed atomically. Passwords are 12–128 characters.
4. After registration, `PATCH /auth/me` with `{firstName}` using the access token. The trimmed name is 1–80 characters and excludes control characters. `GET /auth/me` preserves `userId` and adds `email`, `firstName`, and `emailVerifiedAt`.

Registration and login return the existing `{accessToken,refreshToken,expiresIn:900}` contract. Reset returns `{updated:true}` and revokes all existing sessions; the user signs in again. User-level database locks coordinate login/refresh with reset. Account deletion removes matching verification records and cascades live financial records.

## Local development without Resend

Set `NODE_ENV=development` and `EMAIL_DELIVERY_MODE=console` in the backend `.env`. Code requests print a `[MoneyLens development email]` JSON line containing the email, purpose, six-digit code, challenge ID and expiry to the terminal running the backend. Resend is not called in this mode. Both registration and password-reset codes use this delivery adapter.

```sh
npm run build
node --env-file=.env dist/main.js
```

Enter the printed code in the app. Verification, expiry, rate limits and single-use grants still apply. Codes are not returned by the API or stored in plaintext. Production and test environments reject console mode; `EMAIL_DELIVERY_MODE=resend` is the default. Do not forward or persist development code output in shared log systems. For real email delivery, switch to `resend` and configure the sender and key below.

## Delivery and limits

Set `RESEND_API_KEY` and `RESEND_FROM` in the server environment only. Resend must have a verified sender domain. The mail adapter sends a plain-text code with a 10-second request deadline and idempotency key; provider responses and errors are not exposed to clients. Missing configuration returns `EMAIL_NOT_CONFIGURED`; delivery failures return `EMAIL_DELIVERY_FAILED`.

Codes use cryptographic randomness and a keyed HMAC at rest; grants are 48 random bytes and also stored only as keyed hashes. Codes and grants expire after ten minutes. Codes allow five attempts. Resending invalidates the previous challenge and grant. Limits are shared through PostgreSQL: five requests per email per hour, thirty per client IP per hour, and a 60-second per-email cooldown across purposes. General API admission limits still apply. Configure a trusted reverse proxy deliberately if deploying behind one; never trust arbitrary forwarded client IP headers.

Expired and consumed rows are unusable. Operational retention should periodically remove old challenges and rate buckets after their expiry windows; account deletion immediately removes its challenge records. Outside the explicitly enabled local console delivery mode, never log mail bodies or codes. Never log grants, passwords, or tokens in any environment.

## Tests

`TEST_DATABASE_URL=postgresql://... npx vitest run test/mobile-auth.test.ts` uses a migrated isolated database and fake mail delivery. It tests expiry, attempt limits, resend/cooldown, rate limits, wrong-purpose/email grants, concurrent single-use consumption, reset/session revocation, profile ownership, legacy accounts, delivery failures, and deletion. No live email provider calls occur.
