import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Session } from "../../src/session"
import { ConfigReload } from "../../src/config/reload"
import { ProviderID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("config.reload", () => {
  test("reloads configuration successfully", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { app } = Server.Default()

        const response = await app.request("/config/reload", {
          method: "POST",
        })
        expect(response.status).toBe(200)

        const body = (await response.json()) as { success: boolean }
        expect(body.success).toBe(true)
      },
    })
  })

  test("reload endpoint exists", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { app } = Server.Default()

        const response = await app.request("/config/reload", {
          method: "POST",
        })

        expect(response.status).not.toBe(404)
      },
    })
  })

  test("reload does not fail when no active sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        // Session starts idle
        const status = await AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.get(session.id)))
        expect(status?.type).toBe("idle")

        const { app } = Server.Default()
        const response = await app.request("/config/reload", {
          method: "POST",
        })
        expect(response.status).toBe(200)

        await Session.remove(session.id)
      },
    })
  })
})

describe("ConfigReload", () => {
  test("request returns immediate when no busy sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        ConfigReload.finishBlocker("tui-bootstrap")
        const result = await ConfigReload.request()
        expect(typeof result.immediate).toBe("boolean")
      },
    })
  })
})

describe("SessionPrompt.cancel", () => {
  test("cancel on idle session completes without error", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.cancel(session.id)
        const status = await AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.get(session.id)))
        expect(status.type).toBe("idle")
      },
    })
  })
})

describe("MessageV2.fromError abort handling", () => {
  test("string error creates AbortedError with reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    const error = MessageV2.fromError(MessageV2.ABORT_REASON.CONFIG_RELOAD, { providerID: "test" as ProviderID })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { reason?: string }).reason).toBe(MessageV2.ABORT_REASON.CONFIG_RELOAD)
    expect((error.data as { message: string }).message).toBe("The operation was aborted")
  })

  test("DOMException AbortError with reason creates AbortedError with reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    const domException = new DOMException("The operation was aborted", "AbortError")
    const error = MessageV2.fromError(domException, {
      providerID: "test" as ProviderID,
      reason: MessageV2.ABORT_REASON.CONFIG_RELOAD,
    })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { message: string }).message).toBe("The operation was aborted")
    expect((error.data as { reason?: string }).reason).toBe(MessageV2.ABORT_REASON.CONFIG_RELOAD)
  })

  test("DOMException AbortError without reason has undefined reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    const domException = new DOMException("The operation was aborted", "AbortError")
    const error = MessageV2.fromError(domException, { providerID: "test" as ProviderID })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { reason?: string }).reason).toBeUndefined()
  })

  test("user abort without reason has undefined reason", async () => {
    const { MessageV2 } = await import("../../src/session/message-v2")

    const domException = new DOMException("The operation was aborted", "AbortError")
    const error = MessageV2.fromError(domException, {
      providerID: "test" as ProviderID,
    })

    expect(error.name).toBe("MessageAbortedError")
    expect((error.data as { reason?: string }).reason).toBeUndefined()
  })
})
