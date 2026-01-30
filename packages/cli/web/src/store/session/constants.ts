import type { TokenUsage } from './types'

export const TEMP_SESSION_ID = '__temp__'

export const READ_ONLY_TOOLS = new Set([
  'Glob',
  'Grep',
  'Read',
  'LS',
  'SearchCodebase',
  'WebSearch',
  'WebFetch',
  'mcp_Fetch_fetch',
  'mcp_context7_resolve-library-id',
  'mcp_context7_query-docs',
  'mcp_GitHub_search_repositories',
  'mcp_GitHub_search_code',
  'mcp_GitHub_search_issues',
  'mcp_GitHub_search_users',
  'mcp_GitHub_get_file_contents',
  'mcp_GitHub_list_commits',
  'mcp_GitHub_list_issues',
  'mcp_GitHub_list_pull_requests',
  'mcp_GitHub_get_issue',
  'mcp_GitHub_get_pull_request',
  'mcp_GitHub_get_pull_request_files',
  'mcp_GitHub_get_pull_request_status',
  'mcp_GitHub_get_pull_request_comments',
  'mcp_GitHub_get_pull_request_reviews',
  'mcp_pencil_get_editor_state',
  'mcp_pencil_get_guidelines',
  'mcp_pencil_get_screenshot',
  'mcp_pencil_get_style_guide',
  'mcp_pencil_get_style_guide_tags',
  'mcp_pencil_get_variables',
  'mcp_pencil_snapshot_layout',
  'mcp_pencil_search_all_unique_properties',
  'mcp_pencil_batch_get',
  'mcp_Puppeteer_puppeteer_screenshot',
  'mcp_Sequential_Thinking_sequentialthinking',
  'CheckCommandStatus',
  'GetDiagnostics',
])

export const isReadOnlyTool = (toolName: string): boolean => {
  if (READ_ONLY_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp_') && toolName.includes('_get_')) return true
  if (toolName.startsWith('mcp_') && toolName.includes('_list_')) return true
  if (toolName.startsWith('mcp_') && toolName.includes('_search_')) return true
  return false
}

export const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 128000,
  isDefaultMaxTokens: true,
}
