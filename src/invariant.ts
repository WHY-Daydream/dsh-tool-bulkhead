/**
 * Package-owned invariant companion for `@why-daydream/dsh-tool-bulkhead`.
 * @module @why-daydream/dsh-tool-bulkhead/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@why-daydream/dsh-tool-bulkhead'

/** Cordis companion plugin name. */
export const name = 'tool-bulkhead-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant yet: the domain scheduler's capacity contract
 * (`inFlight ≤ maxConcurrent`, FIFO head handoff) is the invariant surface; a
 * future invariant may verify that released slots always wake the queue head
 * and that no domain ever exceeds its configured concurrency.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
