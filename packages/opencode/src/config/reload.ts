import { Config } from "./config"
import { Event as ServerEvent } from "../server/event"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"
import { AppRuntime } from "@/effect/app-runtime"
import z from "zod"

export namespace ConfigReload {
  const log = Log.create({ service: "config.reload" })

  export const Event = {
    Pending: BusEvent.define(
      "config.reload.pending",
      z.object({
        pending: z.boolean(),
      }),
    ),
    Executing: BusEvent.define(
      "config.reload.executing",
      z.object({
        executing: z.boolean(),
        bootstrapCycle: z.number().optional(),
      }),
    ),
    Done: BusEvent.define(
      "config.reload.done",
      z.object({
        resumeSessionID: z.string().optional(),
      }),
    ),
  }

  let pending = false
  let resumeSessionID: string | undefined
  /** Set during execute(), cleared when finishBlocker emits the Done event. */
  let reloadInFlight = false
  let doneResumeSessionID: string | undefined
  const active = new Set<string>()
  const blockers = new Set<string>()
  /** Incremented each time startBlocker("tui-bootstrap") is called. Used to
   *  reject stale bootstrap-complete POSTs from a previous cycle's sync.tsx. */
  let bootstrapCycle = 0

  function done(resumeSessionID: string | undefined) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Event.Done.type,
        properties: { resumeSessionID },
      },
    })
  }

  function isBlocked() {
    return active.size > 0 || blockers.size > 0
  }

  export function isPending() {
    return pending
  }

  export function start(sessionID: string) {
    active.add(sessionID)
    log.debug("start", { sessionID })
  }

  export function finish(sessionID: string) {
    active.delete(sessionID)
    log.debug("finish", { sessionID })

    // If a reload completed and we were the last active session, emit Done.
    if (reloadInFlight && !isBlocked()) {
      reloadInFlight = false
      const sid = doneResumeSessionID
      doneResumeSessionID = undefined
      log.info("reload done, last session finished", { resumeSessionID: sid })
      done(sid)
    }
  }

  export function startBlocker(blockerID: string) {
    blockers.add(blockerID)
    if (blockerID === "tui-bootstrap") bootstrapCycle++
    log.debug("startBlocker", { blockerID, bootstrapCycle })
  }

  export function getBootstrapCycle() {
    return bootstrapCycle
  }

  export function finishBlocker(blockerID: string) {
    blockers.delete(blockerID)
    log.debug("finishBlocker", { blockerID })

    // If a reload just completed and the new instance is now ready,
    // emit the Done event so the TUI hides the "Reloading..." modal.
    if (reloadInFlight && !isBlocked()) {
      reloadInFlight = false
      const sid = doneResumeSessionID
      doneResumeSessionID = undefined
      log.info("reload done, bootstrap complete", { resumeSessionID: sid })
      done(sid)
    }

    if (!pending || isBlocked()) return
    queueMicrotask(() => {
      void check().catch((error) => {
        log.error("deferred blocker check failed", { error, blockerID })
      })
    })
  }

  /**
   * Request a config reload. If all sessions are idle, reloads immediately.
   * Otherwise queues the reload to fire when the last session goes idle.
   *
   * @param options.resumeSessionID - If set, the TUI will auto-resume this
   *   session after reload completes. Only the ReloadTool should set this.
   */
  export async function request(options?: { resumeSessionID?: string }): Promise<{ immediate: boolean }> {
    // Only set resumeSessionID if explicitly provided (i.e. from ReloadTool).
    // Slash command / command palette calls without it, ensuring no auto-resume.
    if (options?.resumeSessionID) {
      resumeSessionID = options.resumeSessionID
    }
    if (!isBlocked()) {
      log.info("reload executing immediately")
      await execute()
      return { immediate: true }
    }
    pending = true
    log.info("reload queued", { resumeSessionID })
    await Bus.publish(Event.Pending, { pending: true })
    return { immediate: false }
  }

  /**
   * Called from Runner.onIdle - checks if a deferred reload is pending
   * and all sessions are now idle. If so, fires the reload.
   */
  export async function check() {
    if (!pending) return
    if (isBlocked()) {
      log.debug("check: still blocked", {
        active: [...active],
        blockers: [...blockers],
      })
      return
    }
    log.info("executing deferred reload")
    await execute()
  }

  async function execute() {
    pending = false
    const sid = resumeSessionID
    resumeSessionID = undefined
    // Clear all tracked sessions and blockers. The old instance is about to be
    // destroyed so every session/blocker tied to it is dead. The new instance
    // cycle will re-register its own via start()/startBlocker().
    active.clear()
    blockers.clear()
    startBlocker("tui-bootstrap")
    // Mark reload in-flight so finishBlocker knows to emit Done when the
    // new instance finishes bootstrapping (not immediately after disposal).
    reloadInFlight = true
    doneResumeSessionID = sid
    await Bus.publish(Event.Pending, { pending: false })
    await Bus.publish(Event.Executing, { executing: true, bootstrapCycle })
    // Config.invalidate(true) destroys the old instance scope. When called
    // from an Effect fiber (e.g. Runner.onIdle), the scope teardown kills
    // the fiber, so code after `await Config.invalidate()` never runs.
    //
    // Listen for ServerEvent.Disposed ("global.disposed") on GlobalBus
    // (emitted in Config.invalidate's .finally() block) to clean up.
    // The actual Done event is deferred until finishBlocker("tui-bootstrap")
    // fires, so the TUI modal stays visible until the new instance is ready.
    const onDisposed = (e: any) => {
      if (e.payload?.type !== ServerEvent.Disposed.type) return
      GlobalBus.removeListener("event", onDisposed)
      log.debug("instance disposed")
    }
    GlobalBus.on("event", onDisposed)
    log.info("invalidating config", { resumeSessionID: sid })

    // Fire and don't rely on awaiting (the fiber may die).
    AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate(true))).catch((error) => {
      log.error("invalidate failed", { error })
    })
  }
}
