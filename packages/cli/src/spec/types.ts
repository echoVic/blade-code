/**
 * Spec-Driven Development (SDD) Type Definitions
 *
 * Combines design concepts from OpenSpec and GitHub Spec Kit:
 * - OpenSpec: specs/ + changes/ + archive/ directory structure, change tracking
 * - Spec Kit: constitution.md governance principles, detailed workflow phases
 */

/**
 * Spec Workflow Phase
 *
 * Four-phase workflow: Requirements → Design → Tasks → Implementation
 */
export type SpecPhase =
  | 'init' // Initialize: create proposal skeleton
  | 'requirements' // Requirements phase: generate requirements doc using EARS format
  | 'design' // Design phase: create technical architecture (Mermaid diagrams, API contracts, etc.)
  | 'tasks' // Task breakdown: split into executable atomic tasks
  | 'implementation' // Implementation phase: complete tasks one by one
  | 'done'; // Done: archive changes

/**
 * Task Status
 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'skipped';

/**
 * Task Complexity
 */
export type TaskComplexity = 'low' | 'medium' | 'high';

/**
 * Spec Task Definition
 */
export interface SpecTask {
  /** Task ID (nanoid) */
  id: string;
  /** Task title */
  title: string;
  /** Task description */
  description: string;
  /** Task status */
  status: TaskStatus;
  /** Dependent task ID list */
  dependencies: string[];
  /** Affected file list */
  affectedFiles: string[];
  /** Estimated complexity */
  complexity: TaskComplexity;
  /** Completion time (ISO 8601) */
  completedAt?: string;
  /** Notes */
  notes?: string;
}

/**
 * Spec Metadata
 *
 * Stored in .blade/changes/<feature>/.meta.json
 */
export interface SpecMetadata {
  /** Spec ID (nanoid) */
  id: string;
  /** Feature name (directory name) */
  name: string;
  /** Feature description */
  description: string;
  /** Current phase */
  phase: SpecPhase;
  /** Creation time (ISO 8601) */
  createdAt: string;
  /** Update time (ISO 8601) */
  updatedAt: string;
  /** Task list */
  tasks: SpecTask[];
  /** Current executing task ID */
  currentTaskId?: string;
  /** Related domains (for specs/ directory classification) */
  domains?: string[];
  /** Tags */
  tags?: string[];
  /** Author */
  author?: string;
}

/**
 * Steering Documents Context
 *
 * Global project governance documents, referencing Spec Kit's constitution.md
 */
export interface SteeringContext {
  /** Project governance principles (constitution.md) */
  constitution?: string;
  /** Product vision and goals (product.md) */
  product?: string;
  /** Tech stack and constraints (tech.md) */
  tech?: string;
  /** Code organization patterns (structure.md) */
  structure?: string;
}

/**
 * Spec File Type
 */
export type SpecFileType =
  | 'proposal' // Proposal description (why)
  | 'spec' // Specification file (what)
  | 'requirements' // Requirements doc (EARS format)
  | 'design' // Design doc (how)
  | 'tasks' // Task breakdown (specific steps)
  | 'meta'; // Metadata (.meta.json)

/**
 * Spec File Path Mapping
 */
export const SPEC_FILE_NAMES: Record<SpecFileType, string> = {
  proposal: 'proposal.md',
  spec: 'spec.md',
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
  meta: '.meta.json',
};

/**
 * Spec Directory Structure
 *
 * .blade/
 * ├── specs/              # Authoritative specs (single source of truth)
 * │   └── [domain]/spec.md
 * ├── changes/            # Active change proposals
 * │   └── <feature>/
 * │       ├── proposal.md
 * │       ├── spec.md
 * │       ├── requirements.md
 * │       ├── design.md
 * │       ├── tasks.md
 * │       ├── .meta.json
 * │       └── specs/      # Spec delta
 * ├── archive/            # Completed changes
 * └── steering/           # Global governance docs
 */
export const SPEC_DIRS = {
  /** Authoritative specs directory */
  SPECS: 'specs',
  /** Active changes directory */
  CHANGES: 'changes',
  /** Archive directory */
  ARCHIVE: 'archive',
  /** Governance docs directory */
  STEERING: 'steering',
  /** Spec delta directory (under changes/<feature>/) */
  SPEC_DELTA: 'specs',
} as const;

/**
 * Steering File Names
 */
export const STEERING_FILES = {
  CONSTITUTION: 'constitution.md',
  PRODUCT: 'product.md',
  TECH: 'tech.md',
  STRUCTURE: 'structure.md',
} as const;

/**
 * Phase Order
 */
export const PHASE_ORDER: SpecPhase[] = [
  'init',
  'requirements',
  'design',
  'tasks',
  'implementation',
  'done',
];

/**
 * Phase Transition Rules
 */
export const PHASE_TRANSITIONS: Record<SpecPhase, SpecPhase[]> = {
  init: ['requirements'],
  requirements: ['design', 'tasks'], // Can skip design and go directly to tasks
  design: ['tasks'],
  tasks: ['implementation'],
  implementation: ['done', 'tasks'], // Can go back to tasks to add new ones
  done: [], // Terminal state
};

/**
 * Phase Display Names (Chinese for UI display)
 */
export const PHASE_DISPLAY_NAMES: Record<SpecPhase, string> = {
  init: '初始化',
  requirements: '需求定义',
  design: '架构设计',
  tasks: '任务分解',
  implementation: '实现中',
  done: '已完成',
};

/**
 * Phase Primary File Mapping
 */
export const PHASE_PRIMARY_FILE: Record<SpecPhase, SpecFileType | null> = {
  init: 'proposal',
  requirements: 'requirements',
  design: 'design',
  tasks: 'tasks',
  implementation: 'tasks', // Implementation phase mainly updates task status
  done: null,
};

/**
 * Spec Operation Result
 *
 * Supports generics for more precise type hints
 * - Default data structure is generic
 * - Can specify more specific data type via generic parameter
 */
export interface SpecOperationResult<
  T = {
    spec?: SpecMetadata;
    path?: string;
    phase?: SpecPhase;
    task?: SpecTask;
  },
> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
}

/**
 * Spec Validation Result
 */
export interface SpecValidationResult {
  valid: boolean;
  phase: SpecPhase;
  completeness: {
    proposal: boolean;
    spec: boolean;
    requirements: boolean;
    design: boolean;
    tasks: boolean;
  };
  issues: SpecValidationIssue[];
  suggestions: string[];
}

/**
 * Validation Issue
 */
export interface SpecValidationIssue {
  severity: 'error' | 'warning' | 'info';
  file: SpecFileType;
  message: string;
  line?: number;
}

/**
 * Spec Search Options
 */
export interface SpecSearchOptions {
  /** Include archived Specs */
  includeArchived?: boolean;
  /** Filter by phase */
  phase?: SpecPhase;
  /** Filter by tags */
  tags?: string[];
  /** Search keyword */
  query?: string;
}

/**
 * Spec List Item
 */
export interface SpecListItem {
  name: string;
  description: string;
  phase: SpecPhase;
  updatedAt: string;
  path: string;
  isArchived: boolean;
  taskProgress: {
    total: number;
    completed: number;
  };
}
