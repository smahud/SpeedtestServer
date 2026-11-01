# OoklaServer Reverse Engineering - Architecture Documentation

## Binary Information

- **File**: `OoklaServer-linux-x86_64`
- **Format**: ELF 64-bit (x86_64)
- **SHA256**: `f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a`
- **Size**: 15,550,832 bytes (~15.5 MB)
- **Type**: Statically linked executable

## Technology Stack

### Core Libraries
- **C++ Standard Library** (libstdc++)
- **Boost Libraries**:
  - `boost::shared_ptr` / `boost::smart_ptr` - Memory management
  - `boost::thread` - Threading
  - `boost::format` - String formatting
  - `boost::algorithm` - String algorithms
  - `boost::exception` - Exception handling
  - `boost::asio` (likely) - Network I/O
  - `boost::wrapexcept` - Exception wrapping

- **POCO C++ Libraries**:
  - `Poco::Net` - Network programming (HTTP, WebSocket, sockets)
  - `Poco::JSON` - JSON parsing/serialization
  - `Poco::Util` - Application utilities (configuration, logging)
  - `Poco::Foundation` - Core functionality
  - `Poco::Dynamic` - Dynamic type system (Var/Any)
  - `Poco::Crypto` - Cryptography

- **OpenSSL** - TLS/SSL and AES encryption
- **libcurl** (referenced in user agent filtering)

## Application Architecture

### Process Model
The application uses a **multi-process architecture** with two roles:
1. **Manager Process** - Main controller, handles updates, manages ward processes
2. **Ward/Server Process** - Actual speed test server handling client connections

Key shared memory objects:
- `OoklaManMu_` - Manager mutex
- `OoklaSerMu_` - Server mutex
- `OoklaShMemMan_` - Manager shared memory
- `OoklaShMemSer_` - Server shared memory
- `OoklaShMemManMu_` - Manager shared memory mutex
- `OoklaShMemSerMu_` - Server shared memory mutex

### Core Components

#### 1. BinaryManager (`BinaryManager.cpp`)
- Manages binary auto-updates
- Handles binary renaming/reverting
- Tracks build numbers
- Communicates with update server

#### 2. InstanceLocker (`InstanceLocker.cpp`)
- Ensures single instance per machine
- Uses shared memory for cross-process coordination
- Manages manager/ward process lifecycle
- Handles graceful shutdown

#### 3. ClientAuthTokenValidator (`ClientAuthTokenValidator.cpp`)
- Validates client authentication tokens
- Checks token expiration
- Validates IP address matching
- Validates GUID matching
- Supports additional validation fields

#### 4. ServerToken (`ServerToken.cpp`)
- Token-based authentication
- Token validation with expiration
- IP/GUID binding

#### 5. ConnectionTracker / ConnectionWrapper
- Tracks active connections
- Manages connection lifecycle
- Handles connection expiration

#### 6. UploadStatsRecorder
- Records upload statistics
- Tracks sent/received bytes
- Metrics collection

#### 7. IpStatsManager / IpStatsSession
- IP-based statistics tracking
- Rate limiting per IP
- Connection blocking for abusive IPs
- GC interval and sliding window bucket configuration

#### 8. Logging System
- **LevelChannel** - Log level filtering
- **LogJsonFormatter** - JSON formatted logs
- **LogstashChannel** - Logstash integration
- **ConsoleChannel** / **FileChannel** - Output destinations
- Log levels: fatal, critical, warning, notice, information, debug, trace

#### 9. OoklaDownloader
- Downloads binary updates
- HTTPS support with TLS
- Progress tracking
- Error handling

#### 10. OoklaRequestHandler / OoklaRequestHandlerFactory
- HTTP request processing
- REST API endpoints:
  - `/api/servers/errors` - Error reporting
  - `/api/servers/metrics` - Metrics upload
  - `/crossdomain.xml` - Flash cross-domain policy
  - `/random({size}x{size}).jpg` - Download test files
- CORS support
- Content Security Policy headers

#### 11. MetricsUploader
- Periodic metrics upload
- JSON payload
- Configurable upload interval

#### 12. TLSCertificateManager
- TLS certificate management
- Certificate maintenance loop
- Auto-renewal

#### 13. Traceroute
- Network path tracing
- IPv4 only (IPv6 not supported)
- Queue management

