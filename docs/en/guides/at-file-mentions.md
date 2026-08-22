# 📎 @ File Mentions

The @ file mention feature lets you reference project files directly in a conversation. Blade automatically reads the file content and sends it to the AI as context.

## Quick Start

### Basic Usage

Use `@` in a message to reference a file:

```
Please help me analyze the error handling logic in @src/agent/Agent.ts
```

After typing `@`, a list of file suggestions appears automatically; use the arrow keys to select and `Tab` to confirm.

### Syntax

| Syntax | Description | Example |
|------|------|------|
| `@path` | Bare path | `@src/index.ts` |
| `@"path"` | Quoted path (with spaces) | `@"my file.ts"` |
| `@path#L10` | Single-line reference | `@config.json#L5` |
| `@path#L10-20` | Line-range reference | `@agent.ts#L100-150` |
| `@directory/` | Directory reference | `@src/utils/` |

## Usage Examples

### Analyze a Single File

```
Help me analyze the error handling logic in @src/agent/Agent.ts
```

### Specify a Line Range

```
Explain what the code in @src/agent/Agent.ts#L100-150 does
```

### Compare Multiple Files

```
Compare the implementation differences between @src/agent/Agent.ts and @src/agent/ExecutionEngine.ts
```

### Reference a Directory

```
Analyze the utility functions under @src/utils/
```

### Combine with Other Features

```
Based on the config in @package.json and @tsconfig.json, help me optimize the import statements in @src/index.ts
```

## Path Resolution Rules

### Relative Paths

Resolved relative to the current working directory:

```
@src/agent.ts → /project/src/agent.ts
```

### Absolute Paths

Must be within the workspace:

```
@/Users/you/project/src/agent.ts → ✅ Allowed (within the workspace)
@/etc/passwd → ❌ Denied (outside the workspace)
```

### Path Traversal

Using `..` to escape the workspace is prohibited:

```
@../../etc/passwd → ❌ Denied
```

## Security Restrictions

The following paths are blocked from access:

| Path | Reason |
|------|------|
| `.git/` | Git repository directory |
| `.blade/` | Blade config directory |
| `node_modules/` | Dependency package directory |
| `.env`, `.env.local` | Environment variable files |

## File Limits

| Limit | Default |
|--------|--------|
| Max file size | 1 MB |
| Max lines | 2000 lines |
| Max files per directory | 50 |

Content exceeding a limit is automatically truncated or omitted.

## Line-Number References

When you use a line-number reference, Blade will:

1. Automatically add line-number prefixes
2. Validate whether the line range is valid
3. Show metadata before the file content

Example output:

```xml
<file path="src/agent.ts" range=" (lines 100-150)">
100: export class Agent {
101:   private config: Config;
102:   ...
150: }
</file>
```

## Multi-File References

You can reference multiple files in a single conversation:

```
Based on the config in @package.json and @tsconfig.json,
help me optimize the import statements in @src/index.ts
```

Blade reads all the files in order and sends the content to the AI together.

## File Caching

Blade caches the content of files it reads (60 seconds):

- ✅ Referencing the same file again within 60 seconds hits the cache
- ✅ A different line range triggers a re-read
- ✅ After a file is modified, the next reference refreshes automatically

## Combining with Other Features

### Combine with Plan Mode

```bash
blade --permission-mode plan

# Then in the conversation:
Based on the instructions in @README.md, create an implementation plan
```

### Combine with Tool Calls

```
Read @src/config.ts, then use the Write tool to create a similar config template
```

## FAQ

### Q: Why did a file reference fail?

Possible reasons:

1. **File does not exist** - Check the path spelling
2. **In a restricted directory** - Attempting to access `.git`, `node_modules`, etc.
3. **Path traversal** - Used `..` to escape the workspace
4. **File too large** - Exceeds the 1 MB limit

### Q: How do I reference a file with spaces?

Wrap the path in double quotes:

```
@"my folder/my file.ts"
```

### Q: How many tokens does an @ mention consume?

The file content is appended to the message, so token consumption depends on the file size:

- Rough estimate: 1 token ≈ 4 characters
- Suggestion: Use line-range references to reduce token consumption

### Q: Can I reference binary files?

Not supported. Blade can only read text files.

### Q: A directory reference only shows some files?

For performance reasons, directory references are limited to a maximum of 50 files. Suggestions:

- Reference a more specific subdirectory
- Reference the needed file directly

## Technical Details

### Message Format

The message format after @ mentions are processed:

```xml
Original message content

<system-reminder>
The following files were mentioned with @ syntax:

<file path="src/agent.ts" range=" (lines 100-150)">
100: export class Agent {
101:   ...
</file>
</system-reminder>
```

### Error Handling

If a file fails to read:

1. Continue processing the other files
2. Append the error message at the end of the message
3. The conversation flow is not interrupted

## Related Resources

- [Quick Start](/en/getting-started/quick-start.md) - Basic usage
- [Permission Control](/en/configuration/permissions.md) - File access permissions
