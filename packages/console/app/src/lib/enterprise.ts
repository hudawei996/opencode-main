import { createOpenAI } from "@ai-sdk/openai"
import { AWS } from "@opencode-ai/console-core/aws.js"
import { generateObject } from "ai"
import { z } from "zod"
import { createLead } from "./salesforce"

const links = [
  { label: "Docs", url: "https://opencode.ai/docs" },
  { label: "Discord Community", url: "https://discord.gg/scN9YX6Fdd" },
  { label: "GitHub", url: "https://github.com/anomalyco/opencode" },
]

const from = "Stefan <stefan@anoma.ly>"
const sign = "Stefan"

const shape = z.object({
  company: z.string().nullable().describe("Company name. Use null when unknown."),
  size: z
    .enum(["1-50", "51-250", "251-1000", "1001+"])
    .nullable()
    .describe("Company size bucket. Use null when unknown."),
  first: z.string().nullable().describe("First name only. Use null when unknown."),
  title: z.string().nullable().describe("Job title or role. Use null when unknown."),
  seats: z.number().int().positive().nullable().describe("Approximate seat count. Use null when unknown."),
  procurement: z
    .boolean()
    .describe("True when the inquiry is blocked on procurement, legal, vendor, security, or compliance review."),
  effort: z
    .enum(["low", "medium", "high"])
    .describe("Lead quality based on how specific and commercially relevant the inquiry is."),
  summary: z.string().nullable().describe("One sentence summary for the sales team. Use null when unnecessary."),
})

const system = [
  "You triage inbound enterprise inquiries for OpenCode.",
  "Extract the fields from the form data and message.",
  "Do not invent facts. Use null when a field is unknown.",
  "First name should only contain the given name.",
  "Seats should only be set when the inquiry mentions or strongly implies a team, user, developer, or seat count.",
  "Procurement should be true when the inquiry mentions approval, review, legal, vendor, security, or compliance processes.",
  "Effort is low for vague or generic inquiries, medium for some business context, and high for strong buying intent, rollout scope, or blockers.",
].join("\n")

export interface Inquiry {
  name: string
  role: string
  company?: string
  email: string
  phone?: string
  alias?: string
  message: string
}

export type Score = z.infer<typeof shape>

type Kind = "generic" | "procurement"
type Mail = {
  subject: string
  text: string
  html: string
}

function field(text?: string | null) {
  const value = text?.trim()
  if (!value) return null
  return value
}

