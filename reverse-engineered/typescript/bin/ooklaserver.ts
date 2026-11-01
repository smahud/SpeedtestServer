#!/usr/bin/env node
/**
 * OoklaServer - TypeScript Implementation
 * Main entry point for the server
 */

import { ConfigManager } from '../src/server/ConfigManager';
import { Logger } from '../src/server/Logger';
import { OoklaServer } from '../src/server/OoklaServer';
import { BinaryManager } from '../src/server/BinaryManager';
import { InstanceLocker } from '../src/server/InstanceLocker';
import { ClientAuthTokenValidator } from '../src/server/ClientAuthTokenValidator';
import { ConnectionTracker } from '../src/server/ConnectionTracker';
import { IpStatsManager } from '../src/server/IpStatsManager';
import { MetricsUploader } from '../src/server/MetricsUploader';
import { TLSCertificateManager } from '../src/server/TLSCertificateManager';
import { OoklaRequestHandler } from '../src/server/OoklaRequestHandler';
import { OoklaDownloader } from '../src/server/OoklaDownloader';
import { TracerouteManager } from '../src/server/TracerouteManager';
import { OoklaServerConfig, LogConfig, ProcessRole } from '../src/types/core';

async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  // Load configuration
  const configManager = new ConfigManager(options.configOverrides);
  const config = configManager.getConfig();

  // Initialize logger
  const logConfig = configManager.getLogConfig();
  const logger = new Logger(logConfig);

  logger.info('Starting OoklaServer', {
    version: '1.0.0',
    pid: process.pid,
    role: options.role,
  });

  try {
    // Initialize instance locker
    const instanceLocker = new InstanceLocker(config.sharedMemory || {}, logger);
    await instanceLocker.acquire(options.role as ProcessRole);

    // Initialize binary manager
    const binaryManager = new BinaryManager(config, logger);
    if (config.binaryAutoUpdate !== false) {
      binaryManager.startPeriodicChecks();
    }

    // Initialize TLS certificate manager
    const tlsManager = new TLSCertificateManager(config.tls || {}, logger);
    await tlsManager.initialize();

    // Initialize core components
    const tokenValidator = new ClientAuthTokenValidator(config.clientAuthToken, logger);
    if (config.tls?.publicKey) {
      tokenValidator.initialize(config.tls.publicKey);
    }

    const connectionTracker = new ConnectionTracker(logger);
    const ipStatsManager = new IpStatsManager(config.ipTracking, logger);
    const metricsUploader = new MetricsUploader(config, logger, binaryManager.getCurrentBinary());
    const requestHandler = new OoklaRequestHandler(
      config,
      logger,
      tokenValidator,
      connectionTracker,
      ipStatsManager
    );
    const downloader = new OoklaDownloader(config, logger);
    const tracerouteManager = new TracerouteManager(config.traceroute || {}, logger);

    // Initialize main server
    const server = new OoklaServer(
      config,
      logger,
      instanceLocker,
      binaryManager,
      tlsManager,
      tokenValidator,
      connectionTracker,
      ipStatsManager,
      metricsUploader,
      requestHandler,
      downloader,
      tracerouteManager
    );

    // Setup signal handlers
    setupSignalHandlers(server, logger);

    // Start server
    await server.start();

    logger.info('OoklaServer started successfully');

    // Wait for shutdown
    await server.waitForShutdown();

  } catch (error) {
    logger.error('Failed to start OoklaServer', { error });
    process.exit(1);
  }
}

function parseArgs(args: string[]): {
  role: string;
  configOverrides?: Partial<OoklaServerConfig>;
} {
  const result: { role: string; configOverrides?: Partial<OoklaServerConfig> } = {
    role: 'standalone',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--role':
      case '-r':
        result.role = args[++i] || 'standalone';
        break;
      case '--config':
      case '-c':
        // Config file path would be handled by ConfigManager
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`
OoklaServer - Speed Test Server

Usage: ooklaserver [options]

Options:
  -r, --role <role>     Process role: standalone | manager | server (default: standalone)
  -c, --config <path>   Configuration file path
  -h, --help            Show this help message

Environment Variables:
  OOKLA_SERVER_POCO_CONFIG  JSON configuration override
`);
}

function setupSignalHandlers(server: OoklaServer, logger: Logger): void {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

  for (const signal of signals) {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, shutting down...`);
      await server.stop();
    });
  }

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    server.stop().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
  });
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});