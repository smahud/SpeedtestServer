/**
 * Ookla Downloader - Generates test data for download speed tests
 * Based on reverse engineering of OoklaServer Downloader.cpp
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { Logger, OoklaServerConfig } from '../types/core';

export interface DownloadOptions {
  size: number;
  chunkSize?: number;
  pattern?: 'random' | 'zeros' | 'compressible';
  seed?: string;
}

export interface DownloadStream {
  read(size: number): Buffer | null;
  destroy(): void;
  on(event: 'data' | 'end' | 'error', listener: (...args: unknown[]) => void): this;
}

export class OoklaDownloader extends EventEmitter {
  private config: OoklaServerConfig;
  private logger: Logger;
  private activeStreams: Map<string, DownloadStream> = new Map();

  constructor(config: OoklaServerConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Create a download stream for testing
   */
  public createDownloadStream(connectionId: string, options: DownloadOptions): DownloadStream {
    const {
      size,
      chunkSize = 65536,
      pattern = 'random',
      seed,
    } = options;

    const streamId = `${connectionId}-${Date.now()}`;
    let bytesSent = 0;
    let destroyed = false;

    // Create deterministic random generator if seed provided
    let rng: () => Buffer;
    if (seed) {
      const hash = crypto.createHash('sha256').update(seed).digest();
      let counter = 0;
      rng = () => {
        const h = crypto.createHash('sha256').update(Buffer.concat([hash, Buffer.from(counter.toString())])).digest();
        counter++;
        return h;
      };
    } else {
      rng = () => crypto.randomBytes(chunkSize);
    }

    const stream: DownloadStream = {
      read(requestedSize: number): Buffer | null {
        if (destroyed || bytesSent >= size) {
          return null;
        }

        const remaining = size - bytesSent;
        const readSize = Math.min(chunkSize, requestedSize, remaining);

        let chunk: Buffer;
        switch (pattern) {
          case 'zeros':
            chunk = Buffer.alloc(readSize, 0);
            break;
          case 'compressible':
            // Generate compressible pattern (repeating)
            chunk = Buffer.alloc(readSize);
            for (let i = 0; i < readSize; i++) {
              chunk[i] = i % 256;
            }
            break;
          case 'random':
          default:
            chunk = rng().subarray(0, readSize);
            break;
        }

        bytesSent += chunk.length;
        return chunk;
      },

      destroy(): void {
        destroyed = true;
        this.activeStreams.delete(streamId);
      },

      on(event: 'data' | 'end' | 'error', listener: (...args: unknown[]) => void): DownloadStream {
        // EventEmitter-like interface
        return stream;
      },
    };

    this.activeStreams.set(streamId, stream);
    this.emit('streamCreated', { streamId, connectionId, size });

    return stream;
  }

  /**
   * Generate a complete download buffer (for small sizes)
   */
  public generateDownloadBuffer(options: DownloadOptions): Buffer {
    const { size, pattern = 'random', seed } = options;

    let rng: () => Buffer;
    if (seed) {
      const hash = crypto.createHash('sha256').update(seed).digest();
      let counter = 0;
      rng = () => {
        const h = crypto.createHash('sha256').update(Buffer.concat([hash, Buffer.from(counter.toString())])).digest();
        counter++;
        return h;
      };
    } else {
      rng = () => crypto.randomBytes(size);
    }

    switch (pattern) {
      case 'zeros':
        return Buffer.alloc(size, 0);
      case 'compressible':
        const buf = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
          buf[i] = i % 256;
        }
        return buf;
      case 'random':
      default:
        return rng().subarray(0, size);
    }
  }

  /**
   * Get predefined test sizes
   */
  public static getTestSizes(): number[] {
    return [
      1024,           // 1 KB
      10 * 1024,      // 10 KB
      100 * 1024,     // 100 KB
      1024 * 1024,    // 1 MB
      10 * 1024 * 1024, // 10 MB
      25 * 1024 * 1024, // 25 MB
      50 * 1024 * 1024, // 50 MB
      100 * 1024 * 1024, // 100 MB
    ];
  }

  /**
   * Calculate optimal test size based on expected bandwidth
   */
  public static calculateTestSize(expectedMbps: number, testDurationSeconds: number = 10): number {
    const bitsPerSecond = expectedMbps * 1_000_000;
    const bytesPerSecond = bitsPerSecond / 8;
    const totalBytes = bytesPerSecond * testDurationSeconds;

    // Round to nearest test size
    const testSizes = this.getTestSizes();
    return testSizes.reduce((prev, curr) =>
      Math.abs(curr - totalBytes) < Math.abs(prev - totalBytes) ? curr : prev
    );
  }

  /**
   * Generate HTTP response headers for download
   */
  public static getDownloadHeaders(size: number, filename?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size.toString(),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Accept-Ranges': 'bytes',
    };

    if (filename) {
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return headers;
  }

  /**
   * Create ranged download response (for HTTP Range requests)
   */
  public createRangedDownload(
    connectionId: string,
    totalSize: number,
    range: { start: number; end?: number },
    options: Omit<DownloadOptions, 'size'> = {}
  ): { stream: DownloadStream; headers: Record<string, string>; statusCode: number } {
    const start = range.start;
    const end = range.end ?? totalSize - 1;
    const chunkSize = end - start + 1;

    const stream = this.createDownloadStream(connectionId, {
      ...options,
      size: chunkSize,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunkSize.toString(),
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    // Skip to the start position
    let skipped = 0;
    while (skipped < start) {
      const chunk = stream.read(Math.min(65536, start - skipped));
      if (!chunk) break;
      skipped += chunk.length;
    }

    return {
      stream,
      headers,
      statusCode: 206, // Partial Content
    };
  }

  /**
   * Get active stream count
   */
  public getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  /**
   * Destroy all active streams
   */
  public destroyAllStreams(): void {
    for (const stream of this.activeStreams.values()) {
      stream.destroy();
    }
    this.activeStreams.clear();
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<OoklaServerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    this.destroyAllStreams();
    this.removeAllListeners();
  }
}

export default OoklaDownloader;