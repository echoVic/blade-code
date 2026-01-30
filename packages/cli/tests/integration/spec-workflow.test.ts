/**
 * Spec 模式集成测试
 *
 * 测试完整的 Spec 工作流：创建 → 阶段转换 → 任务管理 → 归档
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecFileManager } from '../../src/spec/SpecFileManager.js';
import { SpecManager } from '../../src/spec/SpecManager.js';
import { SPEC_DIRS, type SpecPhase, STEERING_FILES } from '../../src/spec/types.js';

describe('Spec Workflow Integration', () => {
  let tempDir: string;
  let specManager: SpecManager;
  let fileManager: SpecFileManager;

  beforeEach(async () => {
    // 创建临时目录
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-spec-test-'));

    // 重置并初始化 SpecManager
    SpecManager.resetInstance();
    specManager = SpecManager.getInstance();
    await specManager.initialize(tempDir);

    fileManager = specManager.getFileManager();
  });

  afterEach(async () => {
    // 清理临时目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
    SpecManager.resetInstance();
  });

  describe('Directory Structure', () => {
    it('should create only changes directory on initialization', async () => {
      const bladeDir = path.join(tempDir, '.blade');

      // 验证目录结构
      const changesDir = path.join(bladeDir, SPEC_DIRS.CHANGES);

      const changesExists = await fs
        .stat(changesDir)
        .then(() => true)
        .catch(() => false);

      // 只创建 changes 目录（最常用），其他目录按需创建
      expect(changesExists).toBe(true);
    });
  });

  describe('Spec Lifecycle', () => {
    it('should create a new spec with proposal file', async () => {
      const result = await specManager.createSpec(
        'auth-feature',
        'Implement user authentication'
      );

      expect(result.success).toBe(true);
      expect(result.data?.spec?.name).toBe('auth-feature');
      expect(result.data?.spec?.phase).toBe('init');

      // 验证 proposal.md 已创建
      const proposalContent = await fileManager.readSpecFile(
        'auth-feature',
        'proposal'
      );
      expect(proposalContent).toContain('# auth-feature');
      expect(proposalContent).toContain('Implement user authentication');
    });

    it('should prevent duplicate spec creation', async () => {
      await specManager.createSpec('test-feature', 'Test');
      const result = await specManager.createSpec('test-feature', 'Duplicate');

      expect(result.success).toBe(false);
      expect(result.error).toBe('SPEC_EXISTS');
    });

    it('should load an existing spec', async () => {
      // 创建并关闭 spec
      await specManager.createSpec('load-test', 'Test loading');
      specManager.closeSpec();

      expect(specManager.getCurrentSpec()).toBeNull();

      // 重新加载
      const result = await specManager.loadSpec('load-test');

      expect(result.success).toBe(true);
      expect(specManager.getCurrentSpec()?.name).toBe('load-test');
    });
  });

  describe('Phase Transitions', () => {
    beforeEach(async () => {
      await specManager.createSpec('phase-test', 'Testing phases');
    });

    it('should transition through phases sequentially', async () => {
      const phases: SpecPhase[] = [
        'requirements',
        'design',
        'tasks',
        'implementation',
        'done',
      ];

      for (const phase of phases) {
        const result = await specManager.transitionPhase(phase);
        expect(result.success).toBe(true);
        expect(specManager.getCurrentSpec()?.phase).toBe(phase);
      }
    });

    it('should allow skipping design phase', async () => {
      // init -> requirements
      await specManager.transitionPhase('requirements');

      // requirements -> tasks (skipping design)
      const result = await specManager.transitionPhase('tasks');
      expect(result.success).toBe(true);
      expect(specManager.getCurrentSpec()?.phase).toBe('tasks');
    });

    it('should allow returning to tasks from implementation', async () => {
      // Go to implementation
      await specManager.transitionPhase('requirements');
      await specManager.transitionPhase('tasks');
      await specManager.transitionPhase('implementation');

      // Return to tasks
      const result = await specManager.transitionPhase('tasks');
      expect(result.success).toBe(true);
      expect(specManager.getCurrentSpec()?.phase).toBe('tasks');
    });

    it('should reject invalid transitions', async () => {
      // init -> implementation (invalid)
      const result = await specManager.transitionPhase('implementation');
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_TRANSITION');
    });
  });

  describe('Task Management', () => {
    beforeEach(async () => {
      await specManager.createSpec('task-test', 'Testing tasks');
      await specManager.transitionPhase('requirements');
      await specManager.transitionPhase('tasks');
    });

    it('should add tasks to spec', async () => {
      const result = await specManager.addTask(
        'Create database schema',
        'Design and create the user table',
        {
          complexity: 'medium',
          affectedFiles: ['src/db/schema.ts'],
        }
      );

      expect(result.success).toBe(true);
      expect(result.data?.task?.title).toBe('Create database schema');

      const spec = specManager.getCurrentSpec();
      expect(spec?.tasks).toHaveLength(1);
    });

    it('should track task progress', async () => {
      // Add multiple tasks
      await specManager.addTask('Task 1', 'First task');
      await specManager.addTask('Task 2', 'Second task');
      await specManager.addTask('Task 3', 'Third task');

      const spec = specManager.getCurrentSpec()!;

      // Complete one task
      await specManager.updateTaskStatus(spec.tasks[0].id, 'completed');

      const progress = specManager.getTaskProgress();
      expect(progress.total).toBe(3);
      expect(progress.completed).toBe(1);
      expect(progress.percentage).toBe(33);
    });

    it('should handle task dependencies', async () => {
      const task1Result = await specManager.addTask('Base task', 'Foundation');
      const task1Id = task1Result.data?.task?.id;
      expect(task1Id).toBeDefined();

      await specManager.addTask('Dependent task', 'Depends on base', {
        dependencies: [task1Id!],
      });

      // Next task should be task 1 (no dependencies)
      let nextTask = specManager.getNextTask();
      expect(nextTask?.title).toBe('Base task');

      // After completing task 1, task 2 becomes available
      await specManager.updateTaskStatus(task1Id!, 'completed');
      nextTask = specManager.getNextTask();
      expect(nextTask?.title).toBe('Dependent task');
    });
  });

  describe('Spec Listing', () => {
    it('should list all active specs', async () => {
      // Create multiple specs
      await specManager.createSpec('spec-a', 'First spec');
      specManager.closeSpec();

      await specManager.createSpec('spec-b', 'Second spec');
      specManager.closeSpec();

      await specManager.createSpec('spec-c', 'Third spec');
      specManager.closeSpec();

      const specs = await specManager.listSpecs();

      expect(specs).toHaveLength(3);
      expect(specs.map((s) => s.name).sort()).toEqual(['spec-a', 'spec-b', 'spec-c']);
    });

    it('should filter specs by phase', async () => {
      await specManager.createSpec('init-spec', 'In init');
      specManager.closeSpec();

      await specManager.createSpec('req-spec', 'In requirements');
      await specManager.transitionPhase('requirements');
      specManager.closeSpec();

      const initSpecs = await specManager.listSpecs({ phase: 'init' });
      expect(initSpecs).toHaveLength(1);
      expect(initSpecs[0].name).toBe('init-spec');

      const reqSpecs = await specManager.listSpecs({ phase: 'requirements' });
      expect(reqSpecs).toHaveLength(1);
      expect(reqSpecs[0].name).toBe('req-spec');
    });
  });

  describe('Validation', () => {
    it('should validate spec completeness', async () => {
      await specManager.createSpec('validate-test', 'Testing validation');

      const result = await specManager.validateCurrentSpec();

      expect(result.valid).toBe(true);
      expect(result.phase).toBe('init');
      expect(result.completeness.proposal).toBe(true);
    });

    it('should report warnings for missing phase documents', async () => {
      await specManager.createSpec('missing-docs', 'Missing documents');
      await specManager.transitionPhase('requirements');

      const result = await specManager.validateCurrentSpec();

      // Should have warning about missing requirements document
      expect(result.issues.some((i) => i.file === 'requirements')).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('State Management', () => {
    it('should maintain state across operations', async () => {
      // Create spec
      await specManager.createSpec('state-test', 'Testing state');
      expect(specManager.isActive()).toBe(true);

      // Add tasks
      await specManager.transitionPhase('requirements');
      await specManager.transitionPhase('tasks');
      await specManager.addTask('Task 1', 'First');
      await specManager.addTask('Task 2', 'Second');

      // Verify state
      const state = specManager.getState();
      expect(state.isActive).toBe(true);
      expect(state.currentSpec?.tasks).toHaveLength(2);
      expect(state.specPath).toContain('state-test');
    });

    it('should clear state on close', async () => {
      await specManager.createSpec('close-test', 'Testing close');
      expect(specManager.isActive()).toBe(true);

      specManager.closeSpec();

      expect(specManager.isActive()).toBe(false);
      expect(specManager.getCurrentSpec()).toBeNull();
    });
  });

  describe('Steering Documents', () => {
    it('should read and write steering documents', async () => {
      const productContent =
        '# Product Vision\n\nOur goal is to build amazing software.';

      await fileManager.writeSteeringFile('PRODUCT', productContent);
      const steeringContext = await fileManager.readSteeringContext();

      expect(steeringContext.product).toBe(productContent);
    });
  });
});