function safe(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function html(text: string) {
  return safe(text).replace(/\n/g, "<br>")
}

export function fallback(input: Inquiry): Score {
  const text = [input.role, input.company, input.message].filter(Boolean).join("\n").toLowerCase()
  const procurement = /procurement|security|vendor|legal|approval|questionnaire|compliance/.test(text)
  const words = input.message.trim().split(/\s+/).filter(Boolean).length
  return {
    company: field(input.company),
    size: null,
    first: input.name.split(/\s+/)[0] ?? null,
    title: field(input.role),
    seats: null,
    procurement,
    effort: procurement ? "high" : words < 18 ? "low" : "medium",
    summary: null,
  }
}

async function grade(input: Inquiry): Promise<Score> {
  const zen = createOpenAI({
    apiKey: "public",
    baseURL: "https://opencode.ai/zen/v1",
  })

  return generateObject({
    model: zen.responses("gpt-5"),
    schema: shape,
    system,
    prompt: JSON.stringify(
      {
        name: input.name,
        role: input.role,
        company: field(input.company),
        email: input.email,
        phone: field(input.phone),
        message: input.message,
      },
      null,
      2,
    ),
  })
    .then((result) => result.object)
    .catch((err) => {
      console.error("Failed to grade enterprise inquiry:", err)
      return fallback(input)
    })
}

export function kind(score: Score): Kind | null {
  if (score.procurement) return "procurement"
  if (score.effort === "low") return "generic"
  return null
}

function refs(kind: Kind) {
  const text = links.map(
    (item) => `${item.label}: ${item.url}${kind === "procurement" && item.label === "GitHub" ? " (MIT licensed)" : ""}`,
  )
  const markup = links
    .map(
      (item) =>
        `<li><a href="${item.url}">${safe(item.label)}</a>${kind === "procurement" && item.label === "GitHub" ? " (MIT licensed)" : ""}</li>`,
    )
    .join("")
  return { text, markup }
}

export function reply(kind: Kind, name: string | null): Mail {
  const who = name ?? "there"
  const list = refs(kind)

  if (kind === "generic") {
    return {
      subject: "Thanks for reaching out to OpenCode",
      text: [
        `Hi ${who},`,
        "",
        "Thanks for reaching out, we're happy to hear from you! We've received your message and are working through it. We're a small team doing our best to get back to everyone, so thank you for bearing with us.",
        "",
        "To help while you wait, here are some great places to start:",
        ...list.text,
        "",
        "Hope you find what you need in there! Don't hesitate to reply if you have something more specific in mind.",
        "",
        "Best,",
        sign,
      ].join("\n"),
      html: [
        `<p>Hi ${safe(who)},</p>`,
        "<p>Thanks for reaching out, we're happy to hear from you! We've received your message and are working through it. We're a small team doing our best to get back to everyone, so thank you for bearing with us.</p>",
        "<p>To help while you wait, here are some great places to start:</p>",
        `<ul>${list.markup}</ul>`,
        "<p>Hope you find what you need in there! Don&#39;t hesitate to reply if you have something more specific in mind.</p>",
        `<p>Best,<br>${safe(sign)}</p>`,
      ].join(""),
    }
  }

  return {
    subject: "OpenCode security and procurement notes",
    text: [
      `Hi ${who},`,
      "",
      "Thanks for reaching out! We're a small team working through messages as fast as we can, so thanks for bearing with us.",
      "",
      "A few notes that may help while this moves through security or procurement:",
      "- OpenCode is open source and MIT licensed.",
      "- Our managed offering is SOC 1 compliant.",
      "- Our managed offering is currently in the observation period for SOC 2.",
      "",
      "If anything is held up on the procurement or legal side, just reply and I'll get you whatever you need to keep things moving.",
      "",
      "To help while you wait, here are some great places to start:",
      ...list.text,
      "",
      "Best,",
      sign,
    ].join("\n"),
    html: [
      `<p>Hi ${safe(who)},</p>`,
      "<p>Thanks for reaching out! We&#39;re a small team working through messages as fast as we can, so thanks for bearing with us.</p>",
      "<p>A few notes that may help while this moves through security or procurement:</p>",
      "<ul><li>OpenCode is open source and MIT licensed.</li><li>Our managed offering is SOC 1 compliant.</li><li>Our managed offering is currently in the observation period for SOC 2.</li></ul>",
      "<p>If anything is held up on the procurement or legal side, just reply and I&#39;ll get you whatever you need to keep things moving.</p>",
      "<p>To help while you wait, here are some great places to start:</p>",
      `<ul>${list.markup}</ul>`,
      `<p>Best,<br>${safe(sign)}</p>`,
    ].join(""),
  }
}

function rows(input: Inquiry, score: Score, kind: Kind | null) {
  return [
    { label: "Name", value: input.name },
    { label: "Email", value: input.email },
    { label: "Phone", value: field(input.phone) ?? "Unknown" },
    { label: "Auto Reply", value: kind ?? "manual" },
    { label: "Company", value: score.company ?? "Unknown" },
    { label: "Company Size", value: score.size ?? "Unknown" },
    { label: "First Name", value: score.first ?? "Unknown" },
    { label: "Title", value: score.title ?? "Unknown" },
    { label: "Seats", value: score.seats ? String(score.seats) : "Unknown" },
    { label: "Procurement", value: score.procurement ? "Yes" : "No" },
    { label: "Effort", value: score.effort },
    { label: "Summary", value: score.summary ?? "None" },
  ]
}

function report(input: Inquiry, score: Score, kind: Kind | null): Mail {
  const list = rows(input, score, kind)
  return {
    subject: `Enterprise Inquiry from ${input.name}${kind ? ` (${kind})` : ""}`,
    text: [
      "New enterprise inquiry",
      "",
      ...list.map((item) => `${item.label}: ${item.value}`),
      "",
      "Message:",
      input.message,
    ].join("\n"),
    html: [
      "<p><strong>New enterprise inquiry</strong></p>",
      ...list.map((item) => `<p><strong>${safe(item.label)}:</strong> ${html(item.value)}</p>`),
      `<p><strong>Message:</strong><br>${html(input.message)}</p>`,
    ].join(""),
  }
}

function note(input: Inquiry, score: Score, kind: Kind | null) {
  return [input.message, "", "---", ...rows(input, score, kind).map((item) => `${item.label}: ${item.value}`)].join(
    "\n",
  )
}

export async function deliver(input: Inquiry) {
  const score = await grade(input)
  const next = kind(score)
  const msg = report(input, score, next)
  const auto = next ? reply(next, score.first) : null
  const jobs = [
    {
      name: "salesforce",
      job: createLead({
        name: input.name,
        role: score.title ?? input.role,
        company: score.company ?? field(input.company) ?? undefined,
        email: input.email,
        phone: field(input.phone) ?? undefined,
        message: note(input, score, next),
      }),
    },
    {
      name: "internal",
      job: AWS.sendEmail({
        from,
        to: "contact@anoma.ly",
        subject: msg.subject,
        body: msg.text,
        html: msg.html,
        replyTo: input.email,
      }),
    },
    ...(auto
      ? [
          {
            name: "reply",
            job: AWS.sendEmail({
              from,
              to: input.email,
              subject: auto.subject,
              body: auto.text,
              html: auto.html,
            }),
          },
        ]
      : []),
  ]

  const out = await Promise.allSettled(jobs.map((item) => item.job))
  out.forEach((item, index) => {
    const name = jobs[index]!.name
    if (item.status === "rejected") {
      console.error(`Enterprise ${name} failed:`, item.reason)
      return
    }
    if (name === "salesforce" && !item.value) {
      console.error("Enterprise salesforce lead failed")
    }
  })
}
