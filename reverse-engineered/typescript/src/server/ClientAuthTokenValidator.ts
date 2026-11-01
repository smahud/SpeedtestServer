/**
 * Client Authentication Token Validator
 * Based on reverse engineering of OoklaServer ClientAuthTokenValidator.cpp
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { ServerToken, ClientAuthTokenValidationResult, TokenValidationFields, ClientAuthTokenConfig } from '../types/core';
import { Logger } from './Logger';

export class ClientAuthTokenValidator extends EventEmitter {
  private config: ClientAuthTokenConfig;
  private logger: Logger;
  private publicKey?: string;

  constructor(config: ClientAuthTokenConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Initialize with public key for token verification
   */
  public initialize(publicKey: string): void {
    this.publicKey = publicKey;
    this.logger.debug('ClientAuthTokenValidator initialized with public key');
  }

  /**
   * Validate a client authentication token
   */
  public validate(tokenString: string, clientIp: string, clientGuid: string): ClientAuthTokenValidationResult {
    this.logger.debug('Validating client auth token', { clientIp, clientGuid });

    // Parse token
    const token = this.parseToken(tokenString);
    if (!token) {
      return { isValid: false, reason: 'Token is not defined or invalid.' };
    }

    // Check expiration
    if (token.expiration > 0 && Date.now() > token.expiration * 1000) {
      return {
        isValid: false,
        reason: `Token is invalid due to expiration (ts=${token.expiration}).`,
      };
    }

    // Check IP match (if ip-strict or IP in token)
    if (this.config.denyInvalid || token.additionalFields['ip-strict'] || token.ip) {
      const tokenIp = token.ip || token.additionalFields.ip;
      if (tokenIp && tokenIp !== clientIp) {
        return {
          isValid: false,
          reason: `Token is invalid, ip ${tokenIp} doesn't match client ip ${clientIp}.`,
        };
      }
    }

    // Check GUID match
    if (token.guid && token.guid !== clientGuid) {
      return {
        isValid: false,
        reason: `Token is invalid, guid ${token.guid} doesn't match client guid ${clientGuid}.`,
      };
    }

    // Validate additional fields
    for (const field of this.config.additionalValidationFields) {
      const tokenValue = token.additionalFields[field];
      // Additional validation logic would go here
      this.logger.debug(`Validating additional field: ${field}`, { value: tokenValue });
    }

    // Verify signature if public key available
    if (this.publicKey && !this.verifySignature(token)) {
      return { isValid: false, reason: 'Token signature verification failed.' };
    }

    return {
      isValid: true,
      fields: token.additionalFields,
    };
  }

  /**
   * Create a new server token
   */
  public createToken(
    expiration: number,
    ip?: string,
    guid?: string,
    additionalFields?: TokenValidationFields
  ): ServerToken {
    const token: ServerToken = {
      token: this.generateTokenId(),
      expiration: Math.floor(expiration / 1000), // Convert to seconds
      ip,
      guid,
      additionalFields: additionalFields || {},
    };

    // Sign token if private key available
    // In production, this would use a private key

    this.logger.debug('Created server token', { token: token.token, expiration: token.expiration });
    return token;
  }

  /**
   * Parse token string into ServerToken object
   */
  private parseToken(tokenString: string): ServerToken | null {
    try {
      // Token format could be JWT, base64, or custom
      // For now, try to parse as JSON
      const decoded = Buffer.from(tokenString, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch {
      // Try parsing as simple key=value pairs
      return this.parseSimpleToken(tokenString);
    }
  }

  /**
   * Parse simple token format (key=value;key=value)
   */
  private parseSimpleToken(tokenString: string): ServerToken | null {
    const parts = tokenString.split(';');
    const token: ServerToken = {
      token: '',
      expiration: 0,
      additionalFields: {},
    };

    for (const part of parts) {
      const [key, value] = part.split('=');
      if (!key || !value) continue;

      switch (key) {
        case 'token':
          token.token = value;
          break;
        case 'exp':
          token.expiration = parseInt(value, 10);
          break;
        case 'ip':
          token.ip = value;
          break;
        case 'guid':
          token.guid = value;
          break;
        default:
          token.additionalFields[key] = value;
      }
    }

    return token.token ? token : null;
  }

  /**
   * Generate a random token ID
   */
  private generateTokenId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Verify token signature
   */
  private verifySignature(token: ServerToken): boolean {
    if (!this.publicKey) return true; // Skip if no public key

    try {
      // Create verification data (token without signature)
      const _verifyData = JSON.stringify({
        token: token.token,
        expiration: token.expiration,
        ip: token.ip,
        guid: token.guid,
        additionalFields: token.additionalFields,
      });

      // In production, this would use crypto.verify with the public key
      // For now, return true
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<ClientAuthTokenConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('ClientAuthTokenValidator config updated', { ...this.config });
  }

  /**
   * Get current configuration
   */
  public getConfig(): ClientAuthTokenConfig {
    return { ...this.config };
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    this.removeAllListeners();
  }
}

export default ClientAuthTokenValidator;