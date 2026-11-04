export * as UsageLimits from "./usage-limits.js"

import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { UsageLimits } from "@opencode/schema/usage-limits"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Context, Duration, Effect, Layer, Result, Schema, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ConsoleAccess } from "./console-access.js"
import type { Credential } from "./credential.js"
import { Integration } from "./integration.js"

export const Info = UsageLimits.Info
export type Info = UsageLimits.Info

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("UsageLimits.UnavailableError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The usage limits of the OpenCode Console workspace and the provider subscriptions this location is signed in to. */
  readonly get: () => Effect.Effect<Info | undefined, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/UsageLimits") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const http = yield* HttpClient.HttpClient

    const get = Effect.fn("UsageLimits.get")(function* () {
      // Each source answers on its own, so one that fails doesn't hide the others; only when every source the
      // location is signed in to fails is the read unavailable.
      const [consoleResult, ...subscriptionResults] = yield* Effect.all(
        [Effect.result(readConsole()), ...subscriptionSources.map((source) => Effect.result(readSubscription(source)))],
        { concurrency: "unbounded" },
      )
      const consoleLimits = Result.getOrUndefined(consoleResult)
      const subscriptions = subscriptionResults
        .map(Result.getOrUndefined)
        .filter((subscription): subscription is UsageLimits.Subscription => subscription !== undefined)
      const failure = [Result.isFailure(consoleResult) ? consoleResult.failure : undefined]
        .concat(subscriptionResults.map((result) => (Result.isFailure(result) ? result.failure : undefined)))
        .find((error) => error !== undefined)
      if (!consoleLimits && subscriptions.length === 0) {
        if (failure) return yield* Effect.fail(failure)
        return undefined
      }
      if (failure) yield* Effect.logWarning("some usage limits are unavailable", { cause: failure })
      return { ...consoleLimits, budgets: consoleLimits?.budgets ?? [], subscriptions }
    })

    /** Reads a subscription's usage with the OAuth sign-in of its integration; an API key has no subscription. */
    const readSubscription = Effect.fnUntraced(function* (source: SubscriptionSource) {
      const connection = yield* integrations.connection.active(Integration.ID.make(source.integration))
      if (!connection) return undefined
      const credential = yield* integrations.connection
        .resolve(connection)
        .pipe(Effect.mapError((error) => new UnavailableError({ message: error.message })))
      if (!credential || credential.type !== "oauth") return undefined
      return yield* source.read(http, credential).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: Duration.seconds(15),
          orElse: () => Effect.fail(new Error("timed out")),
        }),
        Effect.mapError((error) => new UnavailableError({ message: `${source.name} is unavailable: ${error.message}` })),
      )
    })

    const readConsole = Effect.fnUntraced(function* () {
      const connection = yield* integrations.connection.active(Integration.ID.make("opencode"))
      if (!connection) return undefined
      const credential = yield* integrations.connection
        .resolve(connection)
        .pipe(Effect.mapError((error) => new UnavailableError({ message: error.message })))
      if (!credential || credential.type === "external") return undefined
      const workspaceID = credential.metadata?.orgID
      if (typeof workspaceID !== "string") return undefined
      const server = ConsoleAccess.server(credential)
      const [budgets, go] = yield* Effect.all(
        [readBudgets(http, server, credential), readGo(http, server, credential, workspaceID)],
        { concurrency: 2 },
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(15),
          orElse: () => Effect.fail(new UnavailableError({ message: "OpenCode Console usage limits timed out" })),
        }),
      )
      return {
        workspace: {
          id: workspaceID,
          ...(typeof credential.metadata?.orgName === "string" ? { name: credential.metadata.orgName } : {}),
          usageURL: `${server}/${workspaceID}/activity/overview`,
        },
        ...(go === undefined ? {} : { go }),
        budgets,
      }
    })

    return Service.of({ get })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, httpClient],
})

// One budget as `GET /api/policies/current-budgets` describes it.
const ConsoleBudget = Schema.Struct({
  ruleID: Schema.String,
  limitDollars: Schema.Finite,
  spentDollars: Schema.Finite,
  scope: UsageLimits.Budget.fields.scope,
  per: UsageLimits.Budget.fields.per,
  coverage: UsageLimits.Budget.fields.coverage,
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      name: Schema.String,
      spentDollars: Schema.optional(Schema.Finite),
    }),
  ),
  vendors: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  inputPriceAtLeast: Schema.optional(Schema.Finite),
  picked: Schema.Boolean,
  shared: Schema.Boolean,
  resetsAt: Schema.DateFromString,
})

