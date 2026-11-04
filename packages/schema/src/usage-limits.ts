export * as UsageLimits from "./usage-limits.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { Provider } from "./provider.js"
import { optional } from "./schema.js"

const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
const Instant = Schema.Finite.annotate({ description: "Milliseconds since the Unix epoch" })

/** One window of the OpenCode Go allowance. */
export interface Meter extends Schema.Schema.Type<typeof Meter> {}
export const Meter = Schema.Struct({
  /** How much of the window's allowance is used. */
  percent: Percent,
  /** Go refuses requests until the window resets. */
  limited: Schema.Boolean,
  resetsAt: Instant,
}).annotate({ identifier: "UsageLimits.Meter" })

/** The OpenCode Go allowance of a workspace the member subscribes to Go in. */
export interface Go extends Schema.Schema.Type<typeof Go> {}
export const Go = Schema.Struct({
  rolling: Meter,
  weekly: Meter,
  monthly: Meter,
}).annotate({ identifier: "UsageLimits.Go" })

/** A model a budget covers, by the IDs OpenCode knows it by. */
export interface BudgetModel extends Schema.Schema.Type<typeof BudgetModel> {}
export const BudgetModel = Schema.Struct({
  providerID: Provider.ID,
  modelID: Model.ID,
  name: Schema.String,
  /** What a per-model budget's member has spent on this model this month. */
  spent: Money.USD.pipe(optional),
}).annotate({ identifier: "UsageLimits.BudgetModel" })

/** A monthly spend limit the OpenCode Console workspace sets on the member. */
export interface Budget extends Schema.Schema.Type<typeof Budget> {}
export const Budget = Schema.Struct({
  id: Schema.String,
  limit: Money.USD,
  /** The member's spend this month, or the pooled spend of a combined budget; per model, the most on one model. */
  spent: Money.USD,
  /** `each` limits every member separately; `combined` pools everyone's spend against one limit. */
  scope: Schema.Literals(["each", "combined"]),
  /** `set` counts spend across the budget's models; `model` limits each model separately. */
  per: Schema.Literals(["set", "model"]),
  /** `all` covers every model and billable service; `models` covers only `models`. */
  coverage: Schema.Literals(["all", "models"]),
  models: Schema.Array(BudgetModel),
  /** The vendors whose models the budget counts, by name; empty when it doesn't count by vendor. */
  vendors: Schema.Array(Schema.String),
  /** The input price per 1M tokens from which the budget counts a model, when it sets one. */
  inputPriceAtLeast: Money.USDPerMillionTokens.pipe(optional),
  /** The budget counts models picked one by one, rather than by vendor or price. */
  picked: Schema.Boolean,
  /** Everyone in the workspace pools spend against it, so reaching it pauses model use for all of them. */
  shared: Schema.Boolean,
  resetsAt: Instant,
}).annotate({ identifier: "UsageLimits.Budget" })

/** One allowance of a provider subscription, such as a rate-limit window or a monthly quota. */
export interface SubscriptionMeter extends Schema.Schema.Type<typeof SubscriptionMeter> {}
export const SubscriptionMeter = Schema.Struct({
  /** The provider's ID for the allowance, such as `premium_interactions` or `primary`. */
  id: Schema.String,
  /** A short name for the allowance, such as `5h`, `Week` or `AI credits`. */
  label: Schema.String,
  /** How much of the allowance is used. */
  percent: Percent,
  /** The provider refuses requests until the allowance resets. */
  limited: Schema.Boolean,
  resetsAt: Instant.pipe(optional),
  /** The amount used, in `unit`, when the provider counts the allowance. */
  used: Schema.Finite.pipe(optional),
  /** The allowance, in `unit`, when the provider counts it. */
  total: Schema.Finite.pipe(optional),
  /** What `used` and `total` count, such as `premium requests`. */
  unit: Schema.String.pipe(optional),
  /** Usage past the allowance is billed instead of refused. */
  overage: Schema.Boolean,
}).annotate({ identifier: "UsageLimits.SubscriptionMeter" })

/** The usage of a provider subscription a location signs in with, such as GitHub Copilot or ChatGPT. */
export interface Subscription extends Schema.Schema.Type<typeof Subscription> {}
export const Subscription = Schema.Struct({
  /** The provider whose models spend from the subscription. */
  providerID: Provider.ID,
  /** The subscription's display name, such as `ChatGPT Plus` or `GitHub Copilot`. */
  name: Schema.String,
  /** The plan the provider reports, such as `plus` or `business`; arbitrary, `unknown` when not reported. */
  plan: Schema.String,
  meters: Schema.Array(SubscriptionMeter),
}).annotate({ identifier: "UsageLimits.Subscription" })

/** The usage limits of the OpenCode Console workspace and the subscriptions a location is signed in to. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  workspace: Schema.Struct({
    id: Schema.String,
    name: Schema.String.pipe(optional),
    /** The member's usage page in OpenCode Console. */
    usageURL: Schema.String,
  }).pipe(optional),
  go: Go.pipe(optional),
  budgets: Schema.Array(Budget),
  subscriptions: Schema.Array(Subscription),
}).annotate({ identifier: "UsageLimits.Info" })
