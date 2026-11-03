import { expect } from "bun:test"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { UsageLimits } from "@opencode/core/usage-limits"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const unused = () => Effect.die("unused")

const signedIn = Credential.OAuth.make({
  type: "oauth",
  methodID: Integration.MethodID.make("device"),
  access: "console-access",
  refresh: "console-refresh",
  expires: 1,
  metadata: { server: "https://dev.opencode.ai/console", orgID: "wrk_anomaly", orgName: "Anomaly" },
})

const budget = {
  policyID: "policy_engineering",
  ruleID: "rule_astra",
  limitDollars: 20,
  spentDollars: 15,
  scope: "each",
  per: "model",
  modelCount: 1,
  coverage: "models",
  models: [
    {
      providerID: "opencode",
      connectionID: "conn_managed",
      modelID: "gpt-6-astra",
      name: "GPT-6 Astra",
      spentDollars: 15,
    },
  ],
  vendors: [{ id: "openai", name: "OpenAI" }],
  inputPriceAtLeast: 3,
  picked: false,
  shared: false,
  resetsAt: "2026-11-01T00:00:00.000Z",
}

const meter = (status: string, percent: number) => ({ status, percent, resetsAt: "2026-10-24T17:00:00.000Z" })

/**
 * Reads usage limits for a location whose active OpenCode Console connection resolves to `credential`, and whose
 * GitHub Copilot connection resolves to `copilot`.
 */
