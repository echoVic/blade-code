import { z } from 'zod';

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(['high', 'medium', 'low']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export interface TaskListItem {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  priority: TaskPriority;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export const TaskListItemSchema = z.object({
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  priority: TaskPrioritySchema.default('medium'),
  blocks: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

export interface TaskStats {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export type TaskUpdateStatus = TaskStatus | 'deleted';
