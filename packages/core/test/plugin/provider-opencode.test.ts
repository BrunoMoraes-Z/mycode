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
  for (const [id, env] of [
    ["opencode", { OPENCODE_API_KEY: undefined }],
    ["opencode", { OPENCODE_API_KEY: "secret" }],
    ["opencode-go", { OPENCODE_API_KEY: undefined }],
  ] as const)
    it.effect(`hides the ${id} provider, its models and its sign-in (${JSON.stringify(env)})`, () =>
      withEnv(env, () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          const models = yield* Model.Service
          const integrations = yield* Integration.Service
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID: Integration.ID.make(id),
              method: { type: "env", names: ["OPENCODE_API_KEY"] },
            }),
          )
          yield* catalog.transform((catalog) => {
            catalog.update(Provider.ID.make(id), (draft) => {
              draft.settings = { apiKey: "configured" }
              draft.activation = "enabled"
            })
            catalog.models.update(Provider.ID.make(id), Model.ID.make("free"), (draft) => {
              draft.cost = cost(0)
            })
            catalog.models.update(Provider.ID.make(id), Model.ID.make("paid"), (draft) => {
              draft.cost = cost(1)
            })
          })
          yield* addPlugin()
          expect(yield* catalog.get(Provider.ID.make(id))).toBeUndefined()
          expect((yield* catalog.available()).map((provider) => provider.id)).not.toContain(Provider.ID.make(id))
          expect(yield* models.get(Provider.ID.make(id), Model.ID.make("free"))).toBeUndefined()
          expect(yield* models.get(Provider.ID.make(id), Model.ID.make("paid"))).toBeUndefined()
          expect(yield* integrations.get(Integration.ID.make(id))).toBeUndefined()
        }),
      ),
    )
})