const GoMeter = Schema.Struct({
  status: Schema.Literals(["ok", "rate-limited"]),
  percent: Schema.Finite,
  resetsAt: Schema.DateFromString,
})
const GoUsage = Schema.Struct({ usage: Schema.Struct({ rolling: GoMeter, weekly: GoMeter, monthly: GoMeter }) })

/** Every budget covering the member. Console refuses a service account's key with 403, and it has no budgets. */
function readBudgets(http: HttpClient.HttpClient, server: string, credential: Credential.Key | Credential.OAuth) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${server}/api/policies/current-budgets`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(ConsoleAccess.headers(credential)),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status === 403
          ? Effect.succeed([])
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ConsoleBudget))),
              Effect.map((budgets) =>
                budgets.map((budget) => ({
                  id: budget.ruleID,
                  limit: Money.USD.make(budget.limitDollars),
                  spent: Money.USD.make(budget.spentDollars),
                  scope: budget.scope,
                  per: budget.per,
                  coverage: budget.coverage,
                  models: budget.models.map((model) => ({
                    providerID: Provider.ID.make(model.providerID),
                    modelID: Model.ID.make(model.modelID),
                    name: model.name,
                    ...(model.spentDollars === undefined ? {} : { spent: Money.USD.make(model.spentDollars) }),
                  })),
                  vendors: budget.vendors.map((vendor) => vendor.name),
                  ...(budget.inputPriceAtLeast === undefined
                    ? {}
                    : { inputPriceAtLeast: Money.USDPerMillionTokens.make(budget.inputPriceAtLeast) }),
                  picked: budget.picked,
                  shared: budget.shared,
                  resetsAt: budget.resetsAt.getTime(),
                })),
              ),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Console budgets are unavailable: ${error.message}` }),
      ),
    )
}

/**
 * The Go allowance, from the inference API that shares the Console's origin. Go refuses (403) a workspace the member
 * doesn't subscribe to Go in, which has no allowance to show.
 */
function readGo(
  http: HttpClient.HttpClient,
  server: string,
  credential: Credential.Key | Credential.OAuth,
  workspaceID: string,
) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${new URL(server).origin}/zen/go/v1/usage`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(credential.type === "oauth" ? credential.access : credential.key),
        HttpClientRequest.setHeader("x-opencode-org-id", workspaceID),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status === 403
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(GoUsage)),
              Effect.map((body) => ({
                rolling: meter(body.usage.rolling),
                weekly: meter(body.usage.weekly),
                monthly: meter(body.usage.monthly),
              })),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Go usage is unavailable: ${error.message}` }),
      ),
    )
}

function meter(value: typeof GoMeter.Type) {
  return { percent: value.percent, limited: value.status === "rate-limited", resetsAt: value.resetsAt.getTime() }
}

/** A provider subscription whose usage the location reads with the OAuth sign-in of its integration. */
interface SubscriptionSource {
  readonly integration: string
  /** Names the usage in errors, such as `GitHub Copilot usage`. */
  readonly name: string
  readonly read: (
    http: HttpClient.HttpClient,
    credential: Credential.OAuth,
  ) => Effect.Effect<UsageLimits.Subscription, Error, Scope.Scope>
}

/** A source that reads its usage with one GET whose JSON body `body` decodes. */
function subscriptionSource<S extends Schema.Decoder<unknown>>(input: {
  integration: string
  name: string
  request: (credential: Credential.OAuth) => HttpClientRequest.HttpClientRequest
  body: S
  subscription: (body: S["Type"]) => UsageLimits.Subscription
}): SubscriptionSource {
  return {
    integration: input.integration,
    name: input.name,
    read: (http, credential) =>
      HttpClient.withScope(http)
        .execute(input.request(credential).pipe(HttpClientRequest.acceptJson))
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(input.body)),
          Effect.map(input.subscription),
        ),
  }
}

const percent = (value: number) => Math.min(100, Math.max(0, value))

// The parts of `GET /copilot_internal/user` that describe the plan's quotas.
const CopilotSnapshot = Schema.Struct({
  entitlement: Schema.Finite,
  remaining: Schema.Finite,
  quota_remaining: Schema.optional(Schema.Finite),
  percent_remaining: Schema.Finite,
  unlimited: Schema.Boolean,
  overage_permitted: Schema.optional(Schema.Boolean),
})
const CopilotUser = Schema.Struct({
  copilot_plan: Schema.optional(Schema.String),
  token_based_billing: Schema.optional(Schema.Boolean),
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_reset_date: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(Schema.Record(Schema.String, CopilotSnapshot)),
})

