/**
 * Blade Code Plugins System - Zod Validation Schemas
 *
 * This module provides Zod schemas for validating plugin configurations.
 */

import { z } from 'zod';

/**
 * Plugin name validation
 * - Must be lowercase letters, numbers, and hyphens only
 * - Must start and end with alphanumeric character
 * - Length: 2-64 characters
 */
const pluginNameSchema = z
  .string()
  .min(2, 'Plugin name must be at least 2 characters')
  .max(64, 'Plugin name must be at most 64 characters')
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/, {
    message:
      'Plugin name must be lowercase letters, numbers, and hyphens only, starting and ending with alphanumeric',
  });

/**
 * Semantic version validation (e.g., "1.0.0", "1.0.0-beta.1")
 */
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, {
  message: 'Version must be a valid semantic version (e.g., 1.0.0)',
});

/**
 * Plugin author schema
 */
const pluginAuthorSchema = z.object({
  name: z.string().min(1, 'Author name is required'),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

/**
 * Plugin manifest schema (plugin.json)
 */
export const pluginManifestSchema = z.object({
  name: pluginNameSchema,
  description: z
    .string()
    .min(1, 'Description is required')
    .max(500, 'Description must be at most 500 characters'),
  version: semverSchema,
  author: pluginAuthorSchema.optional(),
  license: z.string().optional(),
  repository: z.string().url().optional(),
  homepage: z.string().url().optional(),
  keywords: z.array(z.string()).optional(),
  dependencies: z.record(z.string()).optional(),
  bladeVersion: z.string().optional(),
});

/**
 * MCP server config schema (for .mcp.json)
 */
const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().positive().optional(),
  oauth: z
    .object({
      enabled: z.boolean().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      authorizationUrl: z.string().url().optional(),
      tokenUrl: z.string().url().optional(),
      scopes: z.array(z.string()).optional(),
      redirectUri: z.string().url().optional(),
    })
    .optional(),
  healthCheck: z
    .object({
      enabled: z.boolean().optional(),
      interval: z.number().positive().optional(),
      timeout: z.number().positive().optional(),
      failureThreshold: z.number().positive().optional(),
    })
    .optional(),
});

/**
 * MCP config file schema (.mcp.json)
 * Supports both { serverName: config } and { mcpServers: { serverName: config } }
 */
const mcpConfigFileSchema = z.union([
  z.object({
    mcpServers: z.record(mcpServerConfigSchema),
  }),
  z.record(mcpServerConfigSchema),
]);

type McpConfigFileInput = z.input<typeof mcpConfigFileSchema>;

/**
 * Validate MCP config file
 */
export function validateMcpConfig(
  data: unknown
): z.SafeParseReturnType<McpConfigFileInput, McpConfigFileInput> {
  return mcpConfigFileSchema.safeParse(data);
}
