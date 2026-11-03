import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { RetainedImage } from "./retained-image"
import { action, parseReleaseVersion, type Policy } from "./updater-action"
import { errorMessage } from "../util/error"

export const methods = ["github", "curl", "npm", "pnpm", "bun", "yarn", "vp", "brew", "winget"] as const

// Isolated build: releases come from this repository's GitHub Releases, one per semver tag (vX.Y.Z).
const releaseRepository = "BrunoMoraes-Z/mycode"
const releaseAsset = `opencode-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String, browser_download_url: Schema.String })),
})
const decodeGitHubReleases = Schema.decodeUnknownOption(Schema.Array(GitHubRelease))
const decodeBrewFormula = Schema.decodeUnknownOption(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) }))

function githubHeaders(accept = "application/vnd.github+json") {
  const token = process.env.OPENCODE_UPDATE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
  return {
    Accept: accept,
    "User-Agent": "opencode-isolated-updater",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function compareVersions(a: string, b: string) {
  const left = parseReleaseVersion(a)
  const right = parseReleaseVersion(b)
  if (!left || !right) return 0
  const core = left.core
    .split(".")
    .map((part, index) => Number(part) - Number(right.core.split(".")[index]))
    .find((difference) => difference !== 0)
  if (core) return core
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return right.prerelease.length - left.prerelease.length
  return left.prerelease.join(".").localeCompare(right.prerelease.join("."), undefined, { numeric: true })
}

export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export class UpgradeError extends Error {
  readonly title: string
  readonly detail: string
  readonly command?: string
  readonly retry: string

  constructor(
    input: {
      readonly title: string
      readonly detail: string
      readonly command?: string
      readonly retry: string
    },
    options?: ErrorOptions,
  ) {
    super(input.detail, options)
    this.name = "UpgradeError"
    this.title = input.title
    this.detail = input.detail
    this.command = input.command
    this.retry = input.retry
  }
}

const decodeVpPackages = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
)

const installNames: Record<Method, string> = {
  github: "GitHub Releases",
  curl: "The OpenCode installer",
  npm: "npm",
  pnpm: "pnpm",
  bun: "Bun",
  yarn: "Yarn",
  vp: "Vite+",
  brew: "Homebrew",
  winget: "WinGet",
}

const wingetPackage = "Anomaly.OpenCode"
const wingetArgs = [
  "--id",
  wingetPackage,
  "--exact",
  "--source",
  "winget",
  "--accept-source-agreements",
  "--disable-interactivity",
]

function conciseDetail(input: string) {
  const lines = stripVTControlCharacters(input)
    .trim()
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const tail = lines.slice(-12).join("\n")
  const clipped = tail.length > 2_000
  const detail = clipped ? `…${tail.slice(-1_999)}` : tail
  if (!detail) return
  if (lines.length <= 12 && !clipped) return detail
  return `${detail}\n\nOutput shortened to the last 12 lines.`
}

function errorDetail(cause: unknown): string {
  if (cause instanceof AppProcess.AppProcessError) {
    const stderr = conciseDetail(cause.stderr ?? "")
    if (stderr) return stderr
    if (cause.cause !== undefined) return errorDetail(cause.cause)
    return cause.message
  }
  if (cause instanceof Error) {
    const detail = cause.cause === undefined ? undefined : errorDetail(cause.cause)
    if (!detail || detail === cause.message) return cause.message
    return `${cause.message}: ${detail}`
  }
  return errorMessage(cause)
}

function resultDetail(result: { code: number; stdout: string; stderr: string }) {
  return (
    conciseDetail(result.stderr) ??
    conciseDetail(result.stdout) ??
    `The command exited with code ${result.code} without any error output.`
  )
}

export interface Interface {
  readonly run: (onInstall?: (version: string) => void) => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: (method?: Method) => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
  readonly removal: (
    method: Method,
  ) => { readonly command: ReadonlyArray<string>; readonly run: Effect.Effect<void, Error> } | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const executable = yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))
  const installedPackage = yield* Effect.gen(function* () {
    const directory = path.dirname(path.dirname(executable))
    const manifest: { name: string; bin?: Record<string, string> } = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text))))
    // Source invocations run inside Bun or Node, which may themselves be npm packages.
    if (!/^@opencode(?:-ai)?\/cli(?:-node)?$/.test(manifest.name)) return
    if (Object.values(manifest.bin ?? {}).some((bin) => path.resolve(directory, bin) === executable))
      return manifest.name
  }).pipe(Effect.orElseSucceed(() => undefined))
  // "opencode" is Homebrew Core's formula; the others are published to anomalyco/tap.
  const installedFormula = ["opencode", "opencode-beta", "opencode-v2"].find((name) =>
    executable.includes(`${path.sep}Cellar${path.sep}${name}${path.sep}`),
  )
  // WinGet extracts portable packages into a directory named after the package identifier.
  const installedWinget = /[\\/]winget[\\/]packages[\\/]anomaly\.opencode_/i.test(executable)

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  const exec = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "30 seconds") {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
      )
  })

  const curlPath = path.resolve(
    global.home,
    ".opencode",
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  )
  const curlBinary = yield* fs.realPath(curlPath).pipe(Effect.orElseSucceed(() => curlPath))

  // Replaces the running executable with the release asset. Windows cannot overwrite a running .exe but can rename
  // it, so the current binary moves aside to `.old` (removed on the next update) before the new one takes its place.
  const githubUpgrade = Effect.fnUntraced(function* (version: string) {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: "Could not install the OpenCode update from GitHub",
          detail,
          retry: "Check your network, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    const download = (url: string, accept?: string) =>
      Effect.tryPromise({
        try: (signal) =>
          fetch(url, { headers: githubHeaders(accept), signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) }),
        catch: (cause) => failure(errorDetail(cause), cause),
      }).pipe(
        Effect.filterOrFail(
          (response) => response.ok,
          (response) => failure(`GitHub returned HTTP ${response.status} for ${url}.`),
        ),
      )
    const tag = yield* download(`https://api.github.com/repos/${releaseRepository}/releases/tags/v${version}`).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({ try: () => response.json(), catch: (cause) => failure(errorDetail(cause), cause) }),
      ),
    )
    const asset = Option.getOrUndefined(decodeGitHubReleases([tag]))?.[0]?.assets.find(
      (item) => item.name === releaseAsset,
    )
    if (!asset) return yield* Effect.fail(failure(`Release v${version} has no ${releaseAsset} asset.`))
    // The API URL also serves assets of private repositories when a token is set.
    const bytes = yield* download(asset.url, "application/octet-stream").pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({ try: () => response.arrayBuffer(), catch: (cause) => failure(errorDetail(cause), cause) }),
      ),
    )
    const next = `${executable}.new`
    const previous = `${executable}.old`
    yield* fs.writeFile(next, new Uint8Array(bytes))
    if (process.platform !== "win32") yield* fs.chmod(next, 0o755)
    yield* fs.remove(previous, { force: true })
    if (process.platform === "win32") yield* fs.rename(executable, previous)
    yield* fs.rename(next, executable)
  })

  const method = Effect.fnUntraced(function* () {
    if (executable === curlBinary) return "curl"
    if (installedFormula) return "brew"
    if (installedWinget) return "winget"
    // Release binaries from GitHub are standalone executables named opencode; source checkouts run inside bun or node.
    if (!installedPackage && !OPENCODE_LOCAL && path.basename(executable).toLowerCase().startsWith("opencode"))
      return "github"
    if (!installedPackage) return

    const parts = executable.toLowerCase().split(path.sep).map((part) => part.replace(/^\./, ""))
    const checks: Array<{ method: Method; command: string[] }> = [
      { method: "npm", command: ["npm", "list", "-g", "--depth=0", installedPackage] },
      { method: "pnpm", command: ["pnpm", "list", "-g", "--depth=0", installedPackage] },
      { method: "bun", command: ["bun", "pm", "ls", "-g"] },
      { method: "yarn", command: ["yarn", "global", "list"] },
      { method: "vp", command: ["vp", "list", "-g", "--json", installedPackage] },
    ]
    checks.sort((a, b) => Number(parts.includes(b.method)) - Number(parts.includes(a.method)))
    const results = yield* Effect.forEach(
      checks,
      (check) =>
        exec(check.command).pipe(
          Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
          Effect.map((result) => ({ check, result })),
        ),
      { concurrency: "unbounded" },
    )
    return results.find((result) => {
      if (result.check.method !== "vp") return result.result.stdout.includes(installedPackage)
      // Vite+ repeats the filter in its successful no-match message, so substring detection would be a false positive.
      return Option.exists(decodeVpPackages(result.result.stdout), (packages) =>
        packages.some((item) => item.name === installedPackage),
      )
    })?.check.method
  })

  const removalCommand = (method: Method) => {
    if (method === "winget") return ["winget", "uninstall", ...wingetArgs]
    if (method === "github" || method === "curl" || method === "brew" || !installedPackage) return undefined
    const commands = {
      npm: ["npm", "uninstall", "--global", installedPackage],
      pnpm: ["pnpm", "remove", "--global", installedPackage],
      bun: ["bun", "remove", "--global", installedPackage],
      yarn: ["yarn", "global", "remove", installedPackage],
      vp: ["vp", "uninstall", "-g", installedPackage],
    }
    return commands[method]
  }

  const removal = (method: Method) => {
    const command = removalCommand(method)
    if (!command) return undefined
    return {
      command,
      run: retaining(
        method,
        exec(command, "5 minutes").pipe(
          Effect.flatMap((result) => (result.code === 0 ? Effect.void : Effect.fail(new Error(resultDetail(result))))),
        ),
        global.tmp,
      ),
    }
  }

  const release = Effect.fnUntraced(function* (method?: Method) {
    // Homebrew Core builds its formula on its own schedule, so the tap release does not describe it.
    const core = method === "brew" && installedFormula === "opencode"
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: "Could not check for OpenCode updates",
          detail,
          retry: "Check your network, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(
          core
            ? "https://formulae.brew.sh/api/formula/opencode.json"
            : `https://api.github.com/repos/${releaseRepository}/releases?per_page=100`,
          {
            headers: core ? undefined : githubHeaders(),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        ),
      catch: (cause) => failure(errorDetail(cause), cause),
    })
    if (!response.ok) return yield* Effect.fail(failure(`The update service returned HTTP ${response.status}.`))
    const data: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => failure(errorDetail(cause), cause),
    })
    if (core) {
      const version = Option.getOrUndefined(decodeBrewFormula(data))?.versions.stable
      if (!version) return yield* Effect.fail(failure("Homebrew returned no stable version."))
      return { package: "opencode", version, asset: undefined }
    }
    const latest = Option.getOrElse(decodeGitHubReleases(data), () => [])
      .filter((item) => !item.draft && !item.prerelease && parseReleaseVersion(item.tag_name))
      .toSorted((a, b) => compareVersions(b.tag_name, a.tag_name))[0]
    if (!latest)
      return yield* Effect.fail(failure(`No published release with a vX.Y.Z tag was found in ${releaseRepository}.`))
    return {
      package:
        method === "brew" && installedFormula ? `anomalyco/tap/${installedFormula}` : (installedPackage ?? "@opencode/cli"),
      version: latest.tag_name.replace(/^v/, ""),
      asset: latest.assets.find((asset) => asset.name === releaseAsset),
    }
  })

  // WinGet moderates every submission, so only its own index knows which release it can install.
  const wingetVersion = Effect.fnUntraced(function* () {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: "Could not check for OpenCode updates",
          detail,
          command: ["winget", "search", ...wingetArgs].join(" "),
          retry: "Fix the issue above, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    const result = yield* exec(["winget", "search", ...wingetArgs], "1 minute").pipe(
      Effect.mapError((cause) => failure(errorDetail(cause), cause)),
    )
    // Column headers are localized, but the result row always lists the identifier followed by the version.
    const version = result.stdout
      .split(/\r?\n|\r/)
      .map((line) => line.trim().split(/\s+/))
      .flatMap((tokens) => {
        const index = tokens.findIndex((token) => token.toLowerCase() === wingetPackage.toLowerCase())
        return index === -1 ? [] : tokens.slice(index + 1, index + 2)
      })
      .find((token) => parseReleaseVersion(token))
    if (result.code !== 0 || !version) return yield* Effect.fail(failure(resultDetail(result)))
    return version
  })

  const latest = (selected?: Method) =>
    (selected ? Effect.succeed(selected) : method()).pipe(
      Effect.flatMap((method) =>
        method === "winget" ? wingetVersion() : release(method).pipe(Effect.map((data) => data.version)),
      ),
    )

  const temporaryDirectory = (prefix: string) =>
    Effect.acquireRelease(fs.makeTempDirectory({ directory: global.cache, prefix }), (directory) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    )

  // On Windows the installer must delete or replace the running binary, which only works
  // while another link to it exists (see RetainedImage). Upgrades keep that link in the
  // cache; uninstall has already removed the cache, so it uses the temporary directory.
  const retaining = <A, E, R>(method: Method, effect: Effect.Effect<A, E, R>, directory = global.cache) => {
    if (process.platform !== "win32" || method === "brew") return effect
    // Only the installed binary is at stake; source checkouts run inside bun or node.
    const owned =
      method === "curl"
        ? executable === curlBinary
        : method === "winget"
          ? installedWinget
          : installedPackage !== undefined
    if (!owned) return effect
    return Effect.scoped(RetainedImage.retain(directory, "upgrade").pipe(Effect.andThen(effect))).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
  }

  const runUpgrade = (input: {
    readonly method: Method
    readonly command: string[]
    readonly displayCommand?: string[]
    readonly title?: string
    readonly retry?: string
  }) => {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: input.title ?? `${installNames[input.method]} could not install OpenCode`,
          detail,
          command: (input.displayCommand ?? input.command).join(" "),
          retry: input.retry ?? "Fix the issue above, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    return exec(input.command, "5 minutes").pipe(
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.succeed(result) : Effect.fail(failure(resultDetail(result))),
      ),
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : failure(
              cause instanceof AppProcess.AppProcessError && cause.stderr === undefined && cause.cause === undefined
                ? `Failed to update with ${input.method}`
                : errorDetail(cause),
              cause,
            ),
      ),
    )
  }

  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    const version = input.trim().replace(/^v/, "")
    // The OpenCode installer is not used in this build: curl installs update from GitHub Releases too.
    if (method === "github" || method === "curl")
      return yield* Effect.scoped(
        flock
          .acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
          .pipe(Effect.andThen(githubUpgrade(version))),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof UpgradeError
            ? cause
            : new UpgradeError(
                {
                  title: "Could not install the OpenCode update from GitHub",
                  detail: errorDetail(cause),
                  retry: "Fix the issue above, then run opencode upgrade again.",
                },
                { cause },
              ),
        ),
      )
    const packageName =
      method === "winget"
        ? wingetPackage
        : method === "brew" && installedFormula === "opencode"
          ? "opencode"
          : (yield* release(method)).package
    const target = `${packageName}@${version}`
    if (installedPackage && packageName !== installedPackage && (method === "pnpm" || method === "yarn")) {
      return yield* Effect.fail(new Error(`Reinstall ${target} with ${method} to migrate from ${installedPackage}.`))
    }
    const commands: Record<Exclude<Method, "github" | "bun" | "curl" | "brew" | "winget">, string[]> = {
      // Keep the old package: uninstalling it can unlink the replacement command.
      npm: [
        "npm",
        "install",
        "--global",
        `--allow-scripts=${packageName}`,
        ...((OPENCODE_ARTIFACT === "cli" && !installedPackage?.endsWith("/cli-node")) ||
        (installedPackage && packageName !== installedPackage)
          ? ["--force"]
          : []),
        target,
      ],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${packageName}`, target],
      yarn: ["yarn", "global", "add", target],
      vp:
        installedPackage && packageName !== installedPackage
          ? ["vp", "install", "-g", "--force", target]
          : ["vp", "update", "-g", target],
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Other OpenCode processes may be installing at the same time. Wait longer than the
        // slowest install (curl runs two 5-minute commands).
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        if (method === "bun") {
          // Bun does not prune old versions from its shared package cache.
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const cache = yield* temporaryDirectory("update-")
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: ["bun", "install", "--global", "--trust", "--cache-dir", cache, target],
              displayCommand: ["bun", "install", "--global", "--trust", target],
            }),
          )
        }
        if (method === "brew") return yield* runUpgrade({ method, command: ["brew", "upgrade", packageName] })
        if (method === "winget")
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: [
                "winget",
                "upgrade",
                ...wingetArgs,
                "--version",
                version,
                "--silent",
                "--accept-package-agreements",
              ],
            }),
          )
        return yield* retaining(method, runUpgrade({ method, command: commands[method] }))
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : new UpgradeError(
              {
                title: "Could not prepare the OpenCode upgrade",
                detail: errorDetail(cause),
                retry: "Fix the issue above, then run opencode upgrade again.",
              },
              { cause },
            ),
      ),
      Effect.asVoid,
    )
  })

  const inspect = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      yield* Effect.logInfo("update check skipped", {
        reason: OPENCODE_LOCAL ? "local-install" : "disabled",
        version: OPENCODE_VERSION,
        channel: OPENCODE_CHANNEL,
      })
      return undefined
    }
    const policy = yield* readPolicy()
    if (policy === "disable") {
      yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })
      return undefined
    }

    const current = yield* Ref.get(installedVersion)
    const version = yield* latest()
    yield* Effect.logInfo("update check", {
      current,
      latest: version,
    })
    const next = action(current, version, policy)
    if (next === "none") {
      yield* Effect.logInfo("update check done", { action: "up-to-date" })
      return undefined
    }
    yield* Effect.logInfo("OpenCode update available", { current, latest: version, action: next })
    return { policy, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    if (!detected) {
      yield* Effect.logWarning("update skipped: installation method not found")
      return false
    }
    const current = yield* Ref.get(installedVersion)
    yield* upgrade(detected, version)
    yield* Ref.set(installedVersion, version)
    yield* Effect.logInfo("updated OpenCode", { from: current, to: version, method: detected })
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    if (!(yield* install(version)))
      return yield* Effect.fail(
        new Error(
          "Could not detect the installation method. Update with your package manager or download the latest release.",
        ),
      )
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    if (OPENCODE_LOCAL)
      return {
        type: "unavailable" as const,
        message: "This build runs from a source checkout. Use an installed OpenCode release to check for updates.",
      }
    const detected = yield* method()
    if (!detected)
      return {
        type: "unavailable" as const,
        message:
          "Could not detect the installation method. Update with your package manager or download the latest release.",
      }
    const version = yield* latest(detected)
    if (!parseReleaseVersion(version)) return yield* Effect.fail(new Error(`Invalid version: ${version}`))
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none") {
      // An earlier check may have installed the update while this client is still running.
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    }
    return { type: "available" as const, version }
  })

  const run = Effect.fn("cli.updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      onInstall(result.version)
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Service.of({ run, check, apply, method, latest, upgrade, removal })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