const read = (
  credential: Credential.Value | undefined,
  respond: (url: string) => Response,
  requests: HttpClientRequest.HttpClientRequest[] = [],
  copilot?: Credential.Value,
) =>
  Effect.flatMap(UsageLimits.Service, (limits) => limits.get()).pipe(
    Effect.provide(
      UsageLimits.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.mock(Integration.Service, {
              revision: () => 0,
              get: unused,
              connection: {
                active: (integrationID) => {
                  const value = integrationID === "github-copilot" ? copilot : credential
                  return Effect.succeed(
                    value && {
                      type: "credential" as const,
                      id: Credential.ID.make(integrationID === "github-copilot" ? "copilot" : "console"),
                      label: "Anomaly",
                      method: "oauth" as const,
                    },
                  )
                },
                resolve: (connection) =>
                  Effect.succeed(
                    connection.type === "credential" && connection.id === "copilot" ? copilot : credential,
                  ),
                key: unused,
                external: unused,
                activate: unused,
                update: unused,
                remove: unused,
                status: unused,
              },
              oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
              command: { connect: unused, status: unused, cancel: unused },
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
                Effect.sync(() => {
                  requests.push(request)
                  return HttpClientResponse.fromWeb(request, respond(request.url))
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  )

it.effect("reads the member's Go allowance and budgets from the Console they signed in to", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const limits = yield* read(
      signedIn,
      (url) =>
        url.endsWith("/zen/go/v1/usage")
          ? Response.json({
              usage: { rolling: meter("ok", 42), weekly: meter("ok", 18), monthly: meter("rate-limited", 100) },
            })
          : Response.json([budget]),
      requests,
    )

    expect(limits).toEqual({
      workspace: {
        id: "wrk_anomaly",
        name: "Anomaly",
        usageURL: "https://dev.opencode.ai/console/wrk_anomaly/activity/overview",
      },
      go: {
        rolling: { percent: 42, limited: false, resetsAt: Date.parse("2026-10-24T17:00:00.000Z") },
        weekly: { percent: 18, limited: false, resetsAt: Date.parse("2026-10-24T17:00:00.000Z") },
        monthly: { percent: 100, limited: true, resetsAt: Date.parse("2026-10-24T17:00:00.000Z") },
      },
      budgets: [
        {
          id: "rule_astra",
          limit: Money.USD.make(20),
          spent: Money.USD.make(15),
          scope: "each",
          per: "model",
          coverage: "models",
          models: [
            {
              providerID: Provider.ID.make("opencode"),
              modelID: Model.ID.make("gpt-6-astra"),
              name: "GPT-6 Astra",
              spent: Money.USD.make(15),
            },
          ],
          vendors: ["OpenAI"],
          inputPriceAtLeast: Money.USDPerMillionTokens.make(3),
          picked: false,
          shared: false,
          resetsAt: Date.parse("2026-11-01T00:00:00.000Z"),
        },
      ],
    })
    // Console reads the workspace from x-org-id; inference, which serves Go, from x-opencode-org-id.
    expect(
      requests
        .map((request) => ({
          url: request.url,
          authorization: request.headers.authorization,
          workspace: Object.entries(request.headers).filter(([name]) => name.endsWith("org-id")),
        }))
        .toSorted((a, b) => a.url.localeCompare(b.url)),
    ).toEqual([
      {
        url: "https://dev.opencode.ai/console/api/policies/current-budgets",
        authorization: "Bearer console-access",
        workspace: [["x-org-id", "wrk_anomaly"]],
      },
      {
        url: "https://dev.opencode.ai/zen/go/v1/usage",
        authorization: "Bearer console-access",
        workspace: [["x-opencode-org-id", "wrk_anomaly"]],
      },
    ])
  }),
)

it.effect("has no Go allowance or budgets to show where Console refuses them", () =>
  Effect.gen(function* () {
    // Go refuses a workspace without the member's subscription; Console refuses budgets to a service account's key.
    const limits = yield* read(signedIn, () => Response.json({ type: "error" }, { status: 403 }))

    expect(limits).toEqual({
      workspace: {
        id: "wrk_anomaly",
        name: "Anomaly",
        usageURL: "https://dev.opencode.ai/console/wrk_anomaly/activity/overview",
      },
      budgets: [],
    })
  }),
)

it.effect("has nothing to show for a location that isn't signed in to OpenCode Console", () =>
  Effect.gen(function* () {
    expect(yield* read(undefined, () => Response.json([budget]))).toBeUndefined()
  }),
)

it.effect("reports a Console that can't answer as unavailable", () =>
  Effect.gen(function* () {
    // Go has nothing to show, so only the Console's failure can fail the read.
    const exit = yield* read(signedIn, (url) =>
      url.endsWith("/current-budgets")
        ? new Response("upstream down", { status: 502 })
        : Response.json({ type: "error" }, { status: 403 }),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({
      value: { _tag: "UsageLimits.UnavailableError" },
    })
  }),
)

const copilot = Credential.OAuth.make({
  type: "oauth",
  methodID: Integration.MethodID.make("device"),
  access: "gho_copilot",
  refresh: "gho_copilot",
  expires: 0,
})

const snapshot = (input: { entitlement: number; remaining: number; percent: number; unlimited?: boolean }) => ({
  entitlement: input.entitlement,
  remaining: Math.floor(input.remaining),
  quota_remaining: input.remaining,
  percent_remaining: input.percent,
  unlimited: input.unlimited ?? false,
  overage_permitted: true,
  overage_count: 0,
  quota_id: "premium_interactions",
  credits_used: 665,
})

it.effect("reads the GitHub Copilot plan's AI credits with the stored GitHub token", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const limits = yield* read(
      undefined,
      () =>
        Response.json({
          copilot_plan: "business",
          token_based_billing: true,
          quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
          quota_snapshots: {
            chat: snapshot({ entitlement: 0, remaining: 0, percent: 100, unlimited: true }),
            premium_interactions: snapshot({ entitlement: 25000, remaining: 24204.3, percent: 96.8 }),
          },
        }),
      requests,
      copilot,
    )

    expect(requests.map((request) => [request.url, request.headers.authorization])).toEqual([
      ["https://api.github.com/copilot_internal/user", "Bearer gho_copilot"],
    ])
    expect(limits).toEqual({
      budgets: [],
      copilot: {
        plan: "business",
        tokenBased: true,
        resetsAt: Date.parse("2026-12-01T00:00:00.000Z"),
        quotas: [
          {
            id: "chat",
            entitlement: 0,
            remaining: 0,
            percentRemaining: 100,
            unlimited: true,
            overagePermitted: true,
            overageCount: 0,
          },
          {
            id: "premium_interactions",
            entitlement: 25000,
            remaining: 24204.3,
            percentRemaining: 96.8,
            unlimited: false,
            overagePermitted: true,
            overageCount: 0,
          },
        ],
      },
    })
  }),
)

it.effect("asks a GitHub Enterprise Copilot sign-in's own API host", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    yield* read(undefined, () => Response.json({ quota_snapshots: {} }), requests, {
      ...copilot,
      metadata: { enterpriseUrl: "ghe.example.com" },
    })
    expect(requests.map((request) => request.url)).toEqual(["https://api.ghe.example.com/copilot_internal/user"])
  }),
)

it.effect("reports a GitHub Copilot quota lookup that fails as unavailable", () =>
  Effect.gen(function* () {
    const exit = yield* read(undefined, () => new Response("bad credentials", { status: 401 }), [], copilot).pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({
      value: { _tag: "UsageLimits.UnavailableError" },
    })
  }),
)
