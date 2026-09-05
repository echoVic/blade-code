/**
 * App Slice - 应用状态管理
 *
 * 职责：
 * - 初始化状态
 * - 模态框管理
 * - Task 列表管理
 *
 * 注意：配置管理已迁移到独立的 Config Slice
 */

import type { StateCreator } from 'zustand';
import type { SessionSurfaceSummary } from '../../api/sessionSurfaceSchemas.js';
import type { ModelConfig } from '../../config/types.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';
import type { TaskListItem } from '../../tools/builtin/task/taskListTypes.js';
import type {
  ActiveModal,
  AppSlice,
  AppState,
  BladeStore,
  InitializationStatus,
} from '../types.js';

const MAX_SUBAGENT_TERMINAL_SUMMARY_CHARS = 200;

/**
 * 初始应用状态
 */
const initialAppState: AppState = {
  initializationStatus: 'idle',
  initializationError: null,
  activeModal: 'none',
  sessionSelectorData: undefined,
  sessionHistoryViewerData: undefined,
  taskAttentionStatus: 'idle',
  taskAttentionUnreadKeys: [],
  followUpQueue: null,
  followUpQueueOwner: null,
  followUpQueueMutation: { pending: false, supersededVersions: [] },
  modelEditorTarget: null,
  tasks: [],
  awaitingSecondCtrlC: false,
  reasoningEffort: 'off',
  serviceTier: 'auto',
  responseVerbosity: 'auto',
  communicationStyle: 'auto',
  subagentProgress: null, // 当前无 subagent 执行
  subagentProgresses: {},
  sideConversation: null,
  teams: [],
};

/**
 * 创建 App Slice
 */
