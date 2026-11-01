# Key Strings Extracted from OoklaServer Binary

## Build & Version Information
- `2017-05-23.1410.3e6b7b4` - Build date/hash
- `2018-10-03.2136.ad52902` - Build date/hash
- `OoklaServer/%s (%s %s; %s; build %s) Poco/%?d.%?d.%?d (%?d cores)` - Version string format
- `devbuild` - Development build marker
- `The Ookla Daemon - Build` - Daemon identifier

## Source File References (with paths)
- `../OoklaServer/src/BinaryManager.cpp`
- `../OoklaServer/src/ClientAuthTokenValidator.cpp`
- `../OoklaServer/src/InstanceLocker.cpp`
- `../OoklaServer/src/LevelChannel.cpp`
- `../OoklaServer/src/LogstashChannel.cpp`
- `../OoklaServer/src/OoklaServer.cpp`
- `../OoklaServer/src/OoklaNamedMutex.cpp`

## POCO Library References
- `../poco/cmake_install_Release/include/Poco/ScopedLock.h`
- `../poco/cmake_install_Release/include/Poco/Dynamic/VarHolder.h`
- `../poco/cmake_install_Release/include/Poco/RWLock.h`
- `../poco/cmake_install_Release/include/Poco/String.h`
- `../poco/cmake_install_Release/include/Poco/Util/Application.h`

## Class Names (Mangled C++ Symbols)

### Core Classes
- `12AESEncryptor` - AES encryption
- `22WebSocketLoggerContext` - WebSocket logging context
- `19UploadStatsRecorder` - Upload statistics recorder
- `20ClientSessionContext` - Client session context
- `14IpStatsSession` - IP stats session
- `14IpStatsManager` - IP stats manager
- `12LevelChannel` - Log level channel
- `16LogJsonFormatter` - JSON log formatter
- `15LogstashChannel` - Logstash log channel
- `19OoklaRequestHandler` - HTTP request handler
- `16OoklaSessionData` - Session data
- `26OoklaRequestHandlerFactory` - Request handler factory
- `15MetricsUploader` - Metrics uploader
- `15OoklaDownloader` - Binary downloader
- `25OoklaDownloader::DownloadState` - Download state

### POCO/Boost Types
- `N5boost6detail15sp_counted_baseE` - Boost shared_ptr base
- `N4Poco3Any11ValueHolderE` - POCO Any value holder
- `N4Poco3Net4Impl21IPv4SocketAddressImplE` - IPv4 address impl
- `N4Poco3Net4Impl21IPv6SocketAddressImplE` - IPv6 address impl
- `N6Config14ValueProcessorI...` - Config value processor
- `N4Poco3Any6HolderI...` - POCO Any holder
- `N4Poco7Dynamic13VarHolderImplI...` - Dynamic var holder
- `N4Poco9SharedPtrI...` - POCO SharedPtr
- `N4Poco15RunnableAdapterI...` - Runnable adapter
- `N4Poco20AbstractInstantiatorI...` - Abstract instantiator
- `N4Poco12InstantiatorI...` - Instantiator
- `N4Poco15DefaultStrategyI...` - Default strategy
- `N4Poco13AbstractEventI...` - Abstract event
- `N4Poco10BasicEventI...` - Basic event
- `N4Poco20NotificationStrategyI...` - Notification strategy
- `N4Poco3Net17HTTPClientSessionE` - HTTP client session
- `N4Poco3Net11HTTPRequestE` - HTTP request

## Configuration Keys

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

## API Endpoints
- `/api/servers/errors` - Error reporting
- `/api/servers/metrics` - Metrics upload
- `/crossdomain.xml` - Flash cross-domain policy
- `/random([0-9]+x[0-9]+)\.jpg$` - Download test files (regex)
- `https://host-api.speedtest.net` - Host API
- `https://results.speedtest.net/reports/server/` - Results reporting
- `https://www.speedtest.net` - Main site

## Default Domains (CORS)
- `*.speedtest.net`
- `*.ookla.com`
- `*.speedtestcustom.com`

