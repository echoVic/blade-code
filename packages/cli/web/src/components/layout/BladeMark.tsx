import { cn } from '@/lib/utils';

interface BladeMarkProps {
  className?: string;
  /** Pixel size of the mark. Defaults to 28. */
  size?: number;
  /** Show the discreet pulse ring on the tip. Defaults to true. */
  pulse?: boolean;
}

/**
 * The Blade brand glyph — a hairline diamond blade with a chiseled tip.
 * Uses currentColor for the stroke so it inherits from the parent's text color;
 * the accent notch uses the emerald deck-accent token.
 */
export function BladeMark({ className, size = 28, pulse = true }: BladeMarkProps) {
  return (
    <span
      className={cn(
        'inline-flex relative justify-center items-center',
        'text-[hsl(var(--deck-ink))]',
        className
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Outer diamond */}
        <path
          d="M16 3 L28 16 L16 29 L4 16 Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* Inner blade edge */}
        <path
          d="M16 8 L24 16 L16 24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.55"
        />
        {/* Emerald tip notch */}
        <path
          d="M16 3 L20 7"
          stroke="hsl(var(--deck-accent))"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {pulse && (
        <span
          className="absolute top-[3px] right-[3px] h-1.5 w-1.5 rounded-full"
          style={{
            background: 'hsl(var(--deck-accent-glow))',
            boxShadow: '0 0 6px hsl(var(--deck-accent-glow) / 0.9)',
          }}
        />
      )}
    </span>
  );
}
