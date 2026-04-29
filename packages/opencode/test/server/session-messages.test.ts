import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { linkParam, parseLinkHeader } from "../../src/util/link-header"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionIDType) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

const password = process.env.OPENCODE_SERVER_PASSWORD
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const auth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : undefined
const requestContext: { directory?: string } = {}

const request = (app: ReturnType<typeof Server.Default>, url: string) => {
  const headers: Record<string, string> = {}
  if (auth) headers.Authorization = auth
  if (requestContext.directory) headers["x-opencode-directory"] = requestContext.directory
  if (Object.keys(headers).length === 0) return app.app.request(url)
  return app.app.request(url, { headers })
}

const requestPost = (app: ReturnType<typeof Server.Default>, url: string, body: Record<string, unknown>) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) headers.Authorization = auth
  if (requestContext.directory) headers["x-opencode-directory"] = requestContext.directory
  return app.app.request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

const TEST_TIMEOUT_MS = 120_000

async function withTmp(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  const previous = requestContext.directory
  requestContext.directory = tmp.path
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn,
    })
  } finally {
    requestContext.directory = previous
    await disposeAllInstances()
  }
}

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function fill(sessionID: SessionIDType, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      tools: {},
    } satisfies MessageV2.User)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

describe("session messages endpoint", () => {
  test(
    "returns Link header with rel=prev for older pages",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await withoutWatcher(() =>
        WithInstance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await svc.create({})
            const ids = await fill(session.id, 5)
            const app = Server.Default().app

            const a = await app.request(`/session/${session.id}/message?limit=2`)
            expect(a.status).toBe(200)
            const aBody = (await a.json()) as MessageV2.WithParts[]
            expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
            const links = parseLinkHeader(a.headers.get("link") ?? "")
            expect(links.prev).toBeDefined()
            const before = linkParam(links.prev, "before")
            expect(before).toBeTruthy()

            const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(before!)}`)
            expect(b.status).toBe(200)
            const bBody = (await b.json()) as MessageV2.WithParts[]
            expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

            await svc.remove(session.id)
          },
        }),
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "keeps full-history responses when limit is omitted",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await withoutWatcher(() =>
        WithInstance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await svc.create({})
            const ids = await fill(session.id, 3)
            const app = Server.Default().app

            const res = await app.request(`/session/${session.id}/message`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as MessageV2.WithParts[]
            expect(body.map((item) => item.info.id)).toEqual(ids)

            const explicitFalse = await app.request(`/session/${session.id}/message?oldest=false`)
            expect(explicitFalse.status).toBe(200)
            const explicitFalseBody = (await explicitFalse.json()) as MessageV2.WithParts[]
            expect(explicitFalseBody.map((item) => item.info.id)).toEqual(ids)

            await svc.remove(session.id)
          },
        }),
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "rejects invalid cursors and missing sessions",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await withoutWatcher(() =>
        WithInstance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await svc.create({})
            const app = Server.Default().app

            const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
            expect(bad.status).toBe(400)

            const miss = await app.request(`/session/ses_missing/message?limit=2`)
            expect(miss.status).toBe(404)

            await svc.remove(session.id)
          },
        }),
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "does not truncate large legacy limit requests",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await withoutWatcher(() =>
        WithInstance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await svc.create({})
            await fill(session.id, 520)
            const app = Server.Default().app

            const res = await app.request(`/session/${session.id}/message?limit=510`)
            expect(res.status).toBe(200)
            const body = (await res.json()) as MessageV2.WithParts[]
            expect(body).toHaveLength(510)

            await svc.remove(session.id)
          },
        }),
      )
    },
    TEST_TIMEOUT_MS,
  )
})

describe("session.messages API", () => {
  test(
    "returns 400 when both before and after specified",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        await fill(session.id, 3)
        const first = await request(app, `/session/${session.id}/message?limit=1`)
        const cur = linkParam(parseLinkHeader(first.headers.get("Link") ?? "").prev, "before")

        const response = await request(app, `/session/${session.id}/message?before=${cur}&after=${cur}&limit=2`)

        expect(response.status).toBe(400)
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "includes Link header with rel=prev when more pages exist (latest page)",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        await fill(session.id, 5)

        const response = await request(app, `/session/${session.id}/message?limit=2`)

        expect(response.status).toBe(200)
        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(linkParam(links.prev, "before")).toBeTruthy()
        expect(links.next).toBeUndefined()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "strips query auth credentials from pagination Link headers",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        await fill(session.id, 3)

        const response = await request(app, `/session/${session.id}/message?limit=1&auth_token=secret-token`)

        expect(response.status).toBe(200)
        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(linkParam(links.prev, "auth_token")).toBeUndefined()
        expect(links.prev).not.toContain("secret-token")
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "before cursor returns older page and exposes rel=next",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const latest = await request(app, `/session/${session.id}/message?limit=2`)
        const latestLinks = parseLinkHeader(latest.headers.get("Link") ?? "")
        const before = linkParam(latestLinks.prev, "before")

        const response = await request(app, `/session/${session.id}/message?before=${before}&limit=2`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as Array<{ info: { id: string } }>
        expect(body.map((item) => item.info.id)).toEqual([ids[1], ids[2]])

        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(links.next).toBeDefined()
        expect(linkParam(links.prev, "before")).toBeTruthy()
        expect(linkParam(links.next, "after")).toBeTruthy()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "oldest=true returns messages in ascending order with rel=next Link",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const response = await request(app, `/session/${session.id}/message?oldest=true&limit=2`)

        expect(response.status).toBe(200)
        const messages = (await response.json()) as Array<{ info: { id: string } }>
        expect(messages.map((item) => item.info.id)).toEqual([ids[0], ids[1]])

        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.next).toBeDefined()
        expect(linkParam(links.next, "after")).toBeTruthy()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "after cursor returns newer page and exposes rel=prev",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const oldest = await request(app, `/session/${session.id}/message?oldest=true&limit=2`)
        const oldestLinks = parseLinkHeader(oldest.headers.get("Link") ?? "")
        const after = linkParam(oldestLinks.next, "after")

        const response = await request(app, `/session/${session.id}/message?after=${after}&limit=2`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as Array<{ info: { id: string } }>
        expect(body.map((item) => item.info.id)).toEqual([ids[2], ids[3]])

        const links = parseLinkHeader(response.headers.get("Link") ?? "")
        expect(links.prev).toBeDefined()
        expect(links.next).toBeDefined()
        expect(linkParam(links.prev, "before")).toBeTruthy()
        expect(linkParam(links.next, "after")).toBeTruthy()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "returns 400 for invalid cursor",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})

        const response = await request(app, `/session/${session.id}/message?before=invalid&limit=2`)
        expect(response.status).toBe(400)
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "single message responses include server-generated cursor",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        const [messageID] = await fill(session.id, 1)

        const response = await request(app, `/session/${session.id}/message/${messageID}`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as MessageV2.WithParts
        expect(body.cursor).toBeTruthy()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "returns 400 when oldest used with before or after",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        await fill(session.id, 3)
        const first = await request(app, `/session/${session.id}/message?limit=1`)
        const cur = linkParam(parseLinkHeader(first.headers.get("Link") ?? "").prev, "before")

        const response1 = await request(app, `/session/${session.id}/message?oldest=true&before=${cur}&limit=2`)
        expect(response1.status).toBe(400)
        const response2 = await request(app, `/session/${session.id}/message?oldest=true&after=${cur}&limit=2`)
        expect(response2.status).toBe(400)
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "limit=0 returns empty results",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        await fill(session.id, 3)

        const response = await request(app, `/session/${session.id}/message?limit=0`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([])
        expect(response.headers.get("Link")).toBeNull()
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "limit=0 still validates session existence",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const response = await request(app, `/session/${SessionID.descending()}/message?limit=0`)
        expect(response.status).toBe(404)
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "revert preview returns all reverted user messages and next restore boundary",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const revert = await requestPost(app, `/session/${session.id}/revert`, { messageID: ids[1] })
        expect(revert.status).toBe(200)

        const preview = await request(app, `/session/${session.id}/revert`)
        expect(preview.status).toBe(200)
        const body = (await preview.json()) as {
          userCount: number
          nextMessageID?: string
          items: { id: string; text: string }[]
        }

        expect(body.userCount).toBe(4)
        expect(body.nextMessageID).toBe(ids[2])
        expect(body.items).toEqual([
          { id: ids[1], text: "m1" },
          { id: ids[2], text: "m2" },
          { id: ids[3], text: "m3" },
          { id: ids[4], text: "m4" },
        ])
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "revert preview disables stepwise redo for part-level reverts",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        const [userID] = await fill(session.id, 1)
        const assistantID = MessageID.ascending()
        await svc.updateMessage({
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          time: { created: Date.now() + 10 },
          parentID: userID,
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies MessageV2.Assistant)
        const firstPartID = PartID.ascending()
        const secondPartID = PartID.ascending()
        await svc.updatePart({
          id: firstPartID,
          sessionID: session.id,
          messageID: assistantID,
          type: "text",
          text: "first",
        } satisfies MessageV2.TextPart)
        await svc.updatePart({
          id: secondPartID,
          sessionID: session.id,
          messageID: assistantID,
          type: "text",
          text: "second",
        } satisfies MessageV2.TextPart)

        const revert = await requestPost(app, `/session/${session.id}/revert`, {
          messageID: assistantID,
          partID: secondPartID,
        })
        expect(revert.status).toBe(200)

        const preview = await request(app, `/session/${session.id}/revert`)
        expect(preview.status).toBe(200)
        const body = (await preview.json()) as {
          userCount: number
          nextMessageID?: string
          partID?: string
          items: { id: string; text: string }[]
        }

        expect(body.userCount).toBe(0)
        expect(body.partID).toBe(secondPartID)
        expect(body.nextMessageID).toBeUndefined()
        expect(body.items).toEqual([{ id: assistantID, text: "first\n\nsecond" }])
      })
    },
    TEST_TIMEOUT_MS,
  )
})