## User Agent Patterns (Blocked/Filtered)
- `libcurl-.*`
- `AndroidSpeedtest`
- `Wi-Fi Maximiser`
- `SPEEDTEST_CLIENT`
- `Python-urllib`
- `ubnt-test`
- `check_http`
- `curl/.*`
- `LuaSocket.*`
- `showwin/speedtest-go.*`
- `Go-http-client/.*`

## Log Levels
- `fatal`
- `critical`
- `warning`
- `notice`
- `information`
- `debug`
- `trace`

Default pattern: `%Y-%m-%d %H:%M:%S [%P - %I] [%p] %t`

## Test File Sizes (Download)
- `250x250`
- `350x350`
- `500x500`
- `750x750`
- `1000x1000`
- `1500x1500`
- `2000x2000`
- `2500x2500`
- `3000x3000`
- `3500x3500`
- `4000x4000`
- `5000x5000`
- `6000x6000`
- `7000x7000`

## Special Values
- `ServerTokenDev-0` - Development token
- `OoklaManMu_` - Manager mutex name
- `OoklaSerMu_` - Server mutex name
- `OoklaShMemMan_` - Manager shared memory
- `OoklaShMemSer_` - Server shared memory
- `OoklaShMemManMu_` - Manager shared memory mutex
- `OoklaShMemSerMu_` - Server shared memory mutex
- `pong` - Health check response
- `test=test` - Test parameter
- `hello` - Test greeting

## System Paths
- `/proc/sys/net/ipv4/tcp_congestion_control`
- `/proc/sys/net/ipv4/tcp_available_congestion_control`
- `/proc/sys/net/ipv4/tcp_window_scaling`
- `/proc/sys/net/ipv4/tcp_rmem`
- `/proc/sys/net/ipv4/tcp_wmem`
- `/proc/cpuinfo`
- `/proc/loadavg`
- `/proc/self/status`
- `/proc/self/statm`

## Error Messages
- `Couldn't read build number from %s`
- `Binary Manager: Cannot rename binary, error: %s`
- `Binary Manager: Cannot revert to previous binary, error: %s`
- `Failed to retrieve key for token validation: %s`
- `ServerToken::isValid(): Token is not defined or invalid.`
- `ServerToken::isValid(): Token is invalid due to expiration (ts=%*d).`
- `ServerToken::isValid(): Token is invalid, ip %s doesn't match client ip %s.`
- `ServerToken::isValid(): Token is invalid, guid %s doesn't match client guid %s.`
- `ConnectionTracker: exception when closing socket`
- `connection is expired; forcibly`
- `Shared memory open failed, attempting re-open.`
- `Previous application instance has been closed too quickly.`
- `Application was closed with error %?d.`
- `Wrong url for error notifications: '%s'`
- `requestCounterpartGracefulExit: shared memory not available`
- `Manager: wards are dying too quickly, so I give`
- `Manager: starting`
- `Manager: checking... -> The app '%s' is not running`
- `Cannot instantiate new copy of`
- `Failed to download update, error received.`
- `Failed to download update, byte limit reached.`
- `Downloader: specify the OoklaServer pointer`
- `Downloader: specify the path for file saving`
- `Downloader: Unable to create TLS context.`
- `Downloader: Unable to create input stream for download, uri: %s`
- `Downloader: Cannot open file (%s) for write`
- `Downloader: Cannot download data, error: %s`
- `Downloader: Cannot download data, unknown error`
- `Downloader: specify the uri`
- `Downloader: failed finish`
- `Cannot send the POST request to server '%s', %s: '%s' '%s'`
- `Cannot send the GET request to server %s`
- `Terminating server to apply update`
- `New update available, but can't terminate because the manager doesn't seem to be running`
- `Server instance ID has not been defined`
- `TCP port: %?d - current: %?d, queued: %?d, blocked: %?d, queueFull: %?d, concurrent: %?d, currentThreads: %?d`
- `TCP uptime: %?d - total current: %?d, queued: %?d, blocked: %?d, queueFull: %?d, concurrent: %?d, currentThreads: %?d`
- `Connection disallowed due to invalid client token.`
- `Loading JSON configuration from environment variable`
- `No config file found; using defaults`
- `Error loading JSON configuration: %s`
- `Invalid port %s number(%?d), must be > 0 and < 65536`
- `Cannot read %s ports from config file.`
- `Invalid listening IP Address (%s) in config file.`
- `Cannot read listening IP Addresses from config file.`
- `Cannot read config '%s'. Reverting to default '%s'`
- `Generating %?d bytes of download data`
- `Cannot start UDP server, port: %?d failed, error: %s`
- `Application failed to start: %s`
- `Application failed to start: unknown error`
- `Private key password generation is enabled but the salt has not been set. Use --set-private-key-salt to configure.`
- `OoklaServer version %s (%s) build number %s`
- `Waiting for UDP threads to exit.`
- `Waiting for traceroute threads to exit.`
- `Traceroute threads have exited.`
- `Failed to compute server digest: %s`
- `Failed to parse user agent block list:`
- `Blocked request from userAgent %s.`
- `Traceroute: IP Address %s is ipv6, which is currently not supported.`
- `Too many traceroute requests waiting. Skipping traceroute for guid %s`
- `Initiating new traceroute for guid %s, queue size %d, executing %d`
- `CorsHeaderGenerator: Unable to retrieve host API public key from key store: %s`
- `Metrics upload failed: invalid url: '%s'`
- `Metrics updates Sending metrics every %?d minute`
- `Uploading metrics json (%?d byte`
- `Metrics upload failed: posting t`
- `Unknown key '%s' requested.`
- `Log level out of range`
- `Not a valid log level`
- `Can not convert to DateTime`
- `Can not convert to LocalDateTime`
- `Can not convert to Timestamp`
- `Can not convert to UUID`
- `Can not convert to Poco::UTF16String`
- `Can not convert %s to %s.`
- `Can not extract empty value.`
- `Value too small.`
- `Value too large.`
- `Cannot create std::vector larger than max_size()`
- `Cannot create std::deque larger than max_size()`
- `cannot lock mutex`
- `cannot unlock mutex`
- `cannot signal event (lock)`
- `cannot signal event`
- `cannot reset event`
- `cannot create std::vector larger than max_size()`

