import {
  Default,
  Runtime,
  type Static,
  StringEnum,
  Type,
} from '../../../schema/index.js';

export const TaskStatusSchema = StringEnum(['pending', 'in_progress', 'completed']);
export type TaskStatus = Static<typeof TaskStatusSchema>;

export const TaskPrioritySchema = StringEnum(['high', 'medium', 'low']);
export type TaskPriority = Static<typeof TaskPrioritySchema>;

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

export const TaskListItemSchema = Runtime(
  Type.Object({
    id: Type.String(),
    subject: Type.String(),
    description: Type.String(),
    status: TaskStatusSchema,
    activeForm: Type.Optional(Type.String()),
    owner: Type.Optional(Type.String()),
    priority: Default(TaskPrioritySchema, 'medium'),
    blocks: Default(Type.Array(Type.String()), []),
    blockedBy: Default(Type.Array(Type.String()), []),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    createdAt: Type.String(),
    startedAt: Type.Optional(Type.String()),
    completedAt: Type.Optional(Type.String()),
  })
);

export interface TaskStats {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export type TaskUpdateStatus = TaskStatus | 'deleted';
