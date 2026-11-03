import { Plugin } from "@opencode/plugin/tui"
import type { UsageLimitsCopilot, UsageLimitsCopilotQuota } from "@opencode/client"
import { createMemo, Show } from "solid-js"
import { formatReset } from "../../util/usage-limits"
import { throttle, useSubscriptionLimits, type Display, type Level } from "./shared"

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

/** The quota that runs out: premium requests, or AI credits under token-based billing. */
function premium(copilot: UsageLimitsCopilot) {
  return (
    copilot.quotas.find((quota) => quota.id === "premium_interactions" && !quota.unlimited) ??
    copilot.quotas.find((quota) => !quota.unlimited)
  )
}

function level(quota: UsageLimitsCopilotQuota): Level {
  if (quota.percentRemaining <= 10) return "danger"
  if (quota.percentRemaining <= 25) return "warning"
  return "ok"
}

export default Plugin.define({
  id: "opencode.copilot.usage",
  setup(context) {
    const refresh = throttle()
    const color = (value: Level) =>
      value === "danger"
        ? context.theme.text.feedback.error.base
        : value === "warning"
          ? context.theme.text.feedback.warning.base
          : context.theme.text.muted
    const useCopilotUsage = (display: Display) => {
      const info = useSubscriptionLimits({ setting: "copilot_usage", providerID: "github-copilot", display, refresh })
      return createMemo(() => {
        const copilot = info()?.copilot
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

    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const usage = useCopilotUsage("sidebar")
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
        const usage = useCopilotUsage("footer")
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
