import { expect, test, type Page, type Route } from "@playwright/test"
import { fixture, pageMessages } from "./session-timeline.fixture"

const errorToastSelector = '[data-component="toast"][data-variant="error"]'
const emptyList = new Set(["/skill", "/command", "/lsp", "/formatter", "/permission", "/question"])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"])
const forbiddenText = ["Load details", "Show earlier steps"]

type SmokeState = {
  ids: string[]
  visibleIds: string[]
  topVisibleId?: string
  signature: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  errorToasts: string[]
  forbiddenText: string[]
}

type SmokeWindow = Window & {
  __timelineSmokeState?: () => SmokeState
  __timelineSmokeErrorToasts?: string[]
  __timelineSmokeForbiddenText?: string[]
}

test.describe("smoke: session timeline", () => {
  test.setTimeout(300_000)

  test("renders seeded timeline in order while paging through history", async ({ page }) => {
    const errors = captureErrors(page)
    await mockApi(page)
    await configureSmokePage(page)
    await page.goto("/")
    await page.getByRole("button", { name: /SmokeProject/ }).click()
    await page.locator(`a[href*="${fixture.sourceID}"]`).first().evaluate((el) => el.click())

    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
    await expect(page.getByText("smoke-project").first()).toBeVisible()
    await expect(page.getByText("Ask anything...")).toBeVisible()
    await expect(page.locator(`a[href*="${fixture.targetID}"]`).first()).toBeVisible()

    await page.locator(`a[href*="${fixture.targetID}"]`).first().evaluate((el) => el.click())
    await expect(page.getByRole("heading", { name: fixture.expected.targetTitle })).toBeVisible()
    await waitForTimelineStable(page)

    for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0)
    expectNoSmokeErrors(await timelineState(page), errors)
    await expect(page.getByText("Verify generated output").first()).toBeVisible()
    await expect(page.locator('[data-component="tool-part-wrapper"]').first()).toBeVisible()

    const expected = fixture.expected.targetPartIDs
    const samples: TraversalSample[] = []
    await pointAtTimeline(page)
    await traverseTimelineUp(page, expected, samples, errors)

    const actual = await timelineState(page)
    expectOrderedPartIDs(expected, actual.ids, "mounted")
    expectOrderedPartIDs(expected, actual.visibleIds, "visible")
    expectNoSmokeErrors(actual, errors)
    expect(new Set(expected).size).toBe(expected.length)
    expect(expected.length).toBe(331)
  })
})

function captureErrors(page: Page) {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  return errors
}

