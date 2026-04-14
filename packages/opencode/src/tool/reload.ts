import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { ConfigReload } from "@/config/reload"

export const ReloadTool = Tool.define(
  "reload_config",
  Effect.succeed({
    description: "Reload OpenCode configuration files and plugins without restarting.",
    parameters: z.object({}),
    execute: (_params: {}, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "reload_config",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        yield* Effect.promise(() => ConfigReload.request({ resumeSessionID: ctx.sessionID }))

        return {
          title: "Configuration reload enqueued",
          output: "Reload enqueued. The session will stop now and resume automatically after reload.",
          metadata: {},
          stopSession: true,
        }
      }),
  }),
)
