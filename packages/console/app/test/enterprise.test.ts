import { describe, expect, test } from "bun:test"
import { fallback, kind, reply, type Score } from "../src/lib/enterprise"

describe("enterprise lead routing", () => {
  test("routes procurement blockers to procurement reply", () => {
    const score = fallback({
      name: "Jane Doe",
      role: "CTO",
      company: "Acme",
      email: "jane@acme.com",
      message: "We're stuck in procurement, security review, and vendor approval through Coupa.",
    })

    expect(score.procurement).toBe(true)
    expect(kind(score)).toBe("procurement")
  })

  test("routes vague inquiries to the generic reply", () => {
    const score = fallback({
      name: "Jane Doe",
      role: "Engineer",
      email: "jane@example.com",
      message: "Can you tell me more about enterprise pricing?",
    })

    expect(score.effort).toBe("low")
    expect(kind(score)).toBe("generic")
  })

  test("keeps high intent leads for manual follow-up", () => {
    const score: Score = {
      company: "Acme",
      size: "1001+",
      first: "Jane",
      title: "CTO",
      seats: 500,
      procurement: false,
      effort: "high",
      summary: "Large rollout with clear buying intent.",
    }

    expect(kind(score)).toBeNull()
  })

  test("renders the procurement reply with security notes", () => {
    const mail = reply("procurement", "Jane")

    expect(mail.subject).toContain("security")
    expect(mail.text).toContain("SOC 1 compliant")
    expect(mail.text).toContain("MIT licensed")
    expect(mail.html).toContain("Stefan")
  })
})
