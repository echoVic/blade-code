import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const DIST_DIR = path.resolve(process.cwd(), '../dist/web');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const MAX_ENTRY_GZIP_BYTES = 140 * 1024;
const MAX_INITIAL_JS_GZIP_BYTES = 240 * 1024;
const MAX_TOTAL_JS_GZIP_BYTES = 650 * 1024;

function gzipSize(filePath: string): number {
  return gzipSync(readFileSync(filePath)).byteLength;
}

describe('web bundle size', () => {
  it('keeps the initial entry and total JS bundle within budget', () => {
    expect(existsSync(DIST_DIR), 'dist/web 不存在，请先运行 web 构建').toBe(true);
    expect(existsSync(ASSETS_DIR), 'dist/web/assets 不存在，请先运行 web 构建').toBe(
      true
    );

    const indexHtml = readFileSync(path.join(DIST_DIR, 'index.html'), 'utf-8');
    const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+index-[^"]+\.js)"/);
    expect(entryMatch, '未在 index.html 中找到入口 JS').not.toBeNull();

    const entryPath = path.join(DIST_DIR, entryMatch?.[1] ?? '');
    const entryGzipBytes = gzipSize(entryPath);
    expect(entryGzipBytes).toBeLessThanOrEqual(MAX_ENTRY_GZIP_BYTES);

    const initialJsPaths = [
      ...Array.from(
        indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g),
        (match) => match[1]
      ),
      ...Array.from(
        indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g),
        (match) => match[1]
      ),
    ];
    const initialJsNames = initialJsPaths.map((assetPath) => path.basename(assetPath));
    expect(
      initialJsNames.some((name) =>
        /^(MarkdownRenderer|CodeBlockHighlighter|vendor-xterm)-/.test(name)
      )
    ).toBe(false);
    const initialJsGzipBytes = initialJsPaths.reduce(
      (total, assetPath) =>
        total + gzipSize(path.join(DIST_DIR, assetPath.replace(/^\//, ''))),
      0
    );
    expect(initialJsGzipBytes).toBeLessThanOrEqual(MAX_INITIAL_JS_GZIP_BYTES);

    const totalJsGzipBytes = readdirSync(ASSETS_DIR)
      .filter((file) => file.endsWith('.js'))
      .reduce((total, file) => total + gzipSize(path.join(ASSETS_DIR, file)), 0);
    expect(totalJsGzipBytes).toBeLessThanOrEqual(MAX_TOTAL_JS_GZIP_BYTES);
  });
});
