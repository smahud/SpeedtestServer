#!/usr/bin/env node
/**
 * OoklaServer - TypeScript Implementation
 * Main entry point for the server
 */

import { ConfigManager } from '../server/ConfigManager';
import { Logger } from '../server/Logger';
import { OoklaServer } from '../server/OoklaServer';
import { OoklaServerConfig, ProcessRole } from '../types/core';

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
    // Create server with configuration
    const server = new OoklaServer(config);

    // Setup signal handlers
    setupSignalHandlers(server, logger);

    // Start server
    await server.start(options.role as ProcessRole);

    logger.info('OoklaServer started successfully');

    // Wait for shutdown signal (handled by signal handlers)
    await new Promise<void>((resolve) => {
      // This promise never resolves; shutdown is handled by signal handlers
      // In a real implementation, you might wait for a shutdown event
      process.on('SIGTERM', () => resolve());
      process.on('SIGINT', () => resolve());
    });

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
      try {
        await server.stop();
      } catch (error) {
        logger.error('Error during shutdown', { error });
      }
      process.exit(0);
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