import { z } from 'zod';

export const credentials = z
  .object({
    email: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const refreshInput = z.object({ refreshToken: z.string().regex(/^[a-f0-9]{96}$/) }).strict();

export const registration = credentials
  .extend({ registrationGrant: z.string().regex(/^[a-f0-9]{96}$/) })
  .strict();
export const emailPurpose = z.enum(['registration', 'password_reset']);
export const emailRequest = z
  .object({ email: credentials.shape.email, purpose: emailPurpose })
  .strict();
export const emailVerification = emailRequest
  .extend({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })
  .strict();
export const passwordReset = z
  .object({
    email: credentials.shape.email,
    password: credentials.shape.password,
    grant: z.string().regex(/^[a-f0-9]{96}$/),
  })
  .strict();
export const profileUpdate = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  })
  .strict();