#### 14. Configuration System
- JSON configuration from environment variable
- Config file support (.properties, .ini, .xml)
- Key configuration options:
  - `OoklaServer.tcpPorts` - TCP ports (default: 5060,8080)
  - `OoklaServer.udpPorts` - UDP ports
  - `OoklaServer.httpPorts` - HTTP ports
  - `OoklaServer.useIPv4` / `useIPv6` - IP version support
  - `OoklaServer.addresses` - Listening addresses
  - `OoklaServer.workerThreadPool.capacity` - Thread pool size
  - `OoklaServer.workerThreadPool.stackSizeBytes` - Stack size
  - `OoklaServer.ipTracking.*` - IP tracking config
  - `OoklaServer.clientAuthToken.*` - Auth token config
  - `OoklaServer.allowedDomains` - CORS domains
  - `OoklaServer.host.id` - Server identifier

## Network Protocol

### HTTP Endpoints
- **Health/Status**: `/` - Returns HTML "It worked!" page
- **Cross-domain**: `/crossdomain.xml` - Flash policy file
- **Download Test**: `/random{N}x{N}.jpg` - Random image files for download test
- **Upload Test**: `POST` to `/` - Upload test data
- **Metrics**: `POST /api/servers/metrics` - Server metrics upload
- **Errors**: `POST /api/servers/errors` - Error reporting

### WebSocket
- WebSocket support for real-time communication
- Logger context: `WebSocketLoggerContext`

### Speed Test Protocol
- TCP-based speed testing
- HTTP/HTTPS download/upload tests
- Multiple concurrent connections
- TLS support for secure tests

## Security Features

1. **Client Authentication Tokens** - Token-based client validation
2. **IP Tracking & Rate Limiting** - Per-IP connection limits
3. **User Agent Filtering** - Blocks known non-browser clients
4. **TLS/SSL** - Encrypted communication
5. **CORS Policy** - Configurable allowed domains
6. **Content Security Policy** - Strict CSP headers
7. **Private Key Management** - Salt-based key generation

## Configuration

### Command Line Arguments
- `--version` - Display version
- `--parent-pidfile=` - Parent PID file
- `--pidfile=` - PID file
- `--server-id=` - Server identifier
- `--set-private-key-salt` - Configure private key salt
- `--server-digest` - Compute server digest
- `ward` - Run as ward process
- `develop` - Development mode (disable forking/updates)
- `use-generated-private-key-passphrase` - Use generated passphrase

### Environment Variables
- `OOKLA_SERVER_POCO_CONFIG` - POCO configuration

### Default Ports
- TCP: 5060, 8080
- HTTP: Configurable
- UDP: Configurable

## Build Information

From strings:
- Build dates: `2017-05-23.1410.3e6b7b4`, `2018-10-03.2136.ad52902`
- Embedded public keys for verification
- Version format: `OoklaServer/%s (%s %s; %s; build %s) Poco/%?d.%?d.%?d (%?d cores)`

## Key Data Structures (Inferred)

From string analysis, the following classes/structures exist:

```cpp
// Core classes
class BinaryManager
class InstanceLocker
class ClientAuthTokenValidator
class ServerToken
class ConnectionTracker
class ConnectionWrapper
class UploadStatsRecorder
class ClientSessionContext
class IpStatsManager
class IpStatsSession
class LevelChannel
class LogJsonFormatter
class LogstashChannel
class OoklaDownloader
class OoklaRequestHandler
class OoklaRequestHandlerFactory
class OoklaSessionData
class MetricsUploader
class TLSCertificateManager
class Config::ValueProcessor
class CorsHeaderGenerator
class AESEncryptor
```

## Function Analysis Summary

Total functions identified: ~300+
- Entry/init functions: 130+ (C++ static initialization)
- Large functions (>1000 bytes): ~10 key functions
- Medium functions (100-1000 bytes): ~50 functions
- Small functions (<100 bytes): ~200 functions

Largest functions by byte size:
1. `fcn.0053ca10` - 7220 bytes (likely main server loop)
2. `fcn.00b53a2f` - 1466 bytes
3. `entry.init53` - 2383 bytes
4. `entry.init108` - 2067 bytes
5. `entry.init83` - 1524 bytes
6. `fcn.00295280` - 1769 bytes
7. `fcn.002995b0` - 1691 bytes
8. `fcn.00b1b450` - 755 bytes
9. `fcn.00b46890` - 745 bytes
10. `fcn.0053ca10` - 7220 bytes

## Next Steps for TypeScript Conversion

1. Create TypeScript interfaces for all identified data structures
2. Implement core classes as TypeScript classes
3. Create configuration system
4. Implement HTTP server with Express/Fastify
5. Add WebSocket support
6. Implement authentication/token validation
7. Add metrics collection
8. Implement binary update mechanism
9. Add logging with configurable outputs
10. Create CLI interface