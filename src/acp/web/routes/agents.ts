/**
 * Agent 发现路由
 * GET /agents - 列出所有可用的 Agent
 * GET /agents/:name - 获取特定 Agent 的 Manifest
 */

import { Hono } from 'hono';
import type { AgentManifest } from '../types.js';

/**
 * Blade Agent Manifest
 * Blade 只有一个内置的 Agent
 */
const BLADE_AGENT_MANIFEST: AgentManifest = {
  name: 'blade-code',
  description: 'AI-powered CLI coding assistant that helps with code generation, review, and debugging',
  input_content_types: ['text/plain', 'application/json'],
  output_content_types: ['text/plain', 'application/json'],
  metadata: {
    capabilities: [
      { name: 'Code Generation', description: 'Generate code based on natural language descriptions' },
      { name: 'Code Review', description: 'Review and improve existing code quality' },
      { name: 'Debugging', description: 'Help identify and fix bugs in code' },
      { name: 'File Operations', description: 'Read, write, and edit files in the project' },
      { name: 'Shell Commands', description: 'Execute shell commands with user approval' },
      { name: 'Web Search', description: 'Search the web for information' },
    ],
    domains: ['software-development', 'code-generation', 'code-review'],
    tags: ['Code', 'CLI', 'AI-Assistant', 'TypeScript', 'JavaScript', 'Python'],
    author: { name: 'Blade Team' },
  },
};

export function createAgentRoutes(): Hono {
  const app = new Hono();

  // GET /agents - 列出所有 Agent
  app.get('/', (c) => {
    return c.json({
      agents: [BLADE_AGENT_MANIFEST],
    });
  });

  // GET /agents/:name - 获取特定 Agent
  app.get('/:name', (c) => {
    const name = c.req.param('name');

    if (name === 'blade-code') {
      return c.json(BLADE_AGENT_MANIFEST);
    }

    return c.json(
      {
        code: 'not_found',
        message: `Agent not found: ${name}`,
      },
      404
    );
  });

  return app;
}
