/**
 * workersync.mjs — on-the-fly Cloudflare worker deployment sync (v1.5).
 *
 * "Worker akan selalu sync dengan .env secara on-the-fly": whenever the
 * repository .env changes (CF_WORKER_DEPLOY_COUNT, credentials, shared
 * secret), this module converges the DEPLOYED worker pool to the target:
 *
 *   - deploy missing workers (REST PUT, 6 concurrent — see
 *     hybrid/worker/rest-deploy.mjs)
 *   - delete surplus workers (highest ids first; NEVER worker 1; only exact
 *     pool naming scheme — unrelated account scripts are untouched)
 *   - full redeploy only when the deployment fingerprint changes
 *     (worker bundle, vars, secret, or pool size — persisted in
 *     HYBRID_WORKER_FP_FILE so install-time and runtime syncs agree)
 *
 * Mode:
 *   hybrid    credentials present + deploy target > 0 (the default when a
 *             usable Cloudflare credential exists in .env)
 *   vps-only  no credentials (or target 0) — the gateway serves everything
 *             from the VPS; the front forces the local lane
 *
 * The routing pool (workerpool.mjs) is reconfigured after each convergence
 * so token minting follows the new pool size immediately.
 */
import { converge, createRestCtx } from '../../worker/rest-deploy.mjs';

export function createWorkerSync({ cfg, log = () => {} } = {}) {
  const state = {
    mode: 'vps-only',
    target: 0,
    deployed: null,
    lastSyncAt: 0,
    lastError: null,
    inFlight: false,
    deployStatus: 'unknown',
    lastResult: null,
    history: [],
  };

  function record(kind, detail = {}) {
    state.history.push({ ts: Date.now(), kind, ...detail });
    if (state.history.length > 20) state.history.shift();
    log(`worker_sync_${kind}`, detail);
  }

  function targetCount() {
    if (cfg.cf.mode === 'none' || !cfg.cf.accountId) return 0;
    if (cfg.deployCountExplicit) return Math.min(100, Math.max(0, cfg.deployCount));
    return cfg.poolMax > 0 ? Math.min(100, cfg.poolMax) : 0;
  }

  function effectiveMode() {
    return targetCount() > 0 ? 'hybrid' : 'vps-only';
  }

  async function sync() {
    if (state.inFlight) return { skipped: 'already-running' };
    state.inFlight = true;
    try {
      state.mode = effectiveMode();
      state.target = targetCount();
      if (state.mode === 'vps-only') {
        state.deployed = 0;
        state.deployStatus = 'ok';
        record('vps_only', { reason: cfg.cf.mode === 'none' ? 'no-credentials' : 'target-zero' });
        state.lastResult = { mode: 'vps-only', target: 0 };
        return state.lastResult;
      }
      const ctx = createRestCtx({
        auth: { token: cfg.cf.token, email: cfg.cf.email, key: cfg.cf.key },
        accountId: cfg.cf.accountId,
        baseName: cfg.workerName,
        subdomain: cfg.workersSubdomain,
      });
      const out = await converge({
        poolSize: state.target,
        secret: cfg.secret,
        bundlePath: cfg.workerBundlePath,
        ctx,
        verify: false, // the routing pool canaries workers lazily anyway
        deleteExtra: cfg.workerSyncDelete,
        fingerprintFile: cfg.workerFingerprintFile || '',
        log: (m) => record('converge_log', { message: m.slice(0, 200) }),
      });
      state.deployed = out.final;
      state.lastSyncAt = Date.now();
      state.lastError = null;
      state.deployStatus = 'ok';
      state.lastResult = { mode: 'hybrid', target: state.target, deployed: out.final, deployedNames: out.deployed.length, deletedNames: out.deleted.length, fullRedeploy: out.fullRedeploy };
      record('converged', { target: state.target, deployed: out.final, fullRedeploy: out.fullRedeploy, errors: out.errors.length });
      if (out.errors.length > 0) {
        state.lastError = out.errors[0].slice(0, 200);
        record('converge_errors', { errors: out.errors.slice(0, 3) });
      }
      return state.lastResult;
    } catch (e) {
      state.lastError = String(e && e.message ? e.message : e).slice(0, 200);
      state.deployStatus = 'error';
      record('error', { error: state.lastError });
      return { error: state.lastError };
    } finally {
      state.inFlight = false;
    }
  }

  // Periodic re-check (default off; .env changes always trigger immediately
  // through the runtime env watcher).
  let timer = null;
  if (cfg.workerSyncIntervalMs > 0) {
    timer = setInterval(() => {
      sync();
    }, cfg.workerSyncIntervalMs);
    timer.unref?.();
  }

  function status() {
    return {
      mode: effectiveMode(),
      auth: cfg.cf.mode,
      target: targetCount(),
      deployed: state.deployed,
      lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
      lastError: state.lastError,
      inFlight: state.inFlight,
      deployStatus: state.deployStatus,
      syncDelete: cfg.workerSyncDelete,
      bundlePath: cfg.workerBundlePath,
      history: state.history.slice(-10),
    };
  }

  return { sync, status, state, targetCount, effectiveMode };
}
