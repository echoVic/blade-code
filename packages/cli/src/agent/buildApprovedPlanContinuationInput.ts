import { PermissionMode } from '../config/types.js';
import type { ChatContext, UserMessageContent } from './types.js';

export interface ApprovedPlanContinuationInput {
  message: UserMessageContent;
  context: ChatContext;
}

export function buildApprovedPlanContinuationInput({
  message,
  context,
  targetMode,
  planContent,
}: {
  message: UserMessageContent;
  context: ChatContext;
  targetMode: PermissionMode;
  planContent?: string;
}): ApprovedPlanContinuationInput {
  let continuedMessage = message;

  if (planContent) {
    const planSuffix = `

<approved-plan>
${planContent}
</approved-plan>

IMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;

    if (typeof message === 'string') {
      continuedMessage = message + planSuffix;
    } else {
      continuedMessage = [...message, { type: 'text', text: planSuffix }];
    }
  }

  return {
    message: continuedMessage,
    context: {
      ...context,
      permissionMode: targetMode,
    },
  };
}
