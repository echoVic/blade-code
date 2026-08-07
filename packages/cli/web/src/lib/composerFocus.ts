export function focusBladeComposer(): boolean {
  const composer = document.querySelector<HTMLTextAreaElement>(
    'textarea[data-blade-composer]:not(:disabled)'
  );
  if (!composer) return false;

  composer.focus();
  const end = composer.value.length;
  composer.setSelectionRange(end, end);
  return true;
}
