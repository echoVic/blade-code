import type {
  BrowserAction,
  BrowserDiagnosticEntry,
  BrowserInspectResult,
  BrowserInteractionResult,
  BrowserObservation,
  BrowserPageResult,
} from '../browser/types.js';
import { Runtime, type Static, StringEnum, Type } from '../schema/index.js';

const BrowserDialogActionSchema = Type.Object(
  {
    action: StringEnum(['accept', 'dismiss']),
  },
  { additionalProperties: false }
);

export const BrowserActionSchema = Runtime(
  Type.Union([
    Type.Object(
      {
        kind: Type.Literal('click'),
        dialog: Type.Optional(BrowserDialogActionSchema),
      },
      { additionalProperties: false }
    ),
    Type.Object({ kind: Type.Literal('hover') }, { additionalProperties: false }),
    Type.Object(
      {
        kind: Type.Literal('fill'),
        value: Type.String(),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        kind: Type.Literal('type'),
        value: Type.String(),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        kind: Type.Literal('press'),
        key: StringEnum([
          'Enter',
          'Tab',
          'Escape',
          'Backspace',
          'Delete',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'Space',
        ]),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        kind: Type.Literal('select'),
        values: Type.Array(Type.String()),
      },
      { additionalProperties: false }
    ),
    Type.Object({ kind: Type.Literal('check') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('uncheck') }, { additionalProperties: false }),
    Type.Object(
      {
        kind: Type.Literal('scroll'),
        direction: StringEnum(['up', 'down', 'left', 'right']),
        amount: Type.Integer(),
      },
      { additionalProperties: false }
    ),
  ])
);

export const WebBrowserNavigateRequestSchema = Runtime(
  Type.Object(
    {
      action: Type.Optional(StringEnum(['goto', 'back', 'forward', 'reload'])),
      url: Type.Optional(Type.String()),
      pageId: Type.Optional(Type.String()),
      expectedOrigin: Type.Optional(Type.String()),
      waitUntil: Type.Optional(StringEnum(['commit', 'domcontentloaded', 'load'])),
      timeoutMs: Type.Optional(Type.Integer()),
    },
    { additionalProperties: false }
  )
);

export const WebBrowserInteractRequestSchema = Runtime(
  Type.Object(
    {
      pageId: Type.String(),
      snapshotId: Type.String(),
      ref: Type.Optional(Type.String()),
      expectedOrigin: Type.String(),
      action: BrowserActionSchema,
      timeoutMs: Type.Optional(Type.Integer()),
    },
    { additionalProperties: false }
  )
);

export type WebBrowserNavigateRequest = Static<typeof WebBrowserNavigateRequestSchema>;
export type WebBrowserInteractRequest = Static<typeof WebBrowserInteractRequestSchema>;

export type {
  BrowserAction,
  BrowserDiagnosticEntry,
  BrowserInspectResult,
  BrowserInteractionResult,
  BrowserObservation,
  BrowserPageResult,
};
