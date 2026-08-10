import {
  type SafeParseResult,
  type Static,
  StringEnum,
  safeParseSchema,
  Type,
} from '../../schema/index.js';
import { DecisionBehavior, PermissionDecision } from '../types/HookTypes.js';

const PreToolUseOutputSchema = Type.Object({
  hookEventName: Type.Literal('PreToolUse'),
  permissionDecision: Type.Optional(Type.Enum(PermissionDecision)),
  permissionDecisionReason: Type.Optional(Type.String()),
  updatedInput: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const PostToolUseOutputSchema = Type.Object({
  hookEventName: Type.Literal('PostToolUse'),
  additionalContext: Type.Optional(Type.String()),
  updatedOutput: Type.Optional(Type.Unknown()),
});

const StopOutputSchema = Type.Object({
  hookEventName: Type.Literal('Stop'),
  continue: Type.Optional(Type.Boolean()),
  continueReason: Type.Optional(Type.String()),
});

const SubagentStopOutputSchema = Type.Object({
  hookEventName: Type.Literal('SubagentStop'),
  continue: Type.Optional(Type.Boolean()),
  continueReason: Type.Optional(Type.String()),
  additionalContext: Type.Optional(Type.String()),
});

const PermissionRequestOutputSchema = Type.Object({
  hookEventName: Type.Literal('PermissionRequest'),
  permissionDecision: Type.Optional(StringEnum(['approve', 'deny', 'ask'])),
  permissionDecisionReason: Type.Optional(Type.String()),
});

const ElicitationContentSchema = Type.Record(
  Type.String(),
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Array(Type.String(), { maxItems: 100 }),
  ]),
  { maxProperties: 32 }
);

const ElicitationOutputSchema = Type.Object({
  hookEventName: Type.Literal('Elicitation'),
  action: Type.Optional(StringEnum(['accept', 'decline', 'cancel'])),
  content: Type.Optional(ElicitationContentSchema),
});

const ElicitationResultOutputSchema = Type.Object({
  hookEventName: Type.Literal('ElicitationResult'),
  action: Type.Optional(StringEnum(['accept', 'decline', 'cancel'])),
  content: Type.Optional(ElicitationContentSchema),
});

const UserPromptSubmitOutputSchema = Type.Object({
  hookEventName: Type.Literal('UserPromptSubmit'),
  updatedPrompt: Type.Optional(Type.String()),
  contextInjection: Type.Optional(Type.String()),
});

const SessionStartOutputSchema = Type.Object({
  hookEventName: Type.Literal('SessionStart'),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const CompactionOutputSchema = Type.Object({
  hookEventName: Type.Literal('Compaction'),
  blockCompaction: Type.Optional(Type.Boolean()),
  blockReason: Type.Optional(Type.String()),
});

const HookOutputSchema = Type.Object({
  decision: Type.Optional(
    Type.Object({
      behavior: Type.Enum(DecisionBehavior),
    })
  ),
  systemMessage: Type.Optional(Type.String()),
  hookSpecificOutput: Type.Optional(
    Type.Union([
      PreToolUseOutputSchema,
      PostToolUseOutputSchema,
      StopOutputSchema,
      SubagentStopOutputSchema,
      PermissionRequestOutputSchema,
      ElicitationOutputSchema,
      ElicitationResultOutputSchema,
      UserPromptSubmitOutputSchema,
      SessionStartOutputSchema,
      CompactionOutputSchema,
    ])
  ),
  suppressOutput: Type.Optional(Type.Boolean()),
});

type HookOutput = Static<typeof HookOutputSchema>;

export function safeParseHookOutput(data: unknown): SafeParseResult<HookOutput> {
  return safeParseSchema(HookOutputSchema, data);
}
