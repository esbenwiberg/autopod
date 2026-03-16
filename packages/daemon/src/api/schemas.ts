import { z } from 'zod';

export const SessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

export const ProfileParamsSchema = z.object({
  name: z.string().min(1),
});

export const ListSessionsQuerySchema = z.object({
  profileName: z.string().optional(),
  status: z.string().optional(),
  userId: z.string().optional(),
});

export const ApproveSessionSchema = z.object({});

export const RejectSessionSchema = z.object({
  reason: z.string().optional(),
});

export const SendMessageSchema = z.object({
  message: z.string().min(1).max(50_000),
});
