import { describe, test, expect } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

const projectRoot = path.join(__dirname, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const MB = 1024 * 1024
const ITERATIONS = 50

const getHeapMB = () => {
  Bun.gc(true)
  Bun.sleepSync(25)
  return process.memoryUsage().heapUsed / MB
}

describe("memory: abort controller leak", () => {
  test("webfetch clears abort timers over many invocations", async () => {
    type TimerID = number

    const prevFetch = globalThis.fetch
    const prevSetTimeout = globalThis.setTimeout
    const prevClearTimeout = globalThis.clearTimeout
    const active = new Set<TimerID>()

    globalThis.fetch = (async () =>
      new Response("hello from webfetch", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })) as unknown as typeof fetch
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const id = prevSetTimeout(handler, timeout, ...args) as unknown as TimerID
      active.add(id)
      return id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
      if (id !== undefined) active.delete(id as unknown as TimerID)
      return prevClearTimeout(id)
    }) as unknown as typeof clearTimeout

    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tool = await WebFetchTool.init()

          await tool.execute({ url: "https://example.com", format: "text" }, ctx).catch(() => {})

          for (let i = 0; i < ITERATIONS; i++) {
            await tool.execute({ url: "https://example.com", format: "text" }, ctx).catch(() => {})
          }

          expect(active.size).toBe(0)
        },
      })
    } finally {
      globalThis.fetch = prevFetch
      globalThis.setTimeout = prevSetTimeout
      globalThis.clearTimeout = prevClearTimeout
    }
  }, 60000)

  test("compare closure vs bind pattern directly", async () => {
    const ITERATIONS = 500

    // Test OLD pattern: arrow function closure
    // Store closures in a map keyed by content to force retention
    const closureMap = new Map<string, () => void>()
    const timers: Timer[] = []
    const controllers: AbortController[] = []

    Bun.gc(true)
    Bun.sleepSync(100)
    const baseline = getHeapMB()

    for (let i = 0; i < ITERATIONS; i++) {
      // Simulate large response body like webfetch would have
      const content = `${i}:${"x".repeat(50 * 1024)}` // 50KB unique per iteration
      const controller = new AbortController()
      controllers.push(controller)

      // OLD pattern - closure captures `content`
      const handler = () => {
        // Actually use content so it can't be optimized away
        if (content.length > 1000000000) controller.abort()
      }
      closureMap.set(content, handler)
      const timeoutId = setTimeout(handler, 30000)
      timers.push(timeoutId)
    }

    Bun.gc(true)
    Bun.sleepSync(100)
    const after = getHeapMB()
    const oldGrowth = after - baseline

    console.log(`OLD pattern (closure): ${oldGrowth.toFixed(2)} MB growth (${closureMap.size} closures)`)

    // Cleanup after measuring
    timers.forEach(clearTimeout)
    controllers.forEach((c) => c.abort())
    closureMap.clear()

    // Test NEW pattern: bind
    Bun.gc(true)
    Bun.sleepSync(100)
    const baseline2 = getHeapMB()
    const handlers2: (() => void)[] = []
    const timers2: Timer[] = []
    const controllers2: AbortController[] = []

    for (let i = 0; i < ITERATIONS; i++) {
      const _content = `${i}:${"x".repeat(50 * 1024)}` // 50KB - won't be captured
      const controller = new AbortController()
      controllers2.push(controller)

      // NEW pattern - bind doesn't capture surrounding scope
      const handler = controller.abort.bind(controller)
      handlers2.push(handler)
      const timeoutId = setTimeout(handler, 30000)
      timers2.push(timeoutId)
    }

    Bun.gc(true)
    Bun.sleepSync(100)
    const after2 = getHeapMB()
    const newGrowth = after2 - baseline2

    // Cleanup after measuring
    timers2.forEach(clearTimeout)
    controllers2.forEach((c) => c.abort())
    handlers2.length = 0

    console.log(`NEW pattern (bind): ${newGrowth.toFixed(2)} MB growth`)
    console.log(`Improvement: ${(oldGrowth - newGrowth).toFixed(2)} MB saved`)

    expect(newGrowth).toBeLessThanOrEqual(oldGrowth)
  })
})