async function configureSmokePage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
          showSessionProgressBar: true,
        },
      }),
    )

    const smoke = window as SmokeWindow
    smoke.__timelineSmokeErrorToasts = []
    smoke.__timelineSmokeForbiddenText = []
    const partSelector = "[data-timeline-part-id], [data-timeline-part-ids]"
    const idsOf = (el: HTMLElement) =>
      [el.dataset.timelinePartId, ...(el.dataset.timelinePartIds?.split(",") ?? [])].filter((id): id is string => !!id)
    
    smoke.__timelineSmokeState = () => {
      const root = document.querySelector('[data-slot="session-turn-list"]')
      const scroller = root?.closest<HTMLElement>(".scroll-view__viewport")
      if (!scroller || !root) {
        return {
          ids: [],
          visibleIds: [],
          topVisibleId: undefined,
          signature: "",
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          errorToasts: smoke.__timelineSmokeErrorToasts ?? [],
          forbiddenText: smoke.__timelineSmokeForbiddenText ?? [],
        }
      }

      const ids: string[] = []
      const visibleIds: string[] = []
      const scrollerRect = scroller.getBoundingClientRect()
      let topVisibleId: string | undefined
      for (const el of root.querySelectorAll<HTMLElement>(partSelector)) {
        const next = idsOf(el)
        ids.push(...next)

        const rect = el.getBoundingClientRect()
        if (rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom) {
          if (!topVisibleId) topVisibleId = next[0]
          visibleIds.push(...next)
        }
      }

      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].map((el) => ({
        id: el.dataset.messageId,
        top: Math.round(el.getBoundingClientRect().top),
        bottom: Math.round(el.getBoundingClientRect().bottom),
      }))
      const signature = JSON.stringify({
        top: Math.round(scroller.scrollTop),
        height: Math.round(scroller.scrollHeight),
        rows,
        ids,
      })

      return {
        ids,
        visibleIds,
        topVisibleId,
        signature,
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        clientHeight: Math.round(scroller.clientHeight),
        errorToasts: smoke.__timelineSmokeErrorToasts ?? [],
        forbiddenText: smoke.__timelineSmokeForbiddenText ?? [],
      }
    }
    let recordFrame: number | undefined
    const record = () => {
      for (const toast of document.querySelectorAll<HTMLElement>('[data-component="toast"][data-variant="error"]')) {
        const text = toast.textContent?.trim()
        if (text && !smoke.__timelineSmokeErrorToasts!.includes(text)) smoke.__timelineSmokeErrorToasts!.push(text)
      }
      const text = document.body?.textContent ?? ""
      for (const value of ["Load details", "Show earlier steps"]) {
        if (text.includes(value) && !smoke.__timelineSmokeForbiddenText!.includes(value)) {
          smoke.__timelineSmokeForbiddenText!.push(value)
        }
      }
    }
    const start = () => {
      const root = document.documentElement ?? document.body
      if (!root) return
      new MutationObserver(() => {
        if (recordFrame) return
        recordFrame = requestAnimationFrame(() => {
          recordFrame = undefined
          record()
        })
      }).observe(root, { childList: true, subtree: true })
      record()
    }
    if (document.documentElement ?? document.body) start()
    else document.addEventListener("DOMContentLoaded", start, { once: true })
  })
}

function expectNoSmokeErrors(state: SmokeState, consoleErrors: string[]) {
  expect({ consoleErrors, toastErrors: state.errorToasts, forbiddenText: state.forbiddenText }).toEqual({
    consoleErrors: [],
    toastErrors: [],
    forbiddenText: [],
  })
}

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== "4096") return route.fallback()
    return handleApi(route, url)
  })
}

async function handleApi(route: Route, url: URL) {
  const path = url.pathname
  if (path === "/global/event" || path === "/event") return sse(route)
  if (emptyObject.has(path)) return json(route, {})
  if (path === "/provider") return json(route, fixture.provider)
  if (path === "/path")
    return json(route, {
      state: fixture.directory,
      config: fixture.directory,
      worktree: fixture.directory,
      directory: fixture.directory,
      home: "C:/OpenCode",
    })
  if (path === "/project" || path === "/project/current")
    return json(route, path === "/project" ? [fixture.project] : fixture.project)
  if (path === "/agent") return json(route, [{ name: "build", mode: "primary" }])
  if (emptyList.has(path)) return json(route, [])
  if (path === "/vcs") return json(route, { branch: "main", default_branch: "main" })
  if (path === "/vcs/status" || path === "/vcs/diff") return json(route, [])
  if (path === "/session") return json(route, fixture.sessions)

  const sessionMatch = path.match(/^\/session\/([^/]+)$/)
  if (sessionMatch) return json(route, fixture.sessions.find((session) => session.id === sessionMatch[1]))

  if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(path)) return json(route, [])

  const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
  if (messagesMatch) {
    const limit = Number(url.searchParams.get("limit") ?? 80)
    const before = url.searchParams.get("before") ?? undefined
    const page = pageMessages(messagesMatch[1], limit, before)
    return json(route, page.items, page.cursor ? { "x-next-cursor": page.cursor } : undefined)
  }

  return json(route, {})
}

function json(route: Route, body: unknown, headers?: Record<string, string>) {
  return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body ?? null) })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}

function timelineScroller(page: Page) {
  return page.locator(".scroll-view__viewport", { has: page.locator('[data-slot="session-turn-list"]') })
}

