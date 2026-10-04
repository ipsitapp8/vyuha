import { z } from 'zod';

export const roleSchema = z.enum(['INSTRUCTOR', 'TRAINEE']);
export type Role = z.infer<typeof roleSchema>;

export const registerBodySchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address')),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a digit'),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const authResponseSchema = z.object({ user: publicUserSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

/** GET /auth/session: always 200, `user` is null when nobody is signed in (no console-noisy 401). */
export const sessionResponseSchema = z.object({ user: publicUserSchema.nullable() });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const AUTH_COOKIE_NAME = 'vyuha_token';
