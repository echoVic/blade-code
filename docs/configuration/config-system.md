# 模型与配置系统

Blade 使用 `@earendil-works/pi-ai` 作为唯一模型目录和 Provider 运行时。

## 模型配置

`~/.blade/config.json` 只保存模型引用和用户覆盖项：

```json
{
  "currentModelId": "primary",
  "models": [
    {
      "id": "primary",
      "displayName": "DeepSeek Pro",
      "provider": "deepseek",
      "model": "deepseek-v4-pro"
    },
    {
      "id": "fallback",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "overrides": {
        "maxOutputTokens": 8192,
        "timeout": 180000
      }
    }
  ]
}
```

模型的以下信息不写入配置：

- 默认 Base URL
- 上下文窗口
- 最大输出 Token
- reasoning/thinking 能力
- 图片输入能力
- 输入、输出和缓存价格
- Provider API 协议

这些字段全部来自 pi-ai catalog，升级 pi-ai 后自动更新。

## 凭证

API Key 和 OAuth 凭证存储在：

```text
~/.blade/auth.json
```

文件权限为 `0600`。凭证以 pi-ai Provider ID 为键，与模型配置分离：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "..."
  }
}
```

Blade 也支持 pi-ai Provider 原生环境变量。环境变量和凭证解析规则由 pi-ai 管理。

## Provider 与模型目录

CLI、Web 和 ACP 使用同一个本地 pi-ai catalog：

```text
GET /providers
GET /providers/:provider/models
```

Provider 返回：

- Provider ID 和名称
- 模型数量
- 默认 endpoint
- API Key / OAuth 能力
- 当前是否已配置凭证

模型返回：

- Model ID 和名称
- API 协议
- 默认 endpoint
- context window 和 max tokens
- reasoning 和 vision 能力
- 价格

## 高级覆盖

只有确实需要代理网关或特殊请求参数时才使用 `overrides`：

```json
{
  "id": "proxied-claude",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "overrides": {
    "baseUrl": "https://gateway.example.com",
    "temperature": 0,
    "maxOutputTokens": 8192,
    "timeout": 180000,
    "maxRetries": 2,
    "enablePromptCaching": true,
    "customHeaders": {
      "X-Client": "blade"
    }
  }
}
```

覆盖 endpoint 不改变 pi-ai 为该 Provider 选择的协议。

## Fallback

Fallback 使用完整的跨 Provider 模型引用：

```json
{
  "id": "primary",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "fallbackModels": [
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5"
    }
  ]
}
```

## 破坏性升级

不再支持模型记录中的旧字段：

- `name`
- `apiKey`
- `baseUrl`
- `maxContextTokens`
- `maxOutputTokens`
- `supportsThinking`
- `thinkingBudget`
- `thinkingMode`

旧配置会被判定为无效，需要通过 TUI 或 Web 重新选择 pi-ai Provider 和模型。
