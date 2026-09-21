/**
 * First-party crash breadcrumb (build-18 candidate #1).
 *
 * Installs a global JS error handler + an unhandled-promise-rejection hook that
 * fire-and-forget POSTs a small row to `app_diagnostics` (insert-only RLS,
 * anon + authenticated) so a production crash leaves a first-party signature
 * even before any .ips log reaches us. This is the first-party diagnostics
 * channel the plan already commits to (privacy answers declare Diagnostics
 * collection); it never uses a third-party SDK.
 *
 * WHY BOTH HOOKS (RN 0.86 / New Architecture):
 *  - `ErrorUtils.setGlobalHandler` catches module-load errors and anything that
 *    routes through `ErrorUtils.reportError` / `reportFatalError`.
 *  - `global.RN$handleException` is the New-Architecture native hook: uncaught
 *    runtime JS errors AND unhandled promise rejections land here (RN routes
 *    unhandled rejections through ExceptionsManager.handleException -> this
 *    hook, see Libraries/promiseRejectionTrackingOptions.js). Wrapping it is
 *    what makes "unhandled rejection" coverage real on this stack.
 *
 * PRIVACY: the payload is the error content ONLY — message + stack + app
 * version + build number + timestamp. No user id, name, email, install id, or
 * session id. A stack could in principle embed a file path, which is why the
 * table is insert-only (clients can never read it back) and dashboards are
 * service-role only. No photo paths, no captions, no partner data.
 *
 * SAFETY: every entry point is try/caught and the POST is raced against a hard
 * timeout, so the handler can never hang the crash path or throw.
 */
import Constants from 'expo-constants';

import { supabase } from './supabase';

type ErrorHandler = (error: unknown, isFatal: boolean) => void;
type NativeHandleException = (
  error: unknown,
  isFatal: boolean,
  reportToConsole?: boolean,
) => unknown;

interface RnErrorUtils {
  setGlobalHandler(fn: ErrorHandler): void;
  getGlobalHandler(): ErrorHandler;
  reportError(error: unknown): void;
  reportFatalError(error: unknown): void;
}

/** The RN globals this module reads (present at runtime, absent in Node). */
interface RnGlobals {
  ErrorUtils?: RnErrorUtils;
  RN$handleException?: NativeHandleException;
}

/** Never let a slow network hold the crash handler open. */
const HARD_TIMEOUT_MS = 1500;
/** One crash can reach both hooks; collapse near-identical reports. */
const DEDUPE_WINDOW_MS = 2000;

let lastSignature = '';
let lastSignatureAt = 0;

function readBuildMeta(): { appVersion: string | null; buildNumber: string | null } {
  // The resolved embedded config: `version` (CFBundleShortVersionString) and
  // `ios.buildNumber` (CFBundleVersion). Null-safe for dev-mock/web.
  const cfg = Constants.expoConfig;
  return {
    appVersion: cfg?.version ?? null,
    buildNumber: cfg?.ios?.buildNumber ?? null,
  };
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toStack(error: unknown): string | null {
  if (error instanceof Error) return error.stack ?? null;
  return null;
}

/**
 * Report a crash breadcrumb. Safe to call from any context: never throws, never
 * blocks, and no-ops in dev-mock mode (no backend) where the redbox already
 * surfaces the error.
 */
export function reportCrash(message: string, stack?: string | null): void {
  try {
    const now = Date.now();
    const signature = `${message}\n${stack ?? ''}`;
    if (signature === lastSignature && now - lastSignatureAt < DEDUPE_WINDOW_MS) return;
    lastSignature = signature;
    lastSignatureAt = now;

    const { appVersion, buildNumber } = readBuildMeta();
    const payload = {
      message,
      stack: stack ?? null,
      app_version: appVersion,
      build_number: buildNumber,
      ts: new Date().toISOString(),
    };

    const client = supabase; // null in dev-mock mode (env vars absent)
    if (!client) return;

    // Fire-and-forget + hard timeout. A failed insert must never surface.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, HARD_TIMEOUT_MS));
    const send = client
      .from('app_diagnostics')
      .insert(payload)
      .then(() => undefined);
    Promise.race([send, timeout]).catch(() => {
      /* observability, never the product */
    });
  } catch {
    /* never throw from the breadcrumb path */
  }
}

let installed = false;

/**
 * Install the global error hooks. Idempotent; call once at app start (module
 * scope of the root layout, before the first render can throw). Preserves the
 * previous handlers so the default redbox/fatal behavior is unchanged.
 */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as RnGlobals;

  // 1. Classic global handler (module-load + reportError/reportFatalError).
  const ErrorUtils = g.ErrorUtils;
  if (ErrorUtils?.setGlobalHandler) {
    const prev = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      reportCrash(toMessage(error), toStack(error));
      try {
        prev?.(error, isFatal);
      } catch {
        /* keep the original behavior best-effort */
      }
    });
  }

  // 2. New-Architecture native hook (RN 0.86+): uncaught runtime errors and
  //    unhandled promise rejections route through here.
  //
  // DO NOT "simplify" this back to `if (typeof rnHandle === 'function') g.RN$handleException = ...`.
  // React Native installs this global with defineReadOnlyGlobal()
  // (ReactCommon/react/utils/jsi-utils.cpp -> Object.defineProperty(global, name, {value}),
  // i.e. writable:false, configurable:false; called from
  // ReactCommon/react/runtime/ReactInstance.cpp for "RN$handleException"), and Metro emits
  // "use strict" for every ESM module — so a bare assignment throws a TypeError at *module
  // scope*, i.e. during bundle evaluation. That is an uncaught boot error, which is exactly
  // the reportException -> reportFatal -> RCTFatal -> SIGABRT abort that terminated builds
  // 16, 17 and 18 ~0.3 s after launch. The typeof guard does not prevent it: the assignment
  // only runs when the global IS there — and it is always there on a real device.
  // Feature-detect writability and keep the write inside try/catch.
  const rnHandle = g.RN$handleException;
  const rnHandleIsWritable = isWritableGlobal('RN$handleException');
  if (typeof rnHandle === 'function' && rnHandleIsWritable) {
    try {
      g.RN$handleException = (error, isFatal, reportToConsole) => {
        reportCrash(toMessage(error), toStack(error));
        try {
          return rnHandle(error, isFatal, reportToConsole);
        } catch {
          return undefined;
        }
      };
    } catch {
      /* read-only after all: hook 1 (ErrorUtils) still reports what it can */
    }
  }
}

/**
 * True only when the global property can legally be assigned to. `Object.defineProperty`
 * defaults are writable:false / configurable:false, which is how RN ships every RN$* global,
 * so this is false on device and the caller must not assign.
 */
function isWritableGlobal(name: string): boolean {
  try {
    return Object.getOwnPropertyDescriptor(globalThis, name)?.writable === true;
  } catch {
    return false;
  }
}
