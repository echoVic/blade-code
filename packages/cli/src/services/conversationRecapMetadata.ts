/** Display-only recap marker shared by model-context and surface projections. */
export function isConversationRecap(message: { metadata?: unknown }): boolean {
  const metadata = message.metadata;
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    'conversationRecap' in metadata &&
    metadata.conversationRecap === true
  );
}
