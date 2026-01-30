/**
 * SpecManager 单元测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecManager } from '../../../src/spec/SpecManager.js';
import type { SpecMetadata, SpecPhase } from '../../../src/spec/types.js';

// Mock SpecFileManager
const mockFileManager = {
  initializeDirectories: vi.fn().mockResolvedValue(undefined),
  changeExists: vi.fn().mockResolvedValue(false),
  createChangeDir: vi.fn().mockResolvedValue('/mock/.blade/changes/test-feature'),
  createMetadata: vi.fn(
    (name: string, description: string): SpecMetadata => ({
      id: 'test-id',
      name,
      description,
      phase: 'init',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    })
  ),
  writeMetadata: vi.fn().mockResolvedValue(undefined),
  readMetadata: vi.fn().mockResolvedValue(null),
  writeSpecFile: vi.fn().mockResolvedValue(undefined),
  readSpecFile: vi.fn().mockResolvedValue(null),
  getChangePath: vi.fn().mockReturnValue('/mock/.blade/changes/test-feature'),
  listActiveChanges: vi.fn().mockResolvedValue([]),
  listArchivedChanges: vi.fn().mockResolvedValue([]),
  archiveChange: vi.fn().mockResolvedValue('/mock/.blade/archive/test-feature'),
  readSteeringContext: vi.fn().mockResolvedValue(null),
  writeSteeringDoc: vi.fn().mockResolvedValue(undefined),
  mergeSpecDeltas: vi.fn().mockResolvedValue([]),
  updatePhase: vi.fn().mockImplementation((name: string, phase: SpecPhase) => {
    return Promise.resolve({
      id: 'test-id',
      name,
      description: 'Test',
      phase,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    });
  }),
  getArchiveDir: vi.fn().mockReturnValue('/mock/.blade/archive'),
};

vi.mock('../../../src/spec/SpecFileManager.js', () => ({
  SpecFileManager: vi.fn().mockImplementation(() => mockFileManager),
}));

// Mock store state
let mockSpecState = {
  currentSpec: null as any,
  specPath: null as string | null,
  isActive: false,
  phase: null as string | null,
  tasks: [] as any[],
  steeringContext: null as any,
  currentTaskId: null as string | null,
  recentSpecs: [] as string[],
};

const resetMockState = () => {
  mockSpecState = {
    currentSpec: null,
    specPath: null,
    isActive: false,
    phase: null,
    tasks: [],
    steeringContext: null,
    currentTaskId: null,
    recentSpecs: [],
  };
};

vi.mock('../../../src/store/vanilla.js', () => ({
  specActions: () => ({
    reset: vi.fn(),
    setCurrentSpec: vi.fn(),
    setSpecPath: vi.fn(),
    setActive: vi.fn(),
    setPhase: vi.fn(),
    addTask: vi.fn(),
    updateTask: vi.fn(),
    setTasks: vi.fn(),
    setSteeringContext: vi.fn(),
    updateState: vi.fn(),
    update: vi.fn(),
  }),
  getState: () => ({
    spec: mockSpecState,
  }),
  vanillaStore: {
    getState: () => ({ spec: mockSpecState }),
    setState: (updater: any) => {
      const result = updater({ spec: mockSpecState });
      Object.assign(mockSpecState, result.spec);
    },
    subscribe: vi.fn(),
  },
}));

describe('SpecManager', () => {
  let specManager: SpecManager;

  beforeEach(async () => {
    // Reset store state first
    resetMockState();

    // Reset singleton
    SpecManager.resetInstance();
    specManager = SpecManager.getInstance();

    // Initialize manager
    await specManager.initialize('/mock/workspace');

    // Reset mock state
    vi.clearAllMocks();
    mockFileManager.changeExists.mockResolvedValue(false);
    mockFileManager.readMetadata.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getInstance', () => {
    it('should return the same instance (singleton)', () => {
      const instance1 = SpecManager.getInstance();
      const instance2 = SpecManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('createSpec', () => {
    it('should create a new spec with correct initial state', async () => {
      const result = await specManager.createSpec('test-feature', 'Test description');

      expect(result.success).toBe(true);
      expect(result.data?.spec).toBeDefined();
      expect(result.data?.spec?.name).toBe('test-feature');
      expect(result.data?.spec?.description).toBe('Test description');
      expect(result.data?.spec?.phase).toBe('init');
    });

    it('should set the created spec as current spec', async () => {
      await specManager.createSpec('test-feature', 'Test description');

      const currentSpec = specManager.getCurrentSpec();
      expect(currentSpec).toBeDefined();
      expect(currentSpec?.name).toBe('test-feature');
    });

    it('should fail when spec already exists', async () => {
      mockFileManager.changeExists.mockResolvedValueOnce(true);

      const result = await specManager.createSpec('test-feature', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('SPEC_EXISTS');
    });
  });

  describe('getCurrentSpec', () => {
    it('should return null when no spec is active', () => {
      const spec = specManager.getCurrentSpec();
      expect(spec).toBeNull();
    });

    it('should return current spec when one is active', async () => {
      await specManager.createSpec('test-feature', 'Test');
      const spec = specManager.getCurrentSpec();
      expect(spec).not.toBeNull();
    });
  });

  describe('transitionPhase', () => {
    beforeEach(async () => {
      await specManager.createSpec('test-feature', 'Test');
    });

    it('should transition to next phase correctly', async () => {
      // init -> requirements
      let result = await specManager.transitionPhase('requirements');
      expect(result.success).toBe(true);

      // requirements -> design
      result = await specManager.transitionPhase('design');
      expect(result.success).toBe(true);
    });

    it('should fail when no spec is active', async () => {
      specManager.closeSpec();
      const result = await specManager.transitionPhase('requirements');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NO_ACTIVE_SPEC');
    });

    it('should fail for invalid phase transition', async () => {
      // Cannot skip directly to implementation from init
      const result = await specManager.transitionPhase('implementation');
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
    });
  });

  describe('addTask', () => {
    beforeEach(async () => {
      await specManager.createSpec('test-feature', 'Test');
    });

    it('should add a task to current spec', async () => {
      const result = await specManager.addTask('Test Task', 'Test task description', {
        affectedFiles: ['src/test.ts'],
        complexity: 'low',
      });

      expect(result.success).toBe(true);
      expect(result.data?.task).toBeDefined();
      expect(result.data?.task?.title).toBe('Test Task');
      expect(result.data?.task?.id).toBeDefined();

      const spec = specManager.getCurrentSpec();
      expect(spec?.tasks.length).toBe(1);
    });

    it('should return error when no spec is active', async () => {
      specManager.closeSpec();

      const result = await specManager.addTask('Test Task', 'Test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NO_ACTIVE_SPEC');
    });
  });

  describe('updateTaskStatus', () => {
    beforeEach(async () => {
      await specManager.createSpec('test-feature', 'Test');
    });

    it('should update task status', async () => {
      const addResult = await specManager.addTask('Test Task', 'Test');
      const taskId = addResult.data?.task?.id;
      expect(taskId).toBeDefined();

      const result = await specManager.updateTaskStatus(taskId!, 'in_progress');
      expect(result.success).toBe(true);

      const spec = specManager.getCurrentSpec();
      expect(spec?.tasks[0].status).toBe('in_progress');
    });

    it('should set currentTaskId when starting a task', async () => {
      const addResult = await specManager.addTask('Test Task', 'Test');
      const taskId = addResult.data?.task?.id;
      expect(taskId).toBeDefined();

      await specManager.updateTaskStatus(taskId!, 'in_progress');

      const spec = specManager.getCurrentSpec();
      expect(spec?.currentTaskId).toBe(taskId);
    });

    it('should clear currentTaskId when completing a task', async () => {
      const addResult = await specManager.addTask('Test Task', 'Test');
      const taskId = addResult.data?.task?.id;
      expect(taskId).toBeDefined();

      await specManager.updateTaskStatus(taskId!, 'in_progress');
      await specManager.updateTaskStatus(taskId!, 'completed');

      const spec = specManager.getCurrentSpec();
      expect(spec?.currentTaskId).toBeUndefined();
    });

    it('should fail for non-existent task', async () => {
      const result = await specManager.updateTaskStatus('non-existent', 'in_progress');
      expect(result.success).toBe(false);
      expect(result.error).toBe('TASK_NOT_FOUND');
    });
  });

  describe('getTaskProgress', () => {
    beforeEach(async () => {
      await specManager.createSpec('test-feature', 'Test');
    });

    it('should return 0 for spec with no tasks', () => {
      const progress = specManager.getTaskProgress();
      expect(progress.total).toBe(0);
      expect(progress.completed).toBe(0);
      expect(progress.percentage).toBe(0);
    });

    it('should calculate progress correctly', async () => {
      // Add 4 tasks
      for (let i = 0; i < 4; i++) {
        await specManager.addTask(`Task ${i}`, 'Test');
      }

      // Complete 2 tasks
      const spec = specManager.getCurrentSpec();
      await specManager.updateTaskStatus(spec!.tasks[0].id, 'completed');
      await specManager.updateTaskStatus(spec!.tasks[1].id, 'completed');

      const progress = specManager.getTaskProgress();
      expect(progress.total).toBe(4);
      expect(progress.completed).toBe(2);
      expect(progress.percentage).toBe(50);
    });
  });

  describe('closeSpec / exitSpecMode', () => {
    it('should clear current spec', async () => {
      await specManager.createSpec('test-feature', 'Test');
      expect(specManager.getCurrentSpec()).not.toBeNull();

      specManager.closeSpec();
      expect(specManager.getCurrentSpec()).toBeNull();
    });

    it('exitSpecMode should call closeSpec', async () => {
      await specManager.createSpec('test-feature', 'Test');
      expect(specManager.isActive()).toBe(true);

      specManager.exitSpecMode();
      expect(specManager.isActive()).toBe(false);
    });
  });

  describe('getAllowedTransitions', () => {
    it('should return empty array when no spec is active', () => {
      const transitions = specManager.getAllowedTransitions();
      expect(transitions).toEqual([]);
    });

    it('should return valid transitions for init phase', async () => {
      await specManager.createSpec('test-feature', 'Test');
      const transitions = specManager.getAllowedTransitions();
      expect(transitions).toEqual(['requirements']);
    });
  });

  describe('getNextTask', () => {
    beforeEach(async () => {
      await specManager.createSpec('test-feature', 'Test');
    });

    it('should return null when no pending tasks', async () => {
      const task = specManager.getNextTask();
      expect(task).toBeNull();
    });

    it('should return first pending task with no dependencies', async () => {
      await specManager.addTask('Task 1', 'Test');
      await specManager.addTask('Task 2', 'Test');

      const nextTask = specManager.getNextTask();
      expect(nextTask?.title).toBe('Task 1');
    });

    it('should skip tasks with incomplete dependencies', async () => {
      const result1 = await specManager.addTask('Task 1', 'Test');
      const task1Id = result1.data?.task?.id;
      expect(task1Id).toBeDefined();

      await specManager.addTask('Task 2', 'Test', {
        dependencies: [task1Id!],
      });

      // Task 1 is still pending, so Task 2 should not be returned
      const nextTask = specManager.getNextTask();
      expect(nextTask?.title).toBe('Task 1');

      // Complete Task 1
      await specManager.updateTaskStatus(task1Id!, 'completed');

      // Now Task 2 should be available
      const nextTask2 = specManager.getNextTask();
      expect(nextTask2?.title).toBe('Task 2');
    });
  });

  describe('isActive', () => {
    it('should return false when no spec is active', () => {
      expect(specManager.isActive()).toBe(false);
    });

    it('should return true when spec is active', async () => {
      await specManager.createSpec('test-feature', 'Test');
      expect(specManager.isActive()).toBe(true);
    });
  });

  describe('getState', () => {
    it('should return a copy of the state', async () => {
      await specManager.createSpec('test-feature', 'Test');
      const state = specManager.getState();

      expect(state.currentSpec).toBeDefined();
      expect(state.isActive).toBe(true);

      // Modifying the returned state should not affect internal state
      state.isActive = false;
      expect(specManager.isActive()).toBe(true);
    });
  });
});
