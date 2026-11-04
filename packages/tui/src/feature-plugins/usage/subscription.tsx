import { Plugin } from "@opencode/plugin/tui"
import type { UsageLimitsSubscriptionMeter } from "@opencode/client"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { useUsageLimits } from "../../component/usage"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useLocal } from "../../context/local"
import { formatReset } from "../../util/usage-limits"

type Display = "sidebar" | "footer"
type Level = "ok" | "warning" | "danger"

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

function level(meter: UsageLimitsSubscriptionMeter): Level {
  if (meter.limited || meter.percent >= 90) return "danger"
  if (meter.percent >= 75) return "warning"
  return "ok"
}

/** Shows the usage of the subscription behind the selected model, for every provider whose usage limits are read. */
export default Plugin.define({
  id: "opencode.subscription.usage",
  setup(context) {
    // A subscription's displays all reload when a response ends, so the sidebar and footer share one throttle.
    let refreshed = 0
    const refresh = () => {
      const now = Date.now()
      if (now - refreshed < 1000) return false
      refreshed = now
      return true
    }
    const color = (value: Level) =>
      value === "danger"
        ? context.theme.text.feedback.error.base
        : value === "warning"
          ? context.theme.text.feedback.warning.base
          : context.theme.text.muted

    /**
     * The subscription of the selected model's provider while its display is on. Loads once, and reloads after every
     * response, since each one spends from the subscription.
     */
    const useSubscription = (display: Display) => {
      const config = useConfig()
      const local = useLocal()
      const data = useData()
      const limits = useUsageLimits()
      const providerID = () => local.model.current()?.providerID
      const enabled = () => {
        const id = providerID()
        if (!id) return false
        const legacy: Record<string, typeof config.data.copilot_usage> = {
          "github-copilot": config.data.copilot_usage,
          openai: config.data.chatgpt_usage,
        }
        const settings = config.data.subscription_usage?.[id] ?? legacy[id]
        return (settings?.enabled ?? true) && (settings?.[display] ?? true)
      }
      createEffect(() => {
        if (enabled() && limits.info() === undefined) limits.load()
      })
      onCleanup(
        data.on("session.execution.succeeded", () => {
          if (enabled() && refresh()) limits.load(true)
        }),
      )
      return createMemo(() => {
        if (!enabled()) return
        const subscription = limits.info()?.subscriptions.find((item) => item.providerID === providerID())
        if (!subscription || subscription.meters.length === 0) return
        const levels = subscription.meters.map(level)
        return {
          subscription,
          level: levels.includes("danger") ? "danger" : levels.includes("warning") ? "warning" : ("ok" as Level),
        }
      })
    }

    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const usage = useSubscription("sidebar")
        return (
          <Show when={usage()}>
            {(value) => (
              <box>
                <text fg={context.theme.text.base}>
                  <b>{value().subscription.name}</b>
                </text>
                <For each={value().subscription.meters}>
                  {(meter) => (
                    <>
                      <text fg={color(level(meter))}>
                        {meter.label}: {Math.round(meter.percent)}% used
                        <Show when={meter.used !== undefined && meter.total !== undefined}>
                          {" "}
                          · {count.format(meter.used ?? 0)} / {count.format(meter.total ?? 0)}
                          {meter.unit ? ` ${meter.unit}` : ""}
                        </Show>
                        <Show when={meter.resetsAt}>
                          {(at) => <span style={{ fg: context.theme.text.muted }}> · resets {formatReset(at())}</span>}
                        </Show>
                      </text>
                      <Show when={meter.overage && meter.percent >= 100}>
                        <text fg={context.theme.text.feedback.warning.base}>Billing overage</text>
                      </Show>
                    </>
                  )}
                </For>
              </box>
            )}
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "prompt.footer",
      render: (props) => {
        const usage = useSubscription("footer")
        return (
          <Show when={props.mode === "normal" && usage()}>
            {(value) => (
              <text fg={color(value().level)} wrapMode="none" flexShrink={0}>
                {value().subscription.name}{" "}
                {value()
                  .subscription.meters.map((meter) => `${meter.label} ${Math.round(meter.percent)}%`)
                  .join(" · ")}
              </text>
            )}
          </Show>
        )
      },
    })
  },
})
