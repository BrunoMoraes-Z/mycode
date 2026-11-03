import { Plugin } from "@opencode/plugin/tui"
import type { UsageLimitsChatGPTWindow } from "@opencode/client"
import { createMemo, For, Show } from "solid-js"
import { formatReset } from "../../util/usage-limits"
import { throttle, useSubscriptionLimits, type Display, type Level } from "./shared"

/** A window's name: Codex limits plans over 5 hours and over a week. */
function windowName(seconds: number, short: boolean) {
  if (seconds === 604800) return short ? "wk" : "Week"
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  return `${Math.round(seconds / 3600)}h`
}

function level(percent: number, limited: boolean): Level {
  if (limited || percent >= 90) return "danger"
  if (percent >= 75) return "warning"
  return "ok"
}

function planName(plan: string) {
  return plan === "unknown" ? "ChatGPT" : `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
}

export default Plugin.define({
  id: "opencode.chatgpt.usage",
  setup(context) {
    const refresh = throttle()
    const color = (value: Level) =>
      value === "danger"
        ? context.theme.text.feedback.error.base
        : value === "warning"
          ? context.theme.text.feedback.warning.base
          : context.theme.text.muted
    const useChatGPTUsage = (display: Display) => {
      const info = useSubscriptionLimits({ setting: "chatgpt_usage", providerID: "openai", display, refresh })
      return createMemo(() => {
        const chatgpt = info()?.chatgpt
        if (!chatgpt) return
        const windows = [chatgpt.primary, chatgpt.secondary].filter(
          (item): item is UsageLimitsChatGPTWindow => item !== undefined,
        )
        if (windows.length === 0) return
        return {
          plan: planName(chatgpt.plan),
          windows: windows.map((item) => ({ ...item, level: level(item.percent, chatgpt.limited && item.percent >= 100) })),
          level: level(Math.max(...windows.map((item) => item.percent)), chatgpt.limited),
        }
      })
    }

    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const usage = useChatGPTUsage("sidebar")
        return (
          <Show when={usage()}>
            {(value) => (
              <box>
                <text fg={context.theme.text.base}>
                  <b>{value().plan}</b>
                </text>
                <For each={value().windows}>
                  {(item) => (
                    <text fg={color(item.level)}>
                      {windowName(item.seconds, false)}: {Math.round(item.percent)}% used
                      <span style={{ fg: context.theme.text.muted }}> · resets {formatReset(item.resetsAt)}</span>
                    </text>
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
        const usage = useChatGPTUsage("footer")
        return (
          <Show when={props.mode === "normal" && usage()}>
            {(value) => (
              <text fg={color(value().level)} wrapMode="none" flexShrink={0}>
                ChatGPT{" "}
                {value()
                  .windows.map((item) => `${windowName(item.seconds, true)} ${Math.round(item.percent)}%`)
                  .join(" · ")}
              </text>
            )}
          </Show>
        )
      },
    })
  },
})
