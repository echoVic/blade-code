import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskManager } from '../../src/utils/backgroundTaskManager';

describe('BackgroundTaskManager - 后台任务管理器', () => {
	let manager: BackgroundTaskManager;

	beforeEach(() => {
		manager = new BackgroundTaskManager();
	});

	afterEach(() => {
		// 清理所有任务
		const tasks = manager.getAllTasks();
		for (const task of tasks) {
			manager.deleteTask(task.id);
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('createTask - 创建任务', () => {
		it('应该创建任务并返回 ID', () => {
			const taskId = manager.createTask({
				command: 'npm run dev',
				pid: 12345,
			});

			expect(taskId).toMatch(/^task_[a-f0-9]{12}$/);
		});

		it('应该创建任务并设置初始状态', () => {
			const taskId = manager.createTask({
				command: 'npm test',
				pid: 12345,
			});

			const task = manager.getTask(taskId);
			expect(task).toBeDefined();
			expect(task?.status).toBe('running');
			expect(task?.command).toBe('npm test');
			expect(task?.pid).toBe(12345);
			expect(task?.output).toBe('');
			expect(task?.exitCode).toBeNull();
		});

		it('应该记录进程组 ID (pgid)', () => {
			const taskId = manager.createTask({
				command: 'npm test',
				pid: 12345,
				pgid: 12340,
			});

			const task = manager.getTask(taskId);
			expect(task?.pgid).toBe(12340);
		});

		it('应该记录创建时间', () => {
			const before = Date.now();
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});
			const after = Date.now();

			const task = manager.getTask(taskId);
			expect(task?.createdAt).toBeGreaterThanOrEqual(before);
			expect(task?.createdAt).toBeLessThanOrEqual(after);
		});
	});

	describe('getTask - 获取任务', () => {
		it('应该获取存在的任务', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			const task = manager.getTask(taskId);
			expect(task).not.toBeNull();
			expect(task?.id).toBe(taskId);
		});

		it('不存在的任务应该返回 null', () => {
			const task = manager.getTask('nonexistent');
			expect(task).toBeNull();
		});
	});

	describe('getAllTasks - 获取所有任务', () => {
		it('初始状态应该为空', () => {
			const tasks = manager.getAllTasks();
			expect(tasks).toEqual([]);
		});

		it('应该返回所有创建的任务', () => {
			const id1 = manager.createTask({ command: 'task1', pid: 1 });
			const id2 = manager.createTask({ command: 'task2', pid: 2 });

			const tasks = manager.getAllTasks();
			expect(tasks).toHaveLength(2);
			expect(tasks.map((t) => t.id)).toContain(id1);
			expect(tasks.map((t) => t.id)).toContain(id2);
		});
	});

	describe('appendOutput - 追加输出', () => {
		it('应该追加输出内容', () => {
			const taskId = manager.createTask({
				command: 'echo test',
				pid: 123,
			});

			manager.appendOutput(taskId, 'Hello\n');
			manager.appendOutput(taskId, 'World\n');

			const task = manager.getTask(taskId);
			expect(task?.output).toBe('Hello\nWorld\n');
		});

		it('输出超过最大大小时应该截断', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			// 创建超过 100MB 的输出
			const largeOutput = 'x'.repeat(50 * 1024 * 1024); // 50MB
			manager.appendOutput(taskId, largeOutput);
			manager.appendOutput(taskId, largeOutput);
			manager.appendOutput(taskId, largeOutput);

			const task = manager.getTask(taskId);
			// 输出应该被截断到最大大小
			expect(task?.output.length).toBeLessThanOrEqual(100 * 1024 * 1024);
			// 应该包含截断标记
			expect(task?.output).toContain('[output truncated]');
		});

		it('不存在的任务应该忽略追加', () => {
			manager.appendOutput('nonexistent', 'test');
			// 不应该抛出错误
		});
	});

	describe('updateTaskStatus - 更新任务状态', () => {
		it('应该更新任务状态', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			manager.updateTaskStatus(taskId, 'completed', 0);

			const task = manager.getTask(taskId);
			expect(task?.status).toBe('completed');
			expect(task?.exitCode).toBe(0);
		});

		it('应该支持所有状态类型', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			const statuses: Array<'running' | 'completed' | 'killed' | 'failed'> = [
				'running',
				'completed',
				'killed',
				'failed',
			];

			for (const status of statuses) {
				manager.updateTaskStatus(taskId, status);
				const task = manager.getTask(taskId);
				expect(task?.status).toBe(status);
			}
		});

		it('不存在的任务应该忽略更新', () => {
			manager.updateTaskStatus('nonexistent', 'completed', 0);
			// 不应该抛出错误
		});
	});

	describe('deleteTask - 删除任务', () => {
		it('应该删除任务', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			manager.deleteTask(taskId);

			const task = manager.getTask(taskId);
			expect(task).toBeNull();
		});

		it('删除不存在的任务不应该报错', () => {
			manager.deleteTask('nonexistent');
			// 不应该抛出错误
		});
	});

	describe('killTask - 终止任务', () => {
		it('应该标记正在运行的任务为已终止', async () => {
			vi.useFakeTimers();
			const killSpy = vi
				.spyOn(process, 'kill')
				.mockImplementation(() => true);
			const taskId = manager.createTask({
				command: 'sleep 1000',
				pid: process.pid,
			});

			const killPromise = manager.killTask(taskId);
			await vi.advanceTimersByTimeAsync(200);
			const killed = await killPromise;

			const task = manager.getTask(taskId);
			expect(killed).toBe(true);
			expect(task?.status).toBe('killed');
			expect(killSpy).toHaveBeenCalledWith(-process.pid, 'SIGTERM');
			expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
			expect(killSpy).toHaveBeenCalledWith(-process.pid, 'SIGKILL');
		});

		it('非运行状态的任务不应该被终止', async () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			manager.updateTaskStatus(taskId, 'completed', 0);

			const killed = await manager.killTask(taskId);
			expect(killed).toBe(false);
		});

		it('不存在的任务应该返回 false', async () => {
			const killed = await manager.killTask('nonexistent');
			expect(killed).toBe(false);
		});
	});

	describe('边界情况', () => {
		it('应该处理空命令', () => {
			const taskId = manager.createTask({
				command: '',
				pid: 123,
			});

			const task = manager.getTask(taskId);
			expect(task?.command).toBe('');
		});

		it('应该处理负数 PID', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: -1,
			});

			const task = manager.getTask(taskId);
			expect(task?.pid).toBe(-1);
		});

		it('多次追加空字符串不应该改变输出', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			manager.appendOutput(taskId, '');
			manager.appendOutput(taskId, '');

			const task = manager.getTask(taskId);
			expect(task?.output).toBe('');
		});
	});

	describe('并发安全', () => {
		it('应该处理并发创建任务', () => {
			const taskIds = Array.from({ length: 100 }, (_, i) =>
				manager.createTask({
					command: `task${i}`,
					pid: i,
				}),
			);

			// 所有 ID 应该是唯一的
			const uniqueIds = new Set(taskIds);
			expect(uniqueIds.size).toBe(100);

			// 所有任务应该可获取
			expect(manager.getAllTasks()).toHaveLength(100);
		});

		it('应该处理并发输出追加', () => {
			const taskId = manager.createTask({
				command: 'test',
				pid: 123,
			});

			// 并发追加
			for (let i = 0; i < 100; i++) {
				manager.appendOutput(taskId, `line${i}\n`);
			}

			const task = manager.getTask(taskId);
			// 所有输出应该被追加
			for (let i = 0; i < 100; i++) {
				expect(task?.output).toContain(`line${i}`);
			}
		});
	});
});
