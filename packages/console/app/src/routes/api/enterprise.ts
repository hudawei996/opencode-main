import type { APIEvent } from "@solidjs/start/server"
import { waitUntil } from "@opencode-ai/console-resource"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { deliver, type Inquiry } from "~/lib/enterprise"

export async function POST(event: APIEvent) {
  const dict = i18n(localeFromRequest(event.request))
  try {
    const body = (await event.request.json()) as Inquiry
    const trap = typeof body.alias === "string" ? body.alias.trim() : ""

    if (trap) {
      return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
    }

    if (!body.name || !body.role || !body.email || !body.message) {
      return Response.json({ error: dict["enterprise.form.error.allFieldsRequired"] }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return Response.json({ error: dict["enterprise.form.error.invalidEmailFormat"] }, { status: 400 })
    }

    const job = deliver(body).catch((error) => {
      console.error("Error processing enterprise form:", error)
    })
    void waitUntil(job)

    return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
  } catch (error) {
    console.error("Error reading enterprise form:", error)
    return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
  }
}