function copilotSubscription(user: typeof CopilotUser.Type): UsageLimits.Subscription {
  const reset = Date.parse(user.quota_reset_date_utc ?? user.quota_reset_date ?? "")
  const unit = user.token_based_billing ? "AI credits" : "premium requests"
  return {
    providerID: Provider.ID.make("github-copilot"),
    name: "GitHub Copilot",
    plan: user.copilot_plan ?? "unknown",
    // Unlimited quotas have nothing to run out of; premium requests (or AI credits) come first.
    meters: Object.entries(user.quota_snapshots ?? {})
      .filter(([, quota]) => !quota.unlimited)
      .toSorted(([a], [b]) => Number(b === "premium_interactions") - Number(a === "premium_interactions"))
      .map(([id, quota]) => {
        // AI credits are fractional; `remaining` is rounded down.
        const remaining = quota.quota_remaining ?? quota.remaining
        const overage = quota.overage_permitted ?? false
        return {
          id,
          label: id === "premium_interactions" ? unit.charAt(0).toUpperCase() + unit.slice(1) : id,
          percent: percent(100 - quota.percent_remaining),
          limited: !overage && remaining <= 0,
          ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
          used: Math.max(0, quota.entitlement - remaining),
          total: quota.entitlement,
          ...(id === "premium_interactions" ? { unit } : {}),
          overage,
        }
      }),
  }
}

// The parts of `GET chatgpt.com/backend-api/wham/usage` that describe the subscription's Codex windows.
const CodexWindow = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Schema.Finite,
  reset_at: Schema.Finite,
})
const CodexUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        limit_reached: Schema.optional(Schema.Boolean),
        primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
        secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      }),
    ),
  ),
})

function chatgptSubscription(usage: typeof CodexUsage.Type): UsageLimits.Subscription {
  const plan = usage.plan_type ?? "unknown"
  const limited = usage.rate_limit?.limit_reached ?? false
  const windows = [
    ["primary", usage.rate_limit?.primary_window],
    ["secondary", usage.rate_limit?.secondary_window],
  ] as const
  return {
    providerID: Provider.ID.make("openai"),
    name: plan === "unknown" ? "ChatGPT" : `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`,
    plan,
    meters: windows.flatMap(([id, window]) =>
      window
        ? [
            {
              id,
              label: windowLabel(window.limit_window_seconds),
              percent: percent(window.used_percent),
              limited: limited && window.used_percent >= 100,
              resetsAt: window.reset_at * 1000,
              overage: false,
            },
          ]
        : [],
    ),
  }
}

/** Codex limits plans over 5 hours and over a week. */
function windowLabel(seconds: number) {
  if (seconds === 604800) return "Week"
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  return `${Math.round(seconds / 3600)}h`
}

/** Every provider subscription whose usage limits a location can show. Add a source here to show another one. */
const subscriptionSources: ReadonlyArray<SubscriptionSource> = [
  subscriptionSource({
    integration: "github-copilot",
    name: "GitHub Copilot usage",
    request: (credential) => {
      const enterprise = credential.metadata?.enterpriseUrl
      const api = typeof enterprise === "string" ? `https://api.${enterprise}` : "https://api.github.com"
      return HttpClientRequest.get(`${api}/copilot_internal/user`).pipe(
        HttpClientRequest.bearerToken(credential.refresh),
        HttpClientRequest.setHeaders({ "User-Agent": "opencode", "X-GitHub-Api-Version": "2025-04-01" }),
      )
    },
    body: CopilotUser,
    subscription: copilotSubscription,
  }),
  subscriptionSource({
    integration: "openai",
    name: "ChatGPT subscription usage",
    request: (credential) => {
      const account = credential.metadata?.accountID
      return HttpClientRequest.get("https://chatgpt.com/backend-api/wham/usage").pipe(
        HttpClientRequest.bearerToken(credential.access),
        HttpClientRequest.setHeaders({
          "User-Agent": "opencode",
          ...(typeof account === "string" ? { "ChatGPT-Account-Id": account } : {}),
        }),
      )
    },
    body: CodexUsage,
    subscription: chatgptSubscription,
  }),
]
