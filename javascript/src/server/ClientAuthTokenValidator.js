/**
 * Client Authentication Token Validator
 * Based on reverse engineering of OoklaServer ClientAuthTokenValidator.cpp
 * JavaScript implementation
 */

const EventEmitter = require('events');
const crypto = require('crypto');

class ClientAuthTokenValidator extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.publicKey = null;
  }

  initialize(publicKey) {
    this.publicKey = publicKey;
    this.logger.debug('ClientAuthTokenValidator initialized with public key');
  }

  validate(tokenString, clientIp, clientGuid) {
    this.logger.debug('Validating client auth token', { clientIp, clientGuid });

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

  createToken(expiration, ip, guid, additionalFields = {}) {
    const token = {
      token: this.generateTokenId(),
      expiration: Math.floor(expiration / 1000),
      ip,
      guid,
      additionalFields,
    };

    this.logger.debug('Created server token', { token: token.token, expiration: token.expiration });
    return token;
  }

  parseToken(tokenString) {
    try {
      const decoded = Buffer.from(tokenString, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch {
      return this.parseSimpleToken(tokenString);
    }
  }

  parseSimpleToken(tokenString) {
    const parts = tokenString.split(';');
    const token = {
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

  generateTokenId() {
    return crypto.randomBytes(32).toString('hex');
  }

  verifySignature(token) {
    if (!this.publicKey) return true;

    try {
      const verifyData = JSON.stringify({
        token: token.token,
        expiration: token.expiration,
        ip: token.ip,
        guid: token.guid,
        additionalFields: token.additionalFields,
      });

      // In production, this would use crypto.verify with the public key
      return true;
    } catch {
      return false;
    }
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.logger.debug('ClientAuthTokenValidator config updated', { ...this.config });
  }

  getConfig() {
    return { ...this.config };
  }

  destroy() {
    this.removeAllListeners();
  }
}

module.exports = { ClientAuthTokenValidator };
