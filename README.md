# SpeedtestServer - OoklaServer Reverse Engineering Project

A complete TypeScript reimplementation of the OoklaServer speed test server, reverse engineered from the original binaries.

## Overview

This project contains:
1. **Original OoklaServer binaries** for multiple platforms (Linux x86-64, Linux ARM64, macOS, Windows)
2. **Complete TypeScript implementation** (`reverse-engineered/typescript/`) - a full reimplementation of the OoklaServer based on reverse engineering
3. **Architecture-specific configuration files** (`config/`) - `.properties` files matching each binary
4. **Easy-to-read config formats** (`reverse-engineered/typescript/config/`) - TypeScript, JavaScript, and JSON configs
5. **Reverse engineering artifacts** (`reverse-engineered/`) - documentation, extracted strings, and analysis

The TypeScript implementation provides a fully functional speed test server compatible with Ookla's Speedtest clients.

## Repository Structure

```
SpeedtestServer/
├── OoklaServer-linux-x86_64          # Original Linux x86-64 binary (15.5 MB)
├── OoklaServer-linux-aarch64         # Original Linux ARM64 binary (13.8 MB)
├── OoklaServer-macosx                # Original macOS binary (21.8 MB)
├── OoklaServer-windows-x86_64.exe    # Original Windows x86-64 binary (8.7 MB)
├── OoklaServer-windows64.zip         # Original Windows ZIP (3.5 MB)
├── config/                           # Architecture-specific config files
│   ├── OoklaServer-linux-x86_64.properties
│   ├── OoklaServer-linux-aarch64.properties
│   ├── OoklaServer-macosx.properties
│   ├── OoklaServer-windows-x86_64.properties
│   └── OoklaServer.properties.template
├── reverse-engineered/
│   ├── config/                       # Easy-to-read config formats
│   │   ├── ooklaserver.config.ts     # TypeScript config with environments
│   │   ├── ooklaserver.config.js     # JavaScript config
│   │   └── ooklaserver.config.json   # JSON config
│   ├── documentation/
│   │   └── ARCHITECTURE.md           # Comprehensive architecture documentation
│   ├── strings/
│   │   └── KEY_STRINGS.md            # 23,000+ extracted strings
│   ├── typescript/                   # TypeScript implementation (main project)
│   │   ├── bin/ooklaserver.ts        # CLI entry point
│   │   ├── src/
│   │   │   ├── types/core.ts         # Core type definitions (400+ lines)
│   │   │   └── server/               # 13 core components
│   │   │       ├── OoklaServer.ts    # Main server orchestration
│   │   │       ├── ConfigManager.ts  # Multi-source config loading
│   │   │       ├── BinaryManager.ts  # Auto-update from host API
│   │   │       ├── InstanceLocker.ts # Single-instance enforcement
│   │   │       ├── ClientAuthTokenValidator.ts  # Token validation
│   │   │       ├── ConnectionTracker.ts        # Connection/session tracking
│   │   │       ├── IpStatsManager.ts           # IP statistics & rate limiting
│   │   │       ├── MetricsUploader.ts          # Metrics collection/upload
│   │   │       ├── TLSCertificateManager.ts    # TLS certificate management
│   │   │       ├── OoklaRequestHandler.ts      # HTTP/WebSocket request handling
│   │   │       ├── OoklaDownloader.ts          # Download test data generation
│   │   │       ├── TracerouteManager.ts        # Network traceroute
│   │   │       └── Logger.ts                   # Multi-channel logging
│   │   ├── config/                   # TypeScript/JS/JSON configs
│   │   │   ├── ooklaserver.config.ts
│   │   │   ├── ooklaserver.config.js
│   │   │   └── ooklaserver.config.json
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── jest.config.js
│   │   ├── .eslintrc.js
│   │   └── README.md
│   └── PROJECT_SUMMARY.md            # Project summary and status
├── README.md                         # This file
└── .gitignore
```

## Original Binary Analysis

- **File**: `OoklaServer-linux-x86_64` (15,550,832 bytes)
- **Format**: ELF 64-bit LSB executable, x86-64, statically linked, stripped
- **SHA256**: `f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a`
- **Language**: C++ with Boost and POCO libraries
- **Architecture**: Multi-process (Manager + Ward/Server processes)
- **IPC**: Shared memory with mutexes (`OoklaManMu_`, `OoklaSerMu_`, `OoklaShMemMan_`, `OoklaShMemSer_`)
- **Network**: HTTP/REST + WebSocket (POCO Net)
- **Security**: OpenSSL for TLS/SSL
- **Auto-update**: Binary update from host-api.speedtest.net

## TypeScript Implementation Features

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

## Quick Start (TypeScript Implementation)

```bash
# Navigate to TypeScript implementation
cd reverse-engineered/typescript

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Start server (standalone mode)
npm start

# Start as manager
npm start -- --role manager

# Start as server
npm start -- --role server

# Development mode
npm run dev
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

## Configuration

Configuration can be provided via:
1. **Environment variable**: `OOKLA_SERVER_POCO_CONFIG` (JSON)
2. **Config files** (auto-detected in order):
   - `.properties` - Original OoklaServer format (e.g., `OoklaServer.properties`)
   - `.json` - JSON format (e.g., `ooklaserver.json`, `ooklaserver.config.json`)
   - `.js` - JavaScript config (e.g., `ooklaserver.config.js`)
   - `.ts` - TypeScript config (requires compilation, e.g., `ooklaserver.config.ts`)
   - `.ini` - INI format
   - `.xml` - XML format
3. **Config directories** (searched in order):
   - `/etc/ooklaserver`
   - `/usr/local/etc/ooklaserver`
   - `./config`
   - `../config` (for TypeScript project)
   - `.` (current directory)

### Architecture-Specific Config Files
Pre-built `.properties` files for each architecture are in the `config/` directory:
- `config/OoklaServer-linux-x86_64.properties` - Linux x86_64
- `config/OoklaServer-linux-aarch64.properties` - Linux ARM64
- `config/OoklaServer-macosx.properties` - macOS (universal)
- `config/OoklaServer-windows-x86_64.properties` - Windows (includes `adminPassword`)
- `config/OoklaServer.properties.template` - Generic template

### Easy-to-Read Config Formats
In `reverse-engineered/typescript/config/`:
- `ooklaserver.config.ts` - TypeScript with environment configs (development/production/testing)
- `ooklaserver.config.js` - JavaScript version
- `ooklaserver.config.json` - JSON version

### Example Configuration (JSON)
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

### Example Configuration (TypeScript/JavaScript)
```typescript
// reverse-engineered/typescript/config/ooklaserver.config.ts
import { getConfigForEnvironment } from './ooklaserver.config';

// Get production config
const config = getConfigForEnvironment('production');
config.host.id = 'your-server-id-from-ookla';
config.host.password = 'your-server-password';
config.ssl.certificateFile = '/etc/ooklaserver/cert.pem';
config.ssl.privateKeyFile = '/etc/ooklaserver/key.pem';
```

## Development (TypeScript Implementation)

```bash
cd reverse-engineered/typescript

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
- String extraction and analysis (23,000+ strings extracted)
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