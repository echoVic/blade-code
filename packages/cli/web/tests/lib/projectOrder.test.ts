import { describe, expect, it } from 'vitest';
import {
  applyProjectOrder,
  moveProjectPath,
  moveProjectPathBy,
} from '@/lib/projectOrder';

describe('projectOrder', () => {
  const projects = [
    { path: '/workspace/a' },
    { path: '/workspace/b' },
    { path: '/workspace/c' },
  ];

  it('applies persisted paths and appends newly discovered projects', () => {
    expect(
      applyProjectOrder(projects, ['/workspace/c', '/workspace/a']).map(
        (project) => project.path
      )
    ).toEqual(['/workspace/c', '/workspace/a', '/workspace/b']);
  });

  it('moves a dragged project to the target position', () => {
    expect(
      moveProjectPath(
        projects.map((project) => project.path),
        '/workspace/a',
        '/workspace/c'
      )
    ).toEqual(['/workspace/b', '/workspace/c', '/workspace/a']);
    expect(
      moveProjectPath(
        projects.map((project) => project.path),
        '/workspace/c',
        '/workspace/a'
      )
    ).toEqual(['/workspace/c', '/workspace/a', '/workspace/b']);
  });

  it('moves one keyboard position without crossing list boundaries', () => {
    const paths = projects.map((project) => project.path);
    expect(moveProjectPathBy(paths, '/workspace/b', -1)).toEqual([
      '/workspace/b',
      '/workspace/a',
      '/workspace/c',
    ]);
    expect(moveProjectPathBy(paths, '/workspace/a', -1)).toEqual(paths);
  });
});
