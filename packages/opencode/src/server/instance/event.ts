import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "../../util/queue"

const log = Log.create({ service: "server" })

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>()
        let closed = false

        q.push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        let busUnsub: (() => void) | undefined
        // After a reload the instance-scoped Bus is destroyed and recreated.
        // Re-subscribing to it is racy (old PubSub finalizers are async).
        // Once we switch to GlobalBus-only mode we stay there permanently:
        // every Bus.publish also emits to GlobalBus (bus/index.ts:95), so
        // no events are lost. GlobalBus survives across instance lifecycles.
        let global = false

        const stop = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          busUnsub?.()
          GlobalBus.off("event", onGlobal)
          q.push(null)
          log.info("event disconnected")
        }

        // Initial subscription to the instance-scoped Bus.
        busUnsub = Bus.subscribeAll((event) => {
          q.push(JSON.stringify(event))
          if (event.type === "config.reload.executing") {
            // Switch to GlobalBus-only mode. The old Bus subscription will
            // die when Config.invalidate disposes the instance. GlobalBus
            // receives config.reload.done and all subsequent events.
            busUnsub?.()
            busUnsub = undefined
            global = true
          }
          if (event.type === Bus.InstanceDisposed.type && !global) {
            stop()
          }
        })

        // GlobalBus listener handles two responsibilities:
        // 1. During/after reload: delivers config.reload.done + server.connected
        // 2. In global mode: forwards all events from the new instance's Bus
        function onGlobal(e: { payload: any }) {
          if (closed) return
          const payload = e.payload
          if (!payload?.type) return

          if (payload.type === "config.reload.done") {
            q.push(JSON.stringify(payload))
            q.push(
              JSON.stringify({
                type: "server.connected",
                properties: {},
              }),
            )
            return
          }

          // In global mode, forward all Bus events (they arrive here via
          // bus/index.ts:95 as { directory, payload }). Skip heartbeats
          // and other non-payload events.
          if (global) {
            q.push(JSON.stringify(payload))
            // Instance disposed outside of reload = shutdown
            if (payload.type === Bus.InstanceDisposed.type) {
              stop()
            }
          }
        }
        GlobalBus.on("event", onGlobal)

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
