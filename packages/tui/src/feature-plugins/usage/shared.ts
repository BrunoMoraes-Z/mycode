import { createEffect, onCleanup } from "solid-js"
import { useUsageLimits } from "../../component/usage"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useLocal } from "../../context/local"

export type Display = "sidebar" | "footer"
export type Level = "ok" | "warning" | "danger"

/**
 * Reloads limits at most once a second. A subscription's displays all reload when a response ends, so one plugin's
 * sidebar and footer share one of these.
 */
export function throttle() {
  let last = 0
  return () => {
    const now = Date.now()
    if (now - last < 1000) return false
    last = now
    return true
  }
}

/**
 * The usage limits for one subscription display, while a model of `providerID` is selected and the display is on.
 * Loads once, and reloads after every response, since each one spends from the subscription.
 */
export function useSubscriptionLimits(input: {
  setting: "copilot_usage" | "chatgpt_usage"
  providerID: string
  display: Display
  refresh: () => boolean
}) {
  const config = useConfig()
  const local = useLocal()
  const data = useData()
  const limits = useUsageLimits()
  const selected = () => local.model.current()?.providerID === input.providerID
  const enabled = () => {
    const settings = config.data[input.setting]
    return (settings?.enabled ?? true) && (settings?.[input.display] ?? true)
  }
  createEffect(() => {
    if (enabled() && selected() && limits.info() === undefined) limits.load()
  })
  onCleanup(
    data.on("session.execution.succeeded", () => {
      if (enabled() && selected() && input.refresh()) limits.load(true)
    }),
  )
  return () => (enabled() && selected() ? limits.info() : undefined)
}
