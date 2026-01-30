/**
 * Spec 类型和常量测试
 */
import { describe, expect, it } from 'vitest';
import {
  PHASE_DISPLAY_NAMES,
  PHASE_ORDER,
  PHASE_TRANSITIONS,
  type SpecPhase,
  type TaskStatus,
} from '../../../src/spec/types.js';

describe('Spec Types', () => {
  describe('PHASE_ORDER', () => {
    it('should have correct phase order', () => {
      expect(PHASE_ORDER).toEqual([
        'init',
        'requirements',
        'design',
        'tasks',
        'implementation',
        'done',
      ]);
    });

    it('should have 6 phases', () => {
      expect(PHASE_ORDER).toHaveLength(6);
    });
  });

  describe('PHASE_DISPLAY_NAMES', () => {
    it('should have display names for all phases', () => {
      for (const phase of PHASE_ORDER) {
        expect(PHASE_DISPLAY_NAMES[phase]).toBeDefined();
        expect(typeof PHASE_DISPLAY_NAMES[phase]).toBe('string');
        expect(PHASE_DISPLAY_NAMES[phase].length).toBeGreaterThan(0);
      }
    });
  });

  describe('PHASE_TRANSITIONS', () => {
    it('should define transitions for init phase', () => {
      expect(PHASE_TRANSITIONS.init).toContain('requirements');
      expect(PHASE_TRANSITIONS.init).not.toContain('design');
      expect(PHASE_TRANSITIONS.init).not.toContain('tasks');
      expect(PHASE_TRANSITIONS.init).not.toContain('implementation');
    });

    it('should define transitions for requirements phase', () => {
      // requirements can go to design or skip to tasks
      expect(PHASE_TRANSITIONS.requirements).toContain('design');
      expect(PHASE_TRANSITIONS.requirements).toContain('tasks');
    });

    it('should define transitions for design phase', () => {
      expect(PHASE_TRANSITIONS.design).toContain('tasks');
      expect(PHASE_TRANSITIONS.design).not.toContain('implementation');
    });

    it('should define transitions for tasks phase', () => {
      expect(PHASE_TRANSITIONS.tasks).toContain('implementation');
      expect(PHASE_TRANSITIONS.tasks).not.toContain('done');
    });

    it('should define transitions for implementation phase', () => {
      expect(PHASE_TRANSITIONS.implementation).toContain('done');
      // Can also go back to tasks
      expect(PHASE_TRANSITIONS.implementation).toContain('tasks');
    });

    it('should have no transitions for done phase', () => {
      expect(PHASE_TRANSITIONS.done).toHaveLength(0);
    });
  });

  describe('Type constraints', () => {
    it('should enforce valid SpecPhase values', () => {
      const validPhases: SpecPhase[] = [
        'init',
        'requirements',
        'design',
        'tasks',
        'implementation',
        'done',
      ];

      validPhases.forEach((phase) => {
        expect(PHASE_ORDER.includes(phase)).toBe(true);
      });
    });

    it('should enforce valid TaskStatus values', () => {
      const validStatuses: TaskStatus[] = [
        'pending',
        'in_progress',
        'completed',
        'blocked',
        'skipped',
      ];

      // Just verify the types compile correctly
      expect(validStatuses).toHaveLength(5);
    });
  });
});
