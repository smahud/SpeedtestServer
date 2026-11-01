# Method 3: Strings Extraction Analysis

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a

## String Extraction Details
- **Minimum length**: 8 characters
- **Output file**: strings_8plus.txt (661,249 bytes)
- **Tool**: GNU strings

## Analysis Results
The strings output from the stripped binary contains predominantly:
1. **Garbled/Binary Data**: Most output appears as non-printable or encoding artifacts
2. **C++ RTTI Data**: Mangled type names and vtable pointers
3. **Exception Handling**: Type info for C++ exception handling

## Notable Extracted Strings (from existing KEY_STRINGS.md)
The previous radare2 analysis extracted 23,000+ meaningful strings including:

### Build Information
- `2017-05-23.1410.3e6b7b4` - Build date/hash
- `2018-10-03.2136.ad52902` - Build date/hash
- `OoklaServer/%s (%s %s; %s; build %s) Poco/%?d.%?d.%?d (%?d cores)` - Version format
- `devbuild` - Development build marker

### Source File References
- `../OoklaServer/src/BinaryManager.cpp`
- `../OoklaServer/src/ClientAuthTokenValidator.cpp`
- `../OoklaServer/src/InstanceLocker.cpp`
- `../OoklaServer/src/LevelChannel.cpp`
- `../OoklaServer/src/LogstashChannel.cpp`
- `../OoklaServer/src/OoklaServer.cpp`
- `../OoklaServer/src/OoklaNamedMutex.cpp`
- `../OoklaServer/src/ConfigManager.cpp`
- `../OoklaServer/src/ConnectionTracker.cpp`
- `../OoklaServer/src/IpStatsManager.cpp`
- `../OoklaServer/src/MetricsUploader.cpp`
- `../OoklaServer/src/OoklaRequestHandler.cpp`
- `../OoklaServer/src/OoklaDownloader.cpp`
- `../OoklaServer/src/TLSCertificateManager.cpp`
- `../OoklaServer/src/TracerouteManager.cpp`
- `../OoklaServer/src/UploadStatsRecorder.cpp`
- `../OoklaServer/src/ClientSessionContext.cpp`
- `../OoklaServer/src/ServerToken.cpp`

### Class Names (Demangled)
- `AESEncryptor` - AES encryption
- `WebSocketLoggerContext` - WebSocket logging context
- `UploadStatsRecorder` - Upload statistics recorder
- `ClientSessionContext` - Client session context
- `IpStatsSession` - IP stats session
- `IpStatsManager` - IP stats manager
- `LevelChannel` - Log level channel
- `LogJsonFormatter` - JSON log formatter
- `LogstashChannel` - Logstash log channel
- `OoklaRequestHandler` - HTTP request handler
- `OoklaSessionData` - Session data
- `OoklaRequestHandlerFactory` - Request handler factory
- `MetricsUploader` - Metrics uploader
- `OoklaDownloader` - Binary downloader
- `OoklaDownloader::DownloadState` - Download state
- `BinaryManager` - Binary management
- `InstanceLocker` - Instance locking
- `ClientAuthTokenValidator` - Token validation
- `ServerToken` - Server token
- `ConnectionTracker` - Connection tracking
- `ConnectionWrapper` - Connection wrapper
- `TLSCertificateManager` - TLS certificate management
- `TracerouteManager` - Traceroute management
- `Config::ValueProcessor` - Config value processor
- `CorsHeaderGenerator` - CORS header generation

### Configuration Keys
```
OoklaServer.clientAuthToken.additionalValidationFields
OoklaServer.clientAuthToken.denyInvalid
OoklaServer.excludeDefaultDomains
OoklaServer.workerThreadPool.capacity
OoklaServer.workerThreadPool.stackSizeBytes
OoklaServer.ipTracking.maxConnPerIp
OoklaServer.maxConnectionSeconds
OoklaServer.http.maxHeadersSize
OoklaServer.ipTracking.gcIntervalMinutes
OoklaServer.ipTracking.maxIdleAgeMinutes
OoklaServer.ipTracking.slidingWindowBucketLengthMinutes
OoklaServer.ipTracking.metricTopIpCount
OoklaServer.ipTracking.maxConnPerBucketPerIp
OoklaServer.allowedDomains
OoklaServer.tcpPorts
OoklaServer.udpPorts
OoklaServer.httpPorts
OoklaServer.useIPv6
OoklaServer.addresses
OoklaServer.useIPv4
OoklaServer.host.id
OoklaServer.userAgentFilterEnabled
OoklaServer.performTraceroutes
OOKLA_SERVER_POCO_CONFIG
```

### API Endpoints
- `/api/servers/errors` - Error reporting
- `/api/servers/metrics` - Metrics upload
- `/crossdomain.xml` - Flash cross-domain policy
- `/random([0-9]+x[0-9]+)\.jpg$` - Download test files (regex)
- `https://host-api.speedtest.net` - Host API
- `https://results.speedtest.net/reports/server/` - Results reporting

### Network/Protocol Strings
- `User-Agent` filtering
- `aes-256` - AES-256 encryption
- `AccessLog` - Access logging
- `MissingKey` - Key validation
- `HOST_API` / `SERVER_URL` - Server identifiers

### POCO/Boost Library References
- POCO Net (HTTP, WebSocket, SSL)
- POCO JSON
- POCO Util (Application, Configuration)
- POCO Foundation
- POCO Dynamic (Var/Any)
- POCO Crypto
- Boost smart_ptr, thread, asio, exception

## Key Observations
1. **Stripped Binary**: Direct strings extraction yields mostly binary artifacts
2. **Previous Analysis**: Radare2 with C++ demangling recovered 23,000+ meaningful strings
3. **Source Paths**: Debug info paths preserved (`../OoklaServer/src/`)
4. **Library Versions**: POCO cmake install paths visible
5. **C++ RTTI**: Type information embedded for exception handling

## Limitations
- Standard `strings` tool cannot recover C++ mangled names without demangling
- Stripped binary removes most human-readable symbols
- Need specialized tools (radare2, Ghidra) for meaningful string recovery
