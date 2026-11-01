# OoklaServer TypeScript Implementation

TypeScript implementation of the OoklaServer speed test server, reverse engineered from the original x86-64 binary.

## Overview

This project is a complete reimplementation of the OoklaServer in TypeScript, based on reverse engineering of the original Linux x86-64 binary. It provides a fully functional speed test server compatible with Ookla's Speedtest clients.

## Features

- **Multi-process Architecture**: Manager + Server processes with shared memory IPC
- **HTTP/REST API**: Configuration, download, upload, latency, and traceroute endpoints
- **WebSocket Support**: Real-time bidirectional communication for speed tests
- **TLS/SSL**: Secure connections with certificate management
- **Client Authentication**: Token-based auth with IP/GUID binding
- **IP Tracking & Rate Limiting**: Sliding window rate limiting per IP
- **Binary Auto-Update**: Automatic updates from host API
- **Metrics Collection**: Periodic metrics upload to host API
- **Structured Logging**: Multi-channel logging (console, file, JSON, Logstash)
- **Traceroute**: ICMP/UDP/TCP traceroute support

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
                        OoklaServer                             
├─────────────────────────────────────────────────────────────┤
  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          
  │  Manager    │  │   Server    │  │   Ward      │          
  │  Process    │◄─┤  Process    │──┤  Processes  │          
  └─────────────┘  └─────────────┘  └─────────────┘          
         │              │              │                       
         └──────────────┼──────────────┘                       
                        ▼                                      
         ┌─────────────────────────┐                          
         │   Shared Memory IPC     │                          
         │  (Mutexes + ShMem)      │                          
         └─────────────────────────┘                          
```

## Project Structure

```
typescript/
├── bin/
│   └── ooklaserver.ts          # CLI entry point
├── src/
│   ├── types/
│   │   └── core.ts             # Core type definitions
│   └── server/
│       ├── OoklaServer.ts      # Main server class
│       ├── ConfigManager.ts    # Configuration management
│       ├── BinaryManager.ts    # Binary auto-update
│       ├── InstanceLocker.ts   # Single instance enforcement
│       ├── ClientAuthTokenValidator.ts  # Token validation
│       ├── ConnectionTracker.ts        # Connection/session tracking
│       ├── IpStatsManager.ts           # IP statistics & rate limiting
│       ├── MetricsUploader.ts          # Metrics collection/upload
│       ├── TLSCertificateManager.ts    # TLS certificate management
│       ├── OoklaRequestHandler.ts      # HTTP/WebSocket request handling
│       ├── OoklaDownloader.ts          # Download test data generation
│       ├── TracerouteManager.ts        # Network traceroute
│       └── Logger.ts                   # Multi-channel logging
├── package.json
├── tsconfig.json
├── jest.config.js
├── .eslintrc.js
├── .gitignore
└── README.md
```

## Installation

```bash
cd typescript
npm install
npm run build
```

## Usage

```bash
# Start in standalone mode (default)
npm start

# Start as manager
npm start -- --role manager

# Start as server
npm start -- --role server

# Development mode
npm run dev
```

## Configuration

Configuration can be provided via:
1. Environment variable: `OOKLA_SERVER_POCO_CONFIG` (JSON)
2. Config files: `config.properties`, `config.ini`, `config.xml`, `ooklaserver.json`
3. Config directories: `/etc/ooklaserver`, `/usr/local/etc/ooklaserver`, `./config`, `.`

Example configuration:
```json
{
  "host": { "id": "your-server-id" },
  "tcpPorts": [5060, 8080],
  "httpPorts": [8080],
  "useIPv6": true,
  "useIPv4": true,
  "addresses": ["0.0.0.0", "::"],
  "clientAuthToken": {
    "additionalValidationFields": [],
    "denyInvalid": false
  },
  "ipTracking": {
    "maxConnPerIp": 100,
    "gcIntervalMinutes": 5,
    "maxIdleAgeMinutes": 30
  }
}
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/ping` | Simple ping |
| GET | `/config` | Server configuration |
| GET | `/settings` | Client settings |
| POST | `/auth/token` | Token validation |
| GET | `/download` | Download test |
| POST | `/upload` | Upload test |
| GET | `/latency` | Latency test |
| GET | `/traceroute` | Traceroute |
| POST | `/metrics` | Client metrics |
| WS | `/ws` | WebSocket connection |

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint code
npm run lint

# Type check
npm run typecheck

# Build for production
npm run build
```

## Reverse Engineering Details

This implementation was created by reverse engineering the original `OoklaServer-linux-x86_64` binary using:
- `radare2` for static analysis
- String extraction and analysis
- Function identification and mapping
- Architecture reconstruction from binary artifacts

Key findings from reverse engineering:
- C++ application using Boost and POCO libraries
- Statically linked ELF binary (~15.5 MB)
- Multi-process architecture with shared memory IPC
- POCO-based HTTP server with WebSocket support
- OpenSSL for TLS/SSL
- Custom binary protocol for speed tests

## License

MIT License - This is a reverse engineering project for educational and interoperability purposes.

## Disclaimer

This is an independent reverse engineering project and is not affiliated with, endorsed by, or connected to Ookla, LLC or Speedtest.net.