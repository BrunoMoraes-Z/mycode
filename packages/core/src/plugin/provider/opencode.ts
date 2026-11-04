import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "../../provider.js"

// Isolated build: no OpenCode Console sign-in and no OpenCode (Zen/Go) provider, so nothing reaches OpenCode servers.
export const OpencodePlugin = define({
  id: "opencode.provider.opencode",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((editor) => {
      editor.remove("opencode")
    })
    yield* ctx.provider.transform((providers) => {
      if (providers.get(Provider.ID.opencode)) providers.remove(Provider.ID.opencode)
    })
  }),
})
