/**
 * Karinja pull-request pipeline for cal.com.
 *
 * Each job maps to one selected job from .github/workflows/pr.yml. Every
 * operation below a job header is a sequential `yield*` step; ordering and
 * concurrency live only in the pipeline `run` Effect.
 */
import { Effect, Job, Pipeline, Schema, Shell, Workspace } from "@karinja/sdk"

const ChangeEvent = Schema.Struct({
  _tag: Schema.Literal("ChangeRequest"),
  provider: Schema.Literal("github"),
  repository: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String })
})

const CheckOutput = Schema.Struct({
  name: Schema.String,
  passed: Schema.Boolean
})

const JobError = Schema.Struct({
  name: Schema.String,
  message: Schema.String
})

const install = () =>
  Effect.gen(function*() {
    const shell = yield* Shell
    const workspace = yield* Workspace
    // The worker mounts the benchmark cache volume at /cache. Persisting the
    // yarn fetch cache is what separates a warm run from a cold one.
    yield* shell.exec("yarn", ["install", "--inline-builds"], {
      cwd: workspace.root,
      env: { YARN_ENABLE_GLOBAL_CACHE: "true", YARN_GLOBAL_FOLDER: "/cache/yarn" }
    })
  })

const Prepare = Job.define({
  name: "prepare",
  input: ChangeEvent,
  output: Schema.Struct({
    files: Schema.Array(Schema.String),
    requiresFullChecks: Schema.Boolean
  }),
  error: JobError,
  resources: "small",
  timeoutMs: 5 * 60_000,
  run: (event) =>
    Effect.gen(function*() {
      const shell = yield* Shell
      const workspace = yield* Workspace

      const diff = yield* shell.exec(
        "git",
        ["diff", "--name-only", event.base.sha, event.head.sha],
        { cwd: workspace.root }
      )
      const files = diff.stdout.split("\n").filter((file) => file.length > 0)

      // Mirrors the dorny/paths-filter exclusions in .github/workflows/pr.yml:
      // a run is skipped when every changed file matches an exclusion.
      const excluded = (file: string): boolean =>
        file.startsWith(".vscode/") ||
        file.endsWith(".md") ||
        file.endsWith(".mdx") ||
        file === ".github/CODEOWNERS" ||
        file.startsWith("docs/") ||
        file.startsWith("help/") ||
        (file.startsWith("packages/i18n/locales/") && file.endsWith("/common.json")) ||
        file === "i18n.lock"
      const requiresFullChecks = files.length > 0 && !files.every(excluded)

      return { files, requiresFullChecks }
    })
})

const Lint = Job.define({
  name: "lint",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "medium",
  timeoutMs: 20 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      yield* shell.exec("yarn", ["lint"], { cwd: workspace.root })
      return { name: "lint", passed: true }
    })
})

const TypeCheck = Job.define({
  name: "type-check",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "large",
  timeoutMs: 30 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      // check-types.yml allows a 12 GB Node heap for the type check.
      yield* shell.exec("yarn", ["type-check:ci"], {
        cwd: workspace.root,
        env: { NODE_OPTIONS: "--max-old-space-size=5120" }
      })
      return { name: "type-check", passed: true }
    })
})

const UnitTests = Job.define({
  name: "unit",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "large",
  timeoutMs: 30 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      yield* shell.exec("yarn", ["prisma", "generate"], { cwd: workspace.root })
      yield* shell.exec("yarn", ["test", "--", "--no-isolate"], { cwd: workspace.root })
      yield* shell.exec("yarn", ["test", "--", "--no-isolate"], {
        cwd: workspace.root,
        env: { TZ: "America/Los_Angeles", VITEST_MODE: "timezone" }
      })
      return { name: "unit", passed: true }
    })
})

const ApiV2UnitTests = Job.define({
  name: "api-v2-unit",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "large",
  timeoutMs: 30 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      yield* shell.exec("yarn", ["prisma", "generate"], { cwd: workspace.root })
      // api-v2-unit-tests.yml builds the platform libraries before running tests.
      yield* shell.exec("yarn", ["workspace", "@calcom/platform-libraries", "build"], {
        cwd: workspace.root,
        env: { NODE_OPTIONS: "--max_old_space_size=3072" }
      })
      yield* shell.exec("yarn", ["test"], { cwd: workspace.root })
      return { name: "api-v2-unit", passed: true }
    })
})

const SecurityAudit = Job.define({
  name: "security",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "small",
  timeoutMs: 10 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      // The advisory report never fails the job; only critical findings do.
      yield* shell.exec("yarn", ["npm", "audit", "--all", "--recursive"], {
        cwd: workspace.root,
        allowFailure: true
      })
      yield* shell.exec("yarn", ["npm", "audit", "--all", "--recursive", "--severity", "critical"], {
        cwd: workspace.root
      })
      return { name: "security", passed: true }
    })
})

export default Pipeline.define({
  name: "pr",
  input: ChangeEvent,
  output: Schema.Struct({
    _tag: Schema.Literals(["Passed", "Skipped"]),
    checks: Schema.optional(Schema.Array(Schema.String)),
    reason: Schema.optional(Schema.String)
  }),
  error: JobError,
  jobs: {
    prepare: Prepare,
    lint: Lint,
    "type-check": TypeCheck,
    unit: UnitTests,
    "api-v2-unit": ApiV2UnitTests,
    security: SecurityAudit
  },
  run: (event) =>
    Effect.gen(function*() {
      // Hard dependency: no check starts before prepare completes.
      const plan = yield* Job.execute(Prepare, event)

      if (!plan.requiresFullChecks) {
        return {
          _tag: "Skipped" as const,
          reason: "No files require the full check set"
        }
      }

      // Effect owns worker concurrency; at most two checks run at once.
      const checks = yield* Effect.all(
        {
          lint: Job.execute(Lint, {}),
          typeCheck: Job.execute(TypeCheck, {}),
          unit: Job.execute(UnitTests, {}),
          apiV2Unit: Job.execute(ApiV2UnitTests, {}),
          security: Job.execute(SecurityAudit, {})
        },
        { concurrency: 2, mode: "result" }
      )
      yield* Pipeline.requireAll(checks)

      return {
        _tag: "Passed" as const,
        checks: ["lint", "type-check", "unit", "api-v2-unit", "security"]
      }
    })
})
