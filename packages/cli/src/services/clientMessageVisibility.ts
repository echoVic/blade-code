import type { MessagePersistenceMetadata } from '../context/types.js';
import type { Message } from './ChatServiceInterface.js';

const LEGACY_VERIFICATION_CONTROL_PREFIX =
  'This turn made a non-trivial implementation. Before finishing, call Task ';
const LEGACY_VERIFICATION_CONTROL_SUFFIX =
  'Only a fresh structured PASS verdict allows completion.';

export const INTERNAL_CONTROL_MESSAGE_METADATA = {
  clientVisible: false,
} as const satisfies MessagePersistenceMetadata;

export function isClientVisibleMessage(message: Message): boolean {
  if (
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata) &&
    message.metadata.clientVisible === false
  ) {
    return false;
  }

  return !(
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(LEGACY_VERIFICATION_CONTROL_PREFIX) &&
    message.content.endsWith(LEGACY_VERIFICATION_CONTROL_SUFFIX)
  );
}
