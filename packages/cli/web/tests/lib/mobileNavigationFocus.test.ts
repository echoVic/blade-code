// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  restoreFocusToSelector,
  restoreMobileNavigationFocus,
} from '@/lib/mobileNavigationFocus';

describe('focus restoration', () => {
  it('restores focus to a visible selector target', () => {
    const trigger = document.createElement('button');
    trigger.dataset.mobileNavigationTrigger = '';
    trigger.getClientRects = () => [{ width: 32 }] as unknown as DOMRectList;
    document.body.append(trigger);
    const event = new Event('close', { cancelable: true });

    restoreMobileNavigationFocus(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('preserves default behavior when the target is unavailable', () => {
    const event = new Event('close', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    restoreFocusToSelector('[data-missing-trigger]', event);

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