export const createAppSlice: StateCreator<BladeStore, [], [], AppSlice> = (set) => ({
  ...initialAppState,

  actions: {
    /**
     * 设置初始化状态
     */
    setInitializationStatus: (status: InitializationStatus) => {
      set((state) => ({
        app: { ...state.app, initializationStatus: status },
      }));
    },

    /**
     * 设置初始化错误
     */
    setInitializationError: (error: string | null) => {
      set((state) => ({
        app: { ...state.app, initializationError: error },
      }));
    },

    /**
     * 设置活动模态框
     */
    setActiveModal: (modal: ActiveModal) => {
      set((state) => ({
        app: { ...state.app, activeModal: modal },
      }));
    },

    /**
     * 显示会话选择器
     */
    showSessionSelector: (
      sessions: SessionSurfaceSummary[],
      intent: SessionSelectionIntent = 'resume'
    ) => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'sessionSelector',
          sessionSelectorData: {
            intent,
            sessions,
          },
          sessionHistoryViewerData: undefined,
        },
      }));
    },

    showSessionHistoryViewer: (
      session: SessionSurfaceSummary,
      intent: SessionSelectionIntent = 'resume'
    ) => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'sessionHistoryViewer',
          sessionSelectorData: undefined,
          sessionHistoryViewerData: { intent, session },
        },
      }));
    },

    /**
     * 显示模型编辑向导
     */
    showModelEditWizard: (model: ModelConfig) => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'modelEditWizard',
          modelEditorTarget: model,
        },
      }));
    },

    /**
     * 关闭模态框
     */
    closeModal: () => {
      set((state) => ({
        app: {
          ...state.app,
          activeModal: 'none',
          sessionSelectorData: undefined,
          sessionHistoryViewerData: undefined,
          modelEditorTarget: null,
        },
      }));
    },

    /**
     * 设置 Task 列表
     */
    setTasks: (tasks: TaskListItem[]) => {
      set((state) => ({
        app: { ...state.app, tasks },
      }));
    },

    /**
     * 更新单个 Task
     */
    updateTask: (task: TaskListItem) => {
      set((state) => ({
        app: {
          ...state.app,
          tasks: state.app.tasks.map((t) => (t.id === task.id ? task : t)),
        },
      }));
    },

    /**
     * 设置是否等待第二次 Ctrl+C 退出
     */
    setAwaitingSecondCtrlC: (awaiting: boolean) => {
      set((state) => ({
        app: { ...state.app, awaitingSecondCtrlC: awaiting },
      }));
    },

    projectTaskAttentionState: (status, unreadKeys) => {
      set((state) => ({
        app: {
          ...state.app,
          taskAttentionStatus: status,
          taskAttentionUnreadKeys: [...unreadKeys],
        },
      }));
    },

    projectFollowUpQueue: (snapshot, owner) => {
      set((state) => {
        const currentSessionOwner = [
          state.session.workspaceRoot,
          state.session.sessionId,
          '',
        ].join('\0');
        if (owner !== undefined && !owner.startsWith(currentSessionOwner)) {
          return state;
        }
        if (
          owner !== undefined &&
          state.app.followUpQueueOwner !== null &&
          state.app.followUpQueueOwner !== owner
        ) {
          return state;
        }
        const previousVersions =
          state.app.followUpQueueMutation.supersededVersions ?? [];
        if (previousVersions.includes(snapshot.version)) {
          return state;
        }
        const supersededVersions =
          state.app.followUpQueue &&
          state.app.followUpQueue.version !== snapshot.version
            ? [...previousVersions, state.app.followUpQueue.version].slice(-16)
            : previousVersions;
        return {
          app: {
            ...state.app,
            followUpQueue: snapshot,
            followUpQueueOwner: owner ?? state.app.followUpQueueOwner,
            followUpQueueMutation: {
              pending: state.app.followUpQueueMutation.pending,
              ...(state.app.followUpQueueMutation.messageId
                ? { messageId: state.app.followUpQueueMutation.messageId }
                : {}),
              supersededVersions,
            },
          },
          command: {
            ...state.command,
            followUpPresentations: Object.fromEntries(
              Object.entries(state.command.followUpPresentations).filter(
                ([messageId]) => snapshot.items.some((item) => item.id === messageId)
              )
            ),
          },
        };
      });
    },

    claimFollowUpQueueOwner: (owner) => {
      set((state) => {
        const currentSessionOwner = [
          state.session.workspaceRoot,
          state.session.sessionId,
          '',
        ].join('\0');
        if (!owner.startsWith(currentSessionOwner)) return state;
        if (state.app.followUpQueueOwner === owner) return state;
        return {
          app: {
            ...state.app,
            followUpQueue: null,
            followUpQueueOwner: owner,
            followUpQueueMutation: { pending: false, supersededVersions: [] },
          },
          command: { ...state.command, followUpPresentations: {} },
        };
      });
    },

    setFollowUpQueueMutation: (mutation, owner) => {
      set((state) => {
        const currentSessionOwner = [
          state.session.workspaceRoot,
          state.session.sessionId,
          '',
        ].join('\0');
        if (owner !== undefined && !owner.startsWith(currentSessionOwner)) {
          return state;
        }
        if (
          owner !== undefined &&
          state.app.followUpQueueOwner !== null &&
          state.app.followUpQueueOwner !== owner
        ) {
          return state;
        }
        return {
          app: {
            ...state.app,
            followUpQueueMutation: {
              ...mutation,
              supersededVersions:
                mutation.supersededVersions ??
                state.app.followUpQueueMutation.supersededVersions,
            },
          },
        };
      });
    },

    clearFollowUpQueue: (owner) => {
      set((state) => {
        if (owner !== undefined && state.app.followUpQueueOwner !== owner) return state;
        return {
          app: {
            ...state.app,
            followUpQueue: null,
            followUpQueueOwner: null,
            followUpQueueMutation: { pending: false, supersededVersions: [] },
          },
          command: { ...state.command, followUpPresentations: {} },
        };
      });
    },

    // ==================== Thinking 模式相关 actions ====================

    setReasoningEffort: (reasoningEffort) => {
      set((state) => ({
        app: { ...state.app, reasoningEffort },
      }));
    },

    setServiceTier: (serviceTier) => {
      set((state) => ({
        app: { ...state.app, serviceTier },
      }));
    },

    setResponseVerbosity: (responseVerbosity) => {
      set((state) => ({
        app: { ...state.app, responseVerbosity },
      }));
    },

    setCommunicationStyle: (communicationStyle) => {
      set((state) => ({
        app: { ...state.app, communicationStyle },
      }));
    },

    /**
     * 设置 Thinking 模式开关状态
     */
    setThinkingModeEnabled: (enabled: boolean) => {
      set((state) => ({
        app: {
          ...state.app,
          reasoningEffort: enabled ? 'auto' : 'off',
        },
      }));
    },

    toggleThinkingMode: () => {
      set((state) => ({
        app: {
          ...state.app,
          reasoningEffort: state.app.reasoningEffort === 'off' ? 'auto' : 'off',
        },
      }));
    },

    // ==================== Subagent 进度相关 actions ====================

    /**
     * 开始 subagent 执行进度
     */
    startSubagentProgress: (id: string, type: string, description: string) => {
      set((state) => ({
        app: {
          ...state.app,
          subagentProgresses: {
            ...state.app.subagentProgresses,
            [id]: {
              id,
              type,
              description,
              status: 'running',
              startTime: Date.now(),
            },
          },
          subagentProgress: {
            id,
            type,
            description,
            status: 'running',
            startTime: Date.now(),
          },
        },
      }));
    },

    /**
     * 更新当前执行的工具名称
     */
    updateSubagentTool: (id: string, toolName: string) => {
      set((state) => {
        const progress = state.app.subagentProgresses[id];
        if (!progress) return state;
        const updated = {
          ...progress,
          currentTool: toolName,
        };
        return {
          app: {
            ...state.app,
            subagentProgresses: {
              ...state.app.subagentProgresses,
              [id]: updated,
            },
            subagentProgress:
              state.app.subagentProgress?.id === id
                ? updated
                : state.app.subagentProgress,
          },
        };
      });
    },

    /**
     * 完成 subagent 执行
     */
    completeSubagentProgress: (
      id: string,
      success: boolean,
      terminalSummary?: string
    ) => {
      set((state) => {
        const progress = state.app.subagentProgresses[id];
        if (!progress) return state;
        const summary = terminalSummary?.trim();
        const updated = {
          ...progress,
          status: success ? ('completed' as const) : ('failed' as const),
          currentTool: undefined,
          ...(!success && summary
            ? {
                terminalSummary: summary.slice(0, MAX_SUBAGENT_TERMINAL_SUMMARY_CHARS),
              }
            : {}),
        };
        return {
          app: {
            ...state.app,
            subagentProgresses: {
              ...state.app.subagentProgresses,
              [id]: updated,
            },
            subagentProgress:
              state.app.subagentProgress?.id === id
                ? updated
                : state.app.subagentProgress,
          },
        };
      });
      setTimeout(() => {
        set((state) => {
          const current = state.app.subagentProgresses[id];
          if (!current || current.status === 'running') return state;
          const subagentProgresses = { ...state.app.subagentProgresses };
          delete subagentProgresses[id];
          const remaining = Object.values(subagentProgresses);
          return {
            app: {
              ...state.app,
              subagentProgresses,
              subagentProgress:
                state.app.subagentProgress?.id === id
                  ? (remaining[remaining.length - 1] ?? null)
                  : state.app.subagentProgress,
            },
          };
        });
      }, 1500);
    },

    startSideConversation: (requestId: string, question: string) => {
      set((state) => ({
        app: {
          ...state.app,
          sideConversation: {
            requestId,
            question,
            status: 'loading',
          },
        },
      }));
    },

    completeSideConversation: (requestId, result) => {
      set((state) => {
        if (state.app.sideConversation?.requestId !== requestId) return state;
        return {
          app: {
            ...state.app,
            sideConversation: {
              requestId,
              question: state.app.sideConversation.question,
              status: 'completed',
              response: result.response,
              durationMs: result.durationMs,
            },
          },
        };
      });
    },

    failSideConversation: (requestId: string, error: string) => {
      set((state) => {
        if (state.app.sideConversation?.requestId !== requestId) return state;
        return {
          app: {
            ...state.app,
            sideConversation: {
              requestId,
              question: state.app.sideConversation.question,
              status: 'error',
              error,
            },
          },
        };
      });
    },

    dismissSideConversation: () => {
      set((state) => ({
        app: {
          ...state.app,
          sideConversation: null,
        },
      }));
    },

    setTeams: (teams) => {
      set((state) => ({
        app: {
          ...state.app,
          teams,
        },
      }));
    },
  },
});
