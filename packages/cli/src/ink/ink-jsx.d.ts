import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': any;
      'ink-text': any;
      'ink-virtual-text': any;
      'ink-link': any;
      'ink-progress': any;
      'ink-raw-ansi': any;
      'ink-root': any;
    }
  }
}
