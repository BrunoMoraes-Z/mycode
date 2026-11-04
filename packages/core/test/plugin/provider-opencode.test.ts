import { describe, expect } from "bun:test"
import { Money } from "@opencode/schema/money"
import { Effect } from "effect"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OpencodePlugin } from "@opencode/core/plugin/provider/opencode"
import { Provider } from "@opencode/core/provider"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* OpencodePlugin.effect(host)
})

const cost = (input: number) => [
  {
    input: Money.USDPerMillionTokens.make(input),
    output: Money.USDPerMillionTokens.zero,
    cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
  },
]

describe("OpencodePlugin (isolated)", () => {
  for (const env of [{ OPENCODE_API_KEY: undefined }, { OPENCODE_API_KEY: "secret" }])
    it.effect(`hides the OpenCode provider, its models and its sign-in (${JSON.stringify(env)})`, () =>
      withEnv(env, () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          const models = yield* Model.Service
          const integrations = yield* Integration.Service
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID: Integration.ID.make("opencode"),
              method: { type: "env", names: ["OPENCODE_API_KEY"] },
            }),
          )
          yield* catalog.transform((catalog) => {
            catalog.update(Provider.ID.opencode, (draft) => {
              draft.settings = { apiKey: "configured" }
              draft.activation = "enabled"
            })
            catalog.models.update(Provider.ID.opencode, Model.ID.make("free"), (draft) => {
              draft.cost = cost(0)
            })
            catalog.models.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
              draft.cost = cost(1)
            })
          })
          yield* addPlugin()
          expect(yield* catalog.get(Provider.ID.opencode)).toBeUndefined()
          expect((yield* catalog.available()).map((provider) => provider.id)).not.toContain(Provider.ID.opencode)
          expect(yield* models.get(Provider.ID.opencode, Model.ID.make("free"))).toBeUndefined()
          expect(yield* models.get(Provider.ID.opencode, Model.ID.make("paid"))).toBeUndefined()
          expect(yield* integrations.get(Integration.ID.make("opencode"))).toBeUndefined()
        }),
      ),
    )
})
