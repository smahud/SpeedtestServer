#!/usr/bin/env node
/**
 * SpeedtestServer (canonical TypeScript implementation) — entry point.
 *
 * Usage:
 *   ooklaserver [--config <path>] [--ports 8080,5060] [--udp-ports 8080,5060]
 *               [--evidence-log <path.jsonl>] [--version-string "..."]
 *               [--validate-config] [--role standalone]
 *
 * Environment:
 *   OOKLA_SERVER_POCO_CONFIG   JSON configuration override (daemon parity)
 */

import * as path from 'path';
import { ConfigManager } from '../server/ConfigManager';
import { Logger } from '../server/Logger';
import { OoklaServer } from '../server/OoklaServer';
import { CertificateManager } from '../server/CertificateManager';
import { AcmeProvisioner } from '../server/AcmeProvisioner';
import { OoklaServerConfig, ProcessRole, TlsConfigurationError } from '../types/core';

interface CliOptions {
  role: string;
  configPath?: string;
  validateConfigOnly: boolean;
  configOverrides: Partial<OoklaServerConfig>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // The --config flag is honored — and fail-closed (fixes A-1): the path is
  // ALWAYS recorded so ConfigManager can reject a missing/unreadable file
  // instead of silently falling back to the search path.
  if (options.configPath) {
    process.env.OOKLA_SPEEDTESTSERVER_CONFIG_FILE = path.resolve(options.configPath);
  }

  let configManager: ConfigManager;
  try {
    configManager = new ConfigManager(options.configOverrides);
  } catch (error) {
    console.error(
      `Configuration error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2); // fail closed: explicit config must load
  }
  const config = configManager.getConfig();
  const logger = new Logger(configManager.getLogConfig());

  // --validate-config: resolve the full effective configuration (including
  // TLS material) WITHOUT binding ports or contacting an ACME directory, then
  // exit. Used by install.sh (validate + report TLS readiness) and operators.
  if (options.validateConfigOnly) {
    process.exit(await validateConfig(configManager, logger, options));
  }

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
    await new Promise<void>(() => {
      /* exit is owned by the signal handler (single shutdown path) */
    });
  } catch (error) {
    logger.error('Failed to start SpeedtestServer', { error: String(error) });
    process.exit(1); // fail closed (P0.1 fix: bind errors are fatal)
  }
}

/** Non-binding configuration validation (installer support). Exit 0 = OK. */
async function validateConfig(
  configManager: ConfigManager,
  logger: Logger,
  options: CliOptions,
): Promise<number> {
  const config = configManager.getConfig();
  const report: Record<string, unknown> = {
    configSource: options.configPath || configManager['configFilePath'] || '(defaults/search path)',
    tcpPorts: config.tcpPorts,
    udpPorts: config.udpPorts,
    addresses: config.addresses,
    netgaugeVersionString: config.netgaugeVersionString,
    evidenceLogFile: config.evidenceLogFile || '(disabled)',
  };
  let ok = true;
  try {
    const ssl = config.ssl || {};
    const needsAcme = ssl.useLetsEncrypt === true && !ssl.certificateFile && !ssl.privateKeyFile;
    if (needsAcme && ssl.acme) {
      // Presence check only — no network contact during validation.
      report.tls = {
        mode: 'acme (would provision at startup)',
        directory: ssl.acme.directoryUrl || AcmeProvisioner.DEFAULT_DIRECTORY,
        domains: ssl.acme.domains,
        http01Port: ssl.acme.http01Port ?? 80,
      };
    } else {
      const cm = new CertificateManager(ssl, { logger });
      // For ACME mode without acme config we expect a TlsConfigurationError —
      // that is a validation FAILURE, reported below.
      const res = await cm.resolve();
      report.tls = {
        mode: res.mode,
        source: res.source,
        effectiveUseLetsEncrypt: res.effectiveUseLetsEncrypt,
        publiclyTrusted: res.mode === 'custom' ? !res.warnings.some((w) => w.includes('self-signed') || w.includes('EXPIRED')) : res.mode === 'acme',
        warnings: res.warnings,
      };
    }
  } catch (error) {
    ok = false;
    report.tls = {
      mode: 'INVALID',
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof TlsConfigurationError ? error.code : undefined,
    };
  }
  console.log(JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = { role: 'standalone', validateConfigOnly: false, configOverrides: {} };
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
      case '--validate-config':
        result.validateConfigOnly = true;
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
      --validate-config      Resolve + validate configuration (incl. TLS
                             material) WITHOUT binding ports, then exit
  -r, --role <role>          Process role (standalone; manager/server are
                             legacy labels, single-process architecture)
  -h, --help                 Show this help

Environment:
  OOKLA_SERVER_POCO_CONFIG   JSON configuration override (daemon parity)
`);
}

function setupSignalHandlers(server: OoklaServer, logger: Logger): void {
  // Single shutdown path (fixes A-22): one handler stops the server, flushes
  // logs/evidence, then exits. Exit codes follow the shell convention
  // (130 = SIGINT, 143 = SIGTERM); a failed stop exits non-zero.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    let exitCode = signal === 'SIGINT' ? 130 : 143;
    try {
      await server.stop();
    } catch (error) {
      logger.error('Error during shutdown', { error: String(error) });
      exitCode = 1;
    }
    process.exit(exitCode);
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
