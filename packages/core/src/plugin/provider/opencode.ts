import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "../../provider.js"

// Isolated build: no OpenCode Console sign-in and no OpenCode Zen or Go providers, so nothing reaches OpenCode servers.
const hidden = [Provider.ID.opencode, Provider.ID.make("opencode-go")]

export const OpencodePlugin = define({
  id: "opencode.provider.opencode",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((editor) => {
      hidden.forEach((id) => editor.remove(id))
    })
    yield* ctx.provider.transform((providers) => {
      hidden.forEach((id) => {
        if (providers.get(id)) providers.remove(id)
      })
    })
  }),
})
