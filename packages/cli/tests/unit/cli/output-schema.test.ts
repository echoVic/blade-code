import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCliOutputSchema } from '../../../src/commands/shared/outputSchema.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('resolveCliOutputSchema', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  };

  it('accepts inline and file-backed schemas through the same authority', async () => {
    await expect(
      resolveCliOutputSchema({ jsonSchema: JSON.stringify(schema) })
    ).resolves.toEqual(schema);

    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-output-schema-'));
    roots.push(root);
    const filePath = path.join(root, 'schema.json');
    await writeFile(filePath, JSON.stringify(schema), 'utf8');
    await expect(resolveCliOutputSchema({ outputSchema: filePath })).resolves.toEqual(
      schema
    );
  });

  it('rejects ambiguous and invalid schema sources', async () => {
    await expect(
      resolveCliOutputSchema({
        jsonSchema: JSON.stringify(schema),
        outputSchema: 'schema.json',
      })
    ).rejects.toThrow('cannot be combined');
    await expect(
      resolveCliOutputSchema({
        jsonSchema: JSON.stringify({
          type: 'object',
          properties: { value: { $ref: 'https://example.com/remote.json' } },
        }),
      })
    ).rejects.toThrow('self-contained local $ref');
  });
});