async function traverseTimelineUp(page: Page, expected: string[], samples: TraversalSample[], errors: string[]) {
  let unchanged = 0
  const seenMounted = new Set<string>()
  for (let attempt = 0; attempt < expected.length * 3; attempt++) {
    const current = await timelineState(page)
    for (const id of current.ids) seenMounted.add(id)
    expectNoSmokeErrors(current, errors)
    expectOrderedPartIDs(expected, current.ids, "mounted")
    expectOrderedPartIDs(expected, current.visibleIds, "visible")
    samples.push(sampleTraversal(current, seenMounted.size))
    
    // Check if we've seen everything and we're at the top
    if (isTimelineTop(current, expected) && seenMounted.size === expected.length) return current

    const scrolled = await scrollTimelineUp(page, current)
    if (scrolled.moved) {
      unchanged = 0
      continue
    }

    unchanged++
    if (unchanged >= 3) {
      throw new Error(`timeline upward traversal stalled\n${sampleSummary(samples)}`)
    }
    await pointAtTimeline(page)
  }
  throw new Error(`timeline upward traversal exceeded expected attempts\n${sampleSummary(samples)}`)
}

async function scrollTimelineUp(page: Page, before: SmokeState) {
  await page.mouse.wheel(0, -Math.max(1, Math.round(before.clientHeight / 2)))
  return {
    moved: await page.evaluate(
      (prev) =>
        new Promise<boolean>((resolve) => {
          const read = () => (window as SmokeWindow).__timelineSmokeState?.().signature ?? ""
          let frames = 0
          let stableSince: string | undefined
          let stableFrames = 0
          const check = () => {
            const current = read()
            if (current !== prev) {
              if (current === stableSince) {
                stableFrames++
                if (stableFrames >= 3) {
                  resolve(true)
                  return
                }
              } else {
                stableSince = current
                stableFrames = 1
              }
            }
            frames++
            if (frames >= 240) {
              resolve(current !== prev)
              return
            }
            requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
      before.signature,
    ),
  }
}

async function pointAtTimeline(page: Page) {
  const box = await timelineScroller(page).boundingBox()
  if (!box) throw new Error("Timeline scroller is not visible")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}




function isTimelineTop(state: SmokeState, expected: string[]) {
  return state.scrollTop <= 0 && state.ids[0] === expected[0]
}

async function timelineState(page: Page) {
  return page.evaluate(
    () =>
      (window as SmokeWindow).__timelineSmokeState?.() ?? {
        ids: [],
        visibleIds: [],
        topVisibleId: undefined,
        signature: "",
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        errorToasts: [],
        forbiddenText: [],
      },
  )
}

function expectOrderedPartIDs(expected: string[], actual: string[], label: string) {
  expect(actual.length, `${label} part ids should not be empty`).toBeGreaterThan(0)
  const actualSet = new Set(actual)
  expect(actual, `${label} part ids`).toEqual(expected.filter((id) => actualSet.has(id)))
}

type TraversalSample = ReturnType<typeof sampleTraversal>

function sampleTraversal(state: SmokeState, seen: number) {
  return {
    seen,
    mounted: state.ids.length,
    visible: state.visibleIds.length,
    top: state.scrollTop,
    height: state.scrollHeight,
    first: state.ids[0],
    last: state.ids.at(-1),
    topVisible: state.topVisibleId,
    visibleFirst: state.visibleIds[0],
    visibleLast: state.visibleIds.at(-1),
  }
}

function sampleSummary(samples: TraversalSample[]) {
  return samples
    .filter((_, index) => index % Math.max(1, Math.floor(samples.length / 8)) === 0 || index === samples.length - 1)
    .map(
      (sample, index) =>
        `${index}: seen=${sample.seen} mounted=${sample.mounted} visible=${sample.visible} top=${sample.top}/${sample.height} first=${sample.first} last=${sample.last} topVisible=${sample.topVisible} visible=${sample.visibleFirst}..${sample.visibleLast}`,
    )
    .join("\n")
}

async function waitForTimelineStable(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => {
          const a = (window as SmokeWindow).__timelineSmokeState?.().signature ?? ""
          requestAnimationFrame(() => {
            const b = (window as SmokeWindow).__timelineSmokeState?.().signature ?? ""
            requestAnimationFrame(() =>
              resolve(!!a && a === b && b === ((window as SmokeWindow).__timelineSmokeState?.().signature ?? "")),
            )
          })
        })
      }),
  )
}
