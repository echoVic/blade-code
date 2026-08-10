import { ChevronDown, Check } from 'lucide-react';
import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ScrollArea } from './ScrollArea';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find((opt) => opt.value === value);

  React.useEffect(() => {
    if (open) {
      const idx = options.findIndex((opt) => opt.value === value);
      setHighlightedIndex(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (
        event.key === 'Enter' ||
        event.key === ' ' ||
        event.key === 'ArrowDown'
      ) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          onChange(options[highlightedIndex].value);
          setOpen(false);
        }
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
    }
  };

  React.useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    const el = listRef.current?.children[highlightedIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          className={cn(
            'field flex items-center justify-between gap-2 text-left',
            !selected && 'text-zinc-400 dark:text-zinc-500',
            disabled && 'cursor-not-allowed opacity-50',
            className
          )}
        >
          <span className="truncate">
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        onKeyDown={handleKeyDown}
        className="w-[var(--radix-popover-trigger-width)] max-h-[240px] p-1 overflow-hidden"
      >
        <ScrollArea className="max-h-[232px]">
          <div ref={listRef} role="listbox">
            {options.map((opt, i) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                data-value={opt.value}
                data-highlighted={i === highlightedIndex || undefined}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[13px] outline-none transition-colors',
                  i === highlightedIndex &&
                    'bg-zinc-100 dark:bg-zinc-800',
                  opt.value === value &&
                    'text-zinc-900 dark:text-zinc-50 font-medium'
                )}
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    opt.value === value ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="truncate">{opt.label}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
