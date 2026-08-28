// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPasteMarkerStart,
  getPasteMarkerEnd,
  type PasteContentMap,
  resolveInput,
  useInputBuffer,
} from '../../../../../src/ui/hooks/useInputBuffer.js';

describe('useInputBuffer', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let buffer: ReturnType<typeof useInputBuffer> | undefined;

  function Harness() {
    buffer = useInputBuffer();
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('resolves interleaved text and image paste markers in order', () => {
    let textId = 0;
    let imageId = 0;
    act(() => {
      textId = buffer!.addPasteMapping('pasted text');
      imageId = buffer!.addImagePasteMapping('base64-data', 'image/png');
    });
    const input =
      `before ${createPasteMarkerStart(textId)}summary${getPasteMarkerEnd()} ` +
      `${createPasteMarkerStart(imageId)}image${getPasteMarkerEnd()} after`;

    const resolved = buffer!.resolveInput(input);

    expect(resolved.displayText).toBe('before pasted text [Image #2] after');
    expect(resolved.text).toBe('before pasted text  after');
    expect(resolved.images).toEqual([
      { id: imageId, base64: 'base64-data', mimeType: 'image/png' },
    ]);
    expect(resolved.parts).toEqual([
      { type: 'text', text: 'before pasted text ' },
      { type: 'image', id: imageId, base64: 'base64-data', mimeType: 'image/png' },
      { type: 'text', text: ' after' },
    ]);
  });

  it('preserves an unknown marker as text', () => {
    const marker = `${createPasteMarkerStart(42)}missing${getPasteMarkerEnd()}`;

    expect(buffer!.resolveInput(marker)).toEqual({
      displayText: marker,
      text: marker,
      images: [],
      parts: [{ type: 'text', text: marker }],
    });
  });

  it('exposes paste resolution as a pure function', () => {
    const pasteMap: PasteContentMap = new Map([
      [7, { type: 'text', data: 'expanded' }],
    ]);
    const marker = `${createPasteMarkerStart(7)}summary${getPasteMarkerEnd()}`;

    expect(resolveInput(`before ${marker} after`, pasteMap)).toEqual({
      displayText: 'before expanded after',
      text: 'before expanded after',
      images: [],
      parts: [{ type: 'text', text: 'before expanded after' }],
    });
  });
});
