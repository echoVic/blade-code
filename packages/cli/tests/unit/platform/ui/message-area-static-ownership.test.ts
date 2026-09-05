import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const messageAreaSource = readFileSync(
  new URL('../../../../src/ui/components/MessageArea.tsx', import.meta.url),
  'utf8'
);

describe('MessageArea Static ownership', () => {
  it('projects history and completed stream blocks through one Ink Static root', () => {
    expect(messageAreaSource.match(/<Static\b/g) ?? []).toHaveLength(1);
    expect(messageAreaSource).toContain('? [...staticItems, ...streamingStaticItems]');
    expect(messageAreaSource).toContain(
      '<Static key={clearCount} items={allStaticItems}>'
    );
    expect(messageAreaSource).not.toContain('key={`streaming-${clearCount}`}');
  });

  it('does not reset the streaming tool baseline when a new tool message arrives', () => {
    expect(messageAreaSource).toContain('}, [activeStreamingMessageId, clearCount]);');
    expect(messageAreaSource).not.toContain(
      '}, [activeStreamingMessageId, historyMessages]);'
    );
  });
});
