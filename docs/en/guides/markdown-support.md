# 📝 Markdown Support

Blade provides full Markdown rendering support in the terminal, including syntax highlighting, tables, code blocks, and more.

## Supported Syntax

### Headings

```markdown
# Heading 1
## Heading 2
### Heading 3
```

### Text Styles

```markdown
**Bold text**
*Italic text*
~~Strikethrough~~
`Inline code`
```

### Lists

```markdown
- Unordered list item 1
- Unordered list item 2
  - Nested list item

1. Ordered list item 1
2. Ordered list item 2
```

### Code Blocks

Code blocks with syntax highlighting:

````markdown
```typescript
function hello(name: string): string {
  return `Hello, ${name}!`;
}
```

```python
def hello(name: str) -> str:
    return f"Hello, {name}!"
```
````

### Tables

```markdown
| Column 1 | Column 2 | Column 3 |
|------|------|------|
| Data | Data | Data |
| Data | Data | Data |
```

### Blockquotes

```markdown
> This is a block of quoted text
> It can span multiple lines
```

### Links

```markdown
[Link text](https://example.com)
```

### Horizontal Rules

```markdown
---
```

## Syntax Highlighting

Blade supports syntax highlighting for many programming languages:

| Language | Identifiers |
|------|--------|
| TypeScript | `typescript`, `ts` |
| JavaScript | `javascript`, `js` |
| Python | `python`, `py` |
| Go | `go`, `golang` |
| Rust | `rust`, `rs` |
| Java | `java` |
| C/C++ | `c`, `cpp` |
| Shell | `bash`, `sh`, `shell` |
| JSON | `json` |
| YAML | `yaml`, `yml` |
| Markdown | `markdown`, `md` |
| SQL | `sql` |
| HTML | `html` |
| CSS | `css` |
| Diff | `diff` |

## Theme Adaptation

Markdown rendering automatically adapts to the current theme's color scheme:

- Code block background color
- Syntax highlighting colors
- Table border color
- Blockquote text color

When you switch themes with the `/theme` command, Markdown rendering updates automatically.

## Terminal Limitations

Due to terminal constraints, some Markdown syntax may not render perfectly:

| Syntax | Support |
|------|----------|
| Images | ❌ Not supported (shown as a link) |
| Complex tables | ⚠️ Partially supported |
| HTML tags | ❌ Not supported |
| Footnotes | ❌ Not supported |
| Task lists | ✅ Supported |
| Nested lists | ✅ Supported |
| Code blocks | ✅ Supported |

## AI Output Format

The AI's replies automatically use Markdown format:

```
User: Explain what TypeScript is

AI: ## Introduction to TypeScript

TypeScript is a superset of JavaScript that adds a static type system.

### Main Features

1. **Static typing** - compile-time type checking
2. **Type inference** - automatically infers variable types
3. **Interfaces** - define object structures

### Example Code

```typescript
interface User {
  name: string;
  age: number;
}

function greet(user: User): string {
  return `Hello, ${user.name}!`;
}
```
```

## Related Resources

- [Theme Configuration](/en/configuration/themes.md) - Theme customization
- [Quick Start](/en/getting-started/quick-start.md) - Basic usage
