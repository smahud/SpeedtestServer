#!/usr/bin/env node
/**
 * SpeedtestServer (canonical TypeScript implementation) — entry point.
 *
 * Usage:
 *   ooklaserver [--config <path>] [--ports 8080,5060] [--udp-ports 8080,5060]
 *               [--evidence-log <path.jsonl>] [--version-string "..."]
 *               [--role standalone]
 *
 * Environment:
 *   OOKLA_SERVER_POCO_CONFIG   JSON configuration override (daemon parity)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../server/ConfigManager';
import { Logger } from '../server/Logger';
import { OoklaServer } from '../server/OoklaServer';
import { OoklaServerConfig, ProcessRole } from '../types/core';

interface CliOptions {
  role: string;
  configPath?: string;
  configOverrides: Partial<OoklaServerConfig>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // The --config flag is honored: point ConfigManager at the file explicitly.
  if (options.configPath && fs.existsSync(options.configPath)) {
    process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE = path.resolve(options.configPath);
  }

  const configManager = new ConfigManager(options.configOverrides);
  const config = configManager.getConfig();
  const logger = new Logger(configManager.getLogConfig());

  logger.info('Starting SpeedtestServer (independent implementation)', {
    pid: process.pid,
    role: options.role,
    config: options.configPath || '(search path)',
  });

  const server = new OoklaServer(config);
  setupSignalHandlers(server, logger);

  try {
    await server.start(options.role as ProcessRole);
    logger.info('SpeedtestServer started successfully', {
      tcpPorts: config.tcpPorts,
      udpPorts: config.udpPorts,
      version: config.netgaugeVersionString,
    });
    logger.info(`This is an INDEPENDENT open-source implementation — not an Ookla product.`);
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', () => resolve());
      process.on('SIGINT', () => resolve());
    });
    await server.stop();
  } catch (error) {
    logger.error('Failed to start SpeedtestServer', { error: String(error) });
    process.exit(1); // fail closed (P0.1 fix: bind errors are fatal)
  }
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = { role: 'standalone', configOverrides: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--role':
      case '-r':
        result.role = args[++i] || 'standalone';
        break;
      case '--config':
      case '-c':
        result.configPath = args[++i];
        break;
      case '--ports':
      case '-p':
        result.configOverrides.tcpPorts = (args[++i] || '').split(',').map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
        result.configOverrides.httpPorts = result.configOverrides.tcpPorts;
        break;
      case '--udp-ports':
        result.configOverrides.udpPorts = (args[++i] || '').split(',').map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
        break;
      case '--evidence-log':
        result.configOverrides.evidenceLogFile = args[++i] || '';
        break;
      case '--version-string':
        result.configOverrides.netgaugeVersionString = args[++i] || '';
        break;
      case '--help':
      case '-h':
      default:
        if (arg === '--help' || arg === '-h') {
          printUsage();
          process.exit(0);
        }
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`
SpeedtestServer — independent, open-source OoklaServer-compatible speedtest server

Usage: ooklaserver [options]

Options:
  -c, --config <path>        Configuration file (.properties / .json)
  -p, --ports <list>         TCP ports (comma-separated, default 5060,8080 —
                             HTTP/WS/NetGauge/TLS multiplexed on each port)
      --udp-ports <list>     UDP ports (default 5060,8080)
      --evidence-log <path>  JSONL evidence log (connections, commands, bytes)
      --version-string <s>   NetGauge version banner
  -r, --role <role>          Process role (standalone; manager/server are
                             legacy labels, single-process architecture)
  -h, --help                 Show this help

Environment:
  OOKLA_SERVER_POCO_CONFIG   JSON configuration override (daemon parity)
`);
}

function setupSignalHandlers(server: OoklaServer, logger: Logger): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    try {
      await server.stop();
    } catch (error) {
      logger.error('Error during shutdown', { error: String(error) });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: String(error) });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