## Metrics Fields
- `uniqueTests`
- `unidentifiedTests`
- `sentBytes`
- `receivedBytes`
- `sentBytesTotal`
- `receivedBytesTotal`
- `congestionControl`
- `availableCongestionControl`
- `windowScaling`
- `default`
- `numFiles`
- `disabled`
- `established`
- `blocked`
- `connectionSeconds`
- `maxConcurrent`
- `listeningAddresses`
- `exceededMaxDuration`
- `model name` (from /proc/cpuinfo)
- `cpuModelName`
- `loadAverage10Mins`
- `runningProcesses`
- `totalProcesses`
- `limits`
- `cpus`
- `FDSize` (from /proc/self/status)
- `fdSize`
- `numThreads`
- `vmSize`
- `vmRss`

## IP Tracking Config Fields
- `network`
- `speedtest`
- `ipstats`
- `uptime`
- `queued`
- `queueFull`
- `max_concurrent`
- `current_threads`

## Command Line Arguments
- `--version`
- `--parent-pidfile=`
- `--pidfile=`
- `--server-id=`
- `ward`
- `develop`
- `use-generated-private-key-passphrase`
- `set-private-key-salt`
- `server-digest`
- `help` - display help information
- `display version`

## Public Keys (Base64 encoded PEM)
Multiple public keys embedded for:
- Update verification
- Host API communication
- Server authentication

## Regex Patterns
- `/random([0-9]+x[0-9]+)\.jpg$` - Download test file matching
- `basic_string::_M_construct null not valid`
- `vector::_M_range_insert`
- `vector::reserve`
- `vector::_M_realloc_insert`
- `deque::_M_new_elements_at_front`
- `deque::_M_new_elements_at_back`
- `basic_string::basic_string`
- `basic_string::append`
- `basic_string::substr`
- `basic_string::erase`
- `%.200s %.200s %.200s`
- `%.200s WS/1.0`
- `vector::_M_fill_insert`