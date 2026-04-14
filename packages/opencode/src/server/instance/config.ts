import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { AppRuntime } from "../../effect/app-runtime"
import { Effect } from "effect"
import { ConfigReload } from "../../config/reload"

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get())))
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.update(config)))
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Provider.Service
            return mapValues(yield* svc.list(), (item) => item)
          }),
        )
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .post(
      "/reload",
      describeRoute({
        summary: "Reload configuration",
        description:
          "Reload all configuration files (opencode.jsonc, .opencode/) and plugins, and restart all instances without restarting the TUI.",
        operationId: "config.reload",
        responses: {
          200: {
            description: "Configuration reloaded successfully",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    immediate: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const result = await ConfigReload.request()
        return c.json({ success: true, immediate: result.immediate })
      },
    )
    .post(
      "/bootstrap-complete",
      describeRoute({
        summary: "Signal TUI bootstrap complete",
        description:
          "Called by the TUI after its non-blocking bootstrap phase finishes. " +
          "Releases the tui-bootstrap blocker so any pending reload can proceed.",
        operationId: "config.bootstrapComplete",
        responses: {
          200: {
            description: "Blocker released",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const rawCycle = c.req.query("cycle")
        if (rawCycle != null) {
          const cycle = Number(rawCycle)
          const current = ConfigReload.getBootstrapCycle()
          if (cycle !== current) {
            // Stale POST from a previous bootstrap cycle. Ignore it.
            return c.json({ success: false })
          }
        }
        ConfigReload.finishBlocker("tui-bootstrap")
        return c.json({ success: true })
      },
    )
)
