import { Plugin } from "@opencode/plugin/tui"
import type { UsageLimitsCopilot, UsageLimitsCopilotQuota } from "@opencode/client"
import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { useUsageLimits } from "../../component/usage"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useLocal } from "../../context/local"
import { formatReset } from "../../util/usage-limits"

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

/** The quota that runs out: premium requests, or AI credits under token-based billing. */
function premium(copilot: UsageLimitsCopilot) {
  return (
    copilot.quotas.find((quota) => quota.id === "premium_interactions" && !quota.unlimited) ??
    copilot.quotas.find((quota) => !quota.unlimited)
  )
}

function level(quota: UsageLimitsCopilotQuota) {
  if (quota.percentRemaining <= 10) return "danger"
  if (quota.percentRemaining <= 25) return "warning"
  return "ok"
}

/**
 * The Copilot usage of the selected model's subscription, while a GitHub Copilot model is selected and the display is
 * on. Loads once, and reloads after every response a Copilot model gives, since each one spends credits.
 */
function useCopilotUsage(where: "sidebar" | "footer", refresh: () => boolean) {
  const config = useConfig()
  const local = useLocal()
  const data = useData()
  const limits = useUsageLimits()
  const selected = () => local.model.current()?.providerID === "github-copilot"
  const enabled = () => {
    const settings = config.data.copilot_usage
    return (settings?.enabled ?? true) && (settings?.[where] ?? true)
  }
  createEffect(() => {
    if (enabled() && selected() && limits.info() === undefined) limits.load()
  })
  onCleanup(
    data.on("session.execution.succeeded", () => {
      // Both displays listen; `refresh` lets only one reload per response.
      if (enabled() && selected() && refresh()) limits.load(true)
    }),
  )
  return createMemo(() => {
    if (!enabled() || !selected()) return
    const copilot = limits.info()?.copilot
    const quota = copilot && premium(copilot)
    if (!copilot || !quota) return
    return {
      copilot,
      quota,
      used: Math.max(0, quota.entitlement - quota.remaining),
      unit: copilot.tokenBased ? "AI credits" : "premium requests",
      level: level(quota),
    }
  })
}

export default Plugin.define({
  id: "opencode.copilot.usage",
  setup(context) {
    // Responses end on both displays at once; reload at most once a second.
    let last = 0
    const refresh = () => {
      const now = Date.now()
      if (now - last < 1000) return false
      last = now
      return true
    }
    const color = (value: string) =>
      value === "danger"
        ? context.theme.text.feedback.error.base
        : value === "warning"
          ? context.theme.text.feedback.warning.base
          : context.theme.text.muted

    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const usage = useCopilotUsage("sidebar", refresh)
        return (
          <Show when={usage()}>
            {(value) => (
              <box>
                <text fg={context.theme.text.base}>
                  <b>GitHub Copilot</b>
                </text>
                <text fg={color(value().level)}>
                  {count.format(value().used)} / {count.format(value().quota.entitlement)} {value().unit}
                </text>
                <text fg={context.theme.text.muted}>
                  {Math.round(100 - value().quota.percentRemaining)}% used · {count.format(value().quota.remaining)} left
                </text>
                <Show when={value().copilot.resetsAt}>
                  {(at) => <text fg={context.theme.text.muted}>Resets {formatReset(at())}</text>}
                </Show>
                <Show when={value().quota.overagePermitted && value().quota.remaining <= 0}>
                  <text fg={context.theme.text.feedback.warning.base}>Billing overage</text>
                </Show>
              </box>
            )}
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "prompt.footer",
      render: (props) => {
        const usage = useCopilotUsage("footer", refresh)
        return (
          <Show when={props.mode === "normal" && usage()}>
            {(value) => (
              <text fg={color(value().level)} wrapMode="none" flexShrink={0}>
                Copilot {Math.round(100 - value().quota.percentRemaining)}% · {count.format(value().quota.remaining)}{" "}
                left
              </text>
            )}
          </Show>
        )
      },
    })
  },
})
