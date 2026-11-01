/**
 * Ookla Downloader - Generates test data for download speed tests
 * Based on reverse engineering of OoklaServer Downloader.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const crypto = require('crypto');

class OoklaDownloader extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.activeStreams = new Map();
  }

  createDownloadStream(connectionId, options) {
    const {
      size,
      chunkSize = 65536,
      pattern = 'random',
      seed,
    } = options;

    const streamId = `${connectionId}-${Date.now()}`;
    let bytesSent = 0;
    let destroyed = false;
    const activeStreamsRef = this.activeStreams;

    let rng;
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

    const stream = {
      read(requestedSize) {
        if (destroyed || bytesSent >= size) {
          return null;
        }

        const remaining = size - bytesSent;
        const readSize = Math.min(chunkSize, requestedSize, remaining);

        let chunk;
        switch (pattern) {
          case 'zeros':
            chunk = Buffer.alloc(readSize, 0);
            break;
          case 'compressible':
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

      destroy() {
        destroyed = true;
        activeStreamsRef.delete(streamId);
      },

      on(event, listener) {
        return stream;
      },
    };

    this.activeStreams.set(streamId, stream);
    this.emit('streamCreated', { streamId, connectionId, size });

    return stream;
  }

  generateDownloadBuffer(options) {
    const { size, pattern = 'random', seed } = options;

    let rng;
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
      case 'compressible': {
        const buf = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
          buf[i] = i % 256;
        }
        return buf;
      }
      case 'random':
      default:
        return rng().subarray(0, size);
    }
  }

  static getTestSizes() {
    return [
      1024,
      10 * 1024,
      100 * 1024,
      1024 * 1024,
      10 * 1024 * 1024,
      25 * 1024 * 1024,
      50 * 1024 * 1024,
      100 * 1024 * 1024,
    ];
  }

  static calculateTestSize(expectedMbps, testDurationSeconds = 10) {
    const bitsPerSecond = expectedMbps * 1_000_000;
    const bytesPerSecond = bitsPerSecond / 8;
    const totalBytes = bytesPerSecond * testDurationSeconds;

    const testSizes = this.getTestSizes();
    return testSizes.reduce((prev, curr) =>
      Math.abs(curr - totalBytes) < Math.abs(prev - totalBytes) ? curr : prev
    );
  }

  static getDownloadHeaders(size, filename) {
    const headers = {
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

  createRangedDownload(connectionId, totalSize, range, options = {}) {
    const start = range.start;
    const end = range.end ?? totalSize - 1;
    const chunkSize = end - start + 1;

    const stream = this.createDownloadStream(connectionId, {
      ...options,
      size: chunkSize,
    });

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunkSize.toString(),
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    let skipped = 0;
    while (skipped < start) {
      const chunk = stream.read(Math.min(65536, start - skipped));
      if (!chunk) break;
      skipped += chunk.length;
    }

    return {
      stream,
      headers,
      statusCode: 206,
    };
  }

  getActiveStreamCount() {
    return this.activeStreams.size;
  }

  destroyAllStreams() {
    for (const stream of this.activeStreams.values()) {
      stream.destroy();
    }
    this.activeStreams.clear();
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }

  destroy() {
    this.destroyAllStreams();
    this.removeAllListeners();
  }
}

module.exports = { OoklaDownloader };
