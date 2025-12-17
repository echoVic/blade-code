# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Blade Code, please report it responsibly.

### How to Report

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. Send an email to the maintainer or use GitHub's private vulnerability reporting feature
3. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

25→- **Response Time**: We will respond as soon as possible, typically within 3 business days
26→- **Resolution**: Critical vulnerabilities will be prioritized and patched as soon as possible
27→- **Credit**: We will credit reporters in the release notes (unless you prefer to remain anonymous)

## Security Best Practices

When using Blade Code, follow these security guidelines:

### API Keys

- **Never** hardcode API keys in your code or configuration files
- Use environment variables: `BLADE_API_KEY`, `QWEN_API_KEY`, `VOLCENGINE_API_KEY`
- Add `.env` files to `.gitignore`

```bash
# Good: Use environment variables
export BLADE_API_KEY="your-api-key"

# Bad: Don't commit this
# config.json with hardcoded keys
```

### Permission System

Blade Code includes a three-level permission system (`allow`, `ask`, `deny`). Use it wisely:

```json
{
  "permissions": {
    "allow": [
      "Read(*)",
      "Glob(*)",
      "Grep(*)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Write(*.env)"
    ]
  }
}
```

### Sensitive Files

Blade Code automatically detects sensitive files. Be cautious when:

- Reading or writing `.env`, `credentials.json`, `secrets.*` files
- Executing shell commands that might expose sensitive data
- Using tools that access network resources

### Network Security

- Be careful when using `WebFetch` and `WebSearch` tools
- Don't fetch untrusted URLs
- Review any data before sending to external APIs

## Known Security Considerations

### Tool Execution

- `Bash` tool can execute arbitrary shell commands
- Always review commands before approving in `ask` mode
- Use `deny` rules for dangerous patterns

### File Access

- `Read`, `Write`, `Edit` tools can access any file the process has permission to
- Use path restrictions in permission rules if needed
- Be cautious in directories with sensitive data

### MCP Protocol

- MCP servers run with the same permissions as Blade Code
- Only install trusted MCP servers
- Review MCP server code before installation

## Dependency Security

We regularly audit dependencies for vulnerabilities:

```bash
# Check for vulnerabilities
pnpm audit

# Update dependencies
pnpm update
```

## Changelog

Security-related changes are documented in [CHANGELOG.md](./CHANGELOG.md) with the `Security` tag.
