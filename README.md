# Kiro API Gateway

OpenAI & Anthropic compatible API gateway for Kiro. Built with Bun and Hono.

## Features

- **OpenAI Compatible**: `/v1/chat/completions` endpoint
- **Anthropic Compatible**: `/v1/messages` endpoint
- **Streaming Support**: Real-time SSE streaming for both formats
- **Multi-tenant Mode**: Support multiple users with different credentials
- **Tool Calls**: Full support for function calling / tool use
- **Image Support**: Vision capabilities with base64 images
- **Auto Retry**: Automatic retry with exponential backoff
- **Adaptive Timeout**: Longer timeouts for slow models (Opus)

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime installed
- Kiro credentials (refresh token)

### Installation

```bash
cd kiro-api
bun install
```

### Configuration

Create a `.env` file or set environment variables:

```env
# Required: API key for client authentication
PROXY_API_KEY=your_secret_key

# Option 1: Direct refresh token
REFRESH_TOKEN=your_kiro_refresh_token
PROFILE_ARN=your_profile_arn

# Option 2: Credentials file
KIRO_CREDS_FILE=/path/to/credentials.json

# Optional settings
PORT=8000
KIRO_REGION=us-east-1
LOG_LEVEL=INFO
```

### Credentials File Format

```json
{
  "refreshToken": "your_refresh_token",
  "profileArn": "your_profile_arn",
  "region": "us-east-1"
}
```

### Running

```bash
# Development mode (with hot reload)
bun run dev

# Production mode
bun run start

# Or use startup scripts
./kiro-api-start.command  # macOS/Linux
kiro-api-start.bat        # Windows
```

## API Endpoints

### OpenAI Compatible

```bash
# Chat Completions
POST /v1/chat/completions
Authorization: Bearer YOUR_PROXY_API_KEY

# Models List
GET /v1/models
```

### Anthropic Compatible

```bash
# Messages
POST /v1/messages
x-api-key: YOUR_PROXY_API_KEY

# Or with Authorization header
POST /v1/messages
Authorization: Bearer YOUR_PROXY_API_KEY
```

### Health & Info

```bash
GET /health    # Health check
GET /metrics   # Basic metrics
GET /          # API info
```

## Authentication Modes

### Simple Mode

Use the configured `PROXY_API_KEY`:

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Multi-tenant Mode

Pass user's refresh token with the proxy key:

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY:USER_REFRESH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Available Models

| Model ID | Description |
|----------|-------------|
| `claude-opus-4-5` | Claude Opus 4.5 (Top tier) |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 (Enhanced) |
| `claude-sonnet-4` | Claude Sonnet 4 (Balanced) |
| `claude-haiku-4-5` | Claude Haiku 4.5 (Fast) |
| `claude-3-7-sonnet-20250219` | Claude 3.7 Sonnet (Legacy) |

## Example Usage

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="YOUR_PROXY_API_KEY"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Anthropic SDK (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8000",
    api_key="YOUR_PROXY_API_KEY"
)

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.content[0].text)
```

### cURL

```bash
# Streaming
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Write a haiku about coding"}],
    "stream": true
  }'

# Non-streaming
curl -X POST http://localhost:8000/v1/messages \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_API_KEY` | `changeme_proxy_secret` | API key for client authentication |
| `PORT` | `8000` | Server port |
| `REFRESH_TOKEN` | - | Kiro refresh token |
| `PROFILE_ARN` | - | AWS CodeWhisperer profile ARN |
| `KIRO_REGION` | `us-east-1` | AWS region |
| `KIRO_CREDS_FILE` | - | Path to credentials JSON file |
| `FIRST_TOKEN_TIMEOUT` | `120` | First token timeout (seconds) |
| `STREAM_READ_TIMEOUT` | `300` | Stream read timeout (seconds) |
| `NON_STREAM_TIMEOUT` | `900` | Non-stream timeout (seconds) |
| `MAX_RETRIES` | `3` | Maximum retry attempts |
| `SLOW_MODEL_TIMEOUT_MULTIPLIER` | `3.0` | Timeout multiplier for slow models |
| `LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARN, ERROR) |

## License

Based on [kiro-openai-gateway](https://github.com/Jwadow/kiro-openai-gateway) by Jwadow.

GNU Affero General Public License v3.0

