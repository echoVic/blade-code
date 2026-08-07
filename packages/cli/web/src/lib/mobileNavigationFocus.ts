const MOBILE_NAVIGATION_TRIGGER = '[data-mobile-navigation-trigger]';

export function restoreMobileNavigationFocus(event: Event): boolean {
  return restoreFocusToSelector(MOBILE_NAVIGATION_TRIGGER, event);
}

export function restoreFocusToSelector(selector: string, event: Event): boolean {
  const trigger = document.querySelector<HTMLElement>(selector);
  if (!trigger || trigger.getClientRects().length === 0) return false;

  event.preventDefault();
  trigger.focus({ preventScroll: true });
  return true;
}
