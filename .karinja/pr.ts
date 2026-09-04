/**
 * Karinja pull-request pipeline for cal.com.
 *
 * Job-for-job counterpart of .github/workflows/pr.yml. Every job in the
 * workflow file has a job here with the same name; generated matrix jobs are
 * named `<job>-shard-<n>`. Every operation below a job header is a sequential
 * `yield*` step; ordering and concurrency live only in the pipeline `run`
 * Effect.
 *
 * Local substitutions versus GitHub Actions (no secrets, no services):
 * - trust-check treats manual and scheduled runs as trusted, exactly like
 *   workflow_dispatch in pr.yml, and calls the GitHub API for webhooks.
 * - `ready-for-e2e` label parity is the `readyForE2e` event input. Without it
 *   the setup-db, build, integration, e2e, and analyze jobs stay skipped, just
 *   like pr.yml.
 * - Jobs that need postgres, mailhog, docker, or repository secrets will fail
 *   here; that is expected and mirrors what GitHub Actions does without them.
 */
import { Effect, Job, Pipeline, Schema, Shell, Workspace } from "@karinja/sdk"
import { GitHubClient } from "@karinja/provider-github"

const ChangeEvent = Schema.Struct({
  provider: Schema.Literal("github"),
  repository: Schema.Struct({ owner: Schema.String, name: Schema.String }),
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  // pr.yml gates the e2e graph on the ready-for-e2e PR label; a manual or
  // scheduled run states the same decision through this input flag.
  readyForE2e: Schema.optional(Schema.Boolean)
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

const prepareOutput = Schema.Struct({
  files: Schema.Array(Schema.String),
  requiresFullChecks: Schema.Boolean,
  hasApiV2Changes: Schema.Boolean,
  hasPrismaChanges: Schema.Boolean,
  headSha: Schema.String
})

const Prepare = Job.define({
  name: "prepare",
  input: ChangeEvent,
  output: prepareOutput,
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
      const inPaths = (paths: ReadonlyArray<string>): boolean =>
        files.some(
          (file) => paths.includes(file) || paths.some((path) => file.startsWith(`${path}/`))
        )

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

      // filter-inclusions in pr.yml: platform or trpc or prisma schema edits.
      const hasApiV2Changes = inPaths([
        "apps/api/v2",
        "packages/platform-constants",
        "packages/platform-enums",
        "packages/platform-utils",
        "packages/platform-types",
        "packages/platform-libraries",
        "packages/trpc",
        "packages/prisma/schema.prisma"
      ])
      const hasPrismaChanges = inPaths(["packages/prisma/schema.prisma", "packages/prisma/migrations"])

      const headSha = yield* shell.exec("git", ["rev-parse", "HEAD"], { cwd: workspace.root })

      return {
        files,
        requiresFullChecks,
        hasApiV2Changes,
        hasPrismaChanges,
        headSha: headSha.stdout.trim()
      }
    })
})

const TrustCheck = Job.define({
  name: "trust-check",
  input: ChangeEvent,
  output: Schema.Struct({
    trusted: Schema.Boolean,
    reason: Schema.String
  }),
  error: JobError,
  resources: "small",
  timeoutMs: 5 * 60_000,
  run: (event) =>
    Effect.gen(function*() {
      // workflow_dispatch and scheduled runs run with repository secrets by
      // definition, so pr.yml trusts them without a pull-request check.
      if (event.trigger !== "webhook") {
        return { trusted: true, reason: `${event.trigger} runs are trusted like workflow_dispatch` }
      }
      const payload = event.payload as { pull_request?: { number?: number } }
      const pullNumber = payload.pull_request?.number
      if (pullNumber === undefined) {
        return { trusted: false, reason: "No pull request context in the webhook payload" }
      }
      const github = yield* GitHubClient
      const pull = yield* Effect.promise(() =>
        github.client.rest.pulls.get({
          owner: event.repository.owner,
          repo: event.repository.name,
          pull_number: pullNumber
        })
      )
      const trusted = ["OWNER", "MEMBER", "COLLABORATOR"].includes(
        pull.data.author_association as string
      )
      return {
        trusted,
        reason: trusted
          ? `Author association ${pull.data.author_association} is trusted`
          : "External contribution requires the run-ci label from a maintainer"
      }
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
      // check-types.yml allows a 12 GB Node heap; the local profile uses 5 GB.
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

const CheckPrismaMigrations = Job.define({
  name: "check-prisma-migrations",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "small",
  timeoutMs: 15 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      // check-prisma-migrations.yml starts a postgres:18 service for the shadow
      // database; this job needs DATABASE_URL and a reachable shadow database.
      yield* shell.exec(
        "npx",
        [
          "prisma",
          "migrate",
          "diff",
          "--exit-code",
          "--from-migrations",
          "./migrations",
          "--to-schema-datamodel",
          "./schema.prisma",
          "--shadow-database-url",
          process.env.DATABASE_URL ?? ""
        ],
        { cwd: `${workspace.root}/packages/prisma` }
      )
      return { name: "check-prisma-migrations", passed: true }
    })
})

const SetupDb = Job.define({
  name: "setup-db",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "small",
  timeoutMs: 15 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      yield* shell.exec("yarn", ["prisma", "generate"], { cwd: workspace.root })
      // setup-db.yml seeds the database and lets the cache-db action dump
      // backups/backup.sql through a docker postgres image.
      yield* shell.exec("yarn", ["db-seed"], { cwd: workspace.root })
      return { name: "setup-db", passed: true }
    })
})

const BuildWeb = Job.define({
  name: "build-web",
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
      // The cache-build action runs the same command when the build cache misses.
      yield* shell.exec("yarn", ["build"], {
        cwd: workspace.root,
        env: { NODE_OPTIONS: "--max_old_space_size=8192" }
      })
      return { name: "build-web", passed: true }
    })
})

const BuildApiV2 = Job.define({
  name: "build-api-v2",
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
      yield* shell.exec("yarn", ["workspace", "@calcom/api-v2", "run", "generate-schemas"], {
        cwd: workspace.root
      })
      yield* shell.run(
        "export NODE_OPTIONS=\"--max_old_space_size=8192\"\nyarn turbo run build --filter=@calcom/api-v2",
        { cwd: workspace.root }
      )
      return { name: "build-api-v2", passed: true }
    })
})

const BuildAtoms = Job.define({
  name: "build-atoms",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "large",
  timeoutMs: 30 * 60_000,
  run: () =>
    Effect.gen(function*() {
      const shell = yield* Shell
      const workspace = yield* Workspace
      // atoms-production-build.yml reinstalls from a clean atoms node_modules
      // instead of using the shared yarn-install action.
      yield* shell.run(
        [
          "export NODE_OPTIONS=\"--max_old_space_size=8192\"",
          "rm -rf packages/platform/atoms/node_modules",
          "yarn install",
          "yarn workspace @calcom/atoms run build-npm"
        ].join("\n"),
        { cwd: workspace.root }
      )
      return { name: "build-atoms", passed: true }
    })
})

const IntegrationTests = Job.define({
  name: "integration",
  input: Schema.Struct({}),
  output: CheckOutput,
  error: JobError,
  resources: "large",
  timeoutMs: 20 * 60_000,
  run: () =>
    Effect.gen(function*() {
      yield* install()
      const shell = yield* Shell
      const workspace = yield* Workspace
      yield* shell.exec("yarn", ["prisma", "generate"], { cwd: workspace.root })
      // integration-tests.yml needs a postgres service and repository secrets.
      yield* shell.exec("yarn", ["test"], {
        cwd: workspace.root,
        env: {
          NODE_OPTIONS: "--max-old-space-size=4096",
          INTEGRATION_TESTS: "true",
          VITEST_MODE: "integration"
        }
      })
      return { name: "integration", passed: true }
    })
})

/** playwright binaries come from the yarn-playwright-install action. */
const playwrightInstall = () =>
  Effect.gen(function*() {
    const shell = yield* Shell
    const workspace = yield* Workspace
    yield* shell.exec("yarn", ["playwright", "install", "--with-deps"], { cwd: workspace.root })
  })

const E2E_SHARDS = [1, 2, 3, 4, 5, 6, 7, 8] as const
const API_V2_SHARDS = [1, 2, 3, 4] as const
const e2eTotal = E2E_SHARDS.length
const apiV2Total = API_V2_SHARDS.length

/** One web e2e shard of the eight-way matrix in e2e.yml. */
const e2eShard = (shard: number) =>
  Job.define({
    name: `e2e-shard-${shard}`,
    input: Schema.Struct({}),
    output: CheckOutput,
    error: JobError,
    resources: "large",
    timeoutMs: 20 * 60_000,
    run: () =>
      Effect.gen(function*() {
        yield* install()
        yield* playwrightInstall()
        const shell = yield* Shell
        const workspace = yield* Workspace
        yield* shell.exec("yarn", ["prisma", "generate"], { cwd: workspace.root })
        yield* shell.exec("yarn", ["e2e", `--shard=${shard}/${e2eTotal}`, "--workers=4"], {
          cwd: workspace.root
        })
        return { name: `e2e-shard-${shard}`, passed: true }
      })
  })

/** One api-v2 e2e shard of the four-way matrix in e2e-api-v2.yml. */
const apiV2Shard = (shard: number) =>
  Job.define({
    name: `e2e-api-v2-shard-${shard}`,
    input: Schema.Struct({}),
    output: CheckOutput,
    error: JobError,
    resources: "large",
    timeoutMs: 20 * 60_000,
    run: () =>
      Effect.gen(function*() {
        yield* install()
        const shell = yield* Shell
        const workspace = yield* Workspace
        yield* shell.run(
          [
            "yarn turbo run build",
            "--filter=@calcom/platform-constants",
            "--filter=@calcom/platform-enums",
            "--filter=@calcom/platform-utils",
            "--filter=@calcom/platform-types",
            "--filter=@calcom/platform-libraries",
            "--filter=@calcom/trpc"
          ].join(" "),
          { cwd: workspace.root }
        )
        yield* shell.exec("yarn", ["test:e2e:ci", `--shard=${shard}/${apiV2Total}`], {
          cwd: `${workspace.root}/apps/api/v2`
        })
        return { name: `e2e-api-v2-shard-${shard}`, passed: true }
      })
  })

const e2eCore = (name: string, script: string) =>
  Job.define({
    name,
    input: Schema.Struct({}),
    output: CheckOutput,
    error: JobError,
    resources: "large",
    timeoutMs: 20 * 60_000,
    run: () =>
      Effect.gen(function*() {
        yield* install()
        yield* playwrightInstall()
        const shell = yield* Shell
        const workspace = yield* Workspace
        yield* shell.exec("yarn", ["prisma", "generate"], { cwd: workspace.root })
        yield* shell.run(script, { cwd: workspace.root })
        return { name, passed: true }
      })
  })

const E2EAppStore = e2eCore("e2e-app-store", "yarn e2e:app-store --workers=4")
const E2EEmbed = e2eCore("e2e-embed", "yarn e2e:embed --workers=4")
const E2EEmbedReact = e2eCore(
  "e2e-embed-react",
  "yarn e2e:embed-react --workers=4\nyarn workspace @calcom/embed-react packaged:tests"
)

const Analyze = Job.define({
  name: "analyze",
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
      // nextjs-bundle-analysis.yml reports on the cached production build.
      yield* shell.exec("npx", ["-p", "nextjs-bundle-analysis@0.5.0", "report"], {
        cwd: `${workspace.root}/apps/web`,
        env: { NODE_OPTIONS: "--max_old_space_size=8192" }
      })
      return { name: "analyze", passed: true }
    })
})

const webShardJobs = E2E_SHARDS.map((shard) => e2eShard(shard))
const apiV2ShardJobs = API_V2_SHARDS.map((shard) => apiV2Shard(shard))
const byName = <J extends { readonly name: string }>(jobs: ReadonlyArray<J>): Record<string, J> =>
  Object.fromEntries(jobs.map((job) => [job.name, job]))

export default Pipeline.define({
  name: "pr",
  input: ChangeEvent,
  output: Schema.Struct({
    _tag: Schema.Literals(["Passed", "Skipped", "Blocked"]),
    checks: Schema.optional(Schema.Array(Schema.String)),
    reason: Schema.optional(Schema.String)
  }),
  error: JobError,
  jobs: {
    "trust-check": TrustCheck,
    prepare: Prepare,
    lint: Lint,
    "type-check": TypeCheck,
    unit: UnitTests,
    "api-v2-unit": ApiV2UnitTests,
    security: SecurityAudit,
    "check-prisma-migrations": CheckPrismaMigrations,
    "setup-db": SetupDb,
    "build-web": BuildWeb,
    "build-api-v2": BuildApiV2,
    "build-atoms": BuildAtoms,
    integration: IntegrationTests,
    ...byName(webShardJobs),
    ...byName(apiV2ShardJobs),
    "e2e-app-store": E2EAppStore,
    "e2e-embed": E2EEmbed,
    "e2e-embed-react": E2EEmbedReact,
    analyze: Analyze
  },
  run: (event) =>
    Effect.gen(function*() {
      // Security gate: pr.yml blocks every other job until trust-check passes.
      const trust = yield* Job.execute(TrustCheck, event)
      if (!trust.trusted) {
        return {
          _tag: "Blocked" as const,
          reason: trust.reason
        }
      }

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
        { concurrency: 1, mode: "result" }
      )
      yield* Pipeline.requireAll({
        lint: checks.lint,
        typeCheck: checks.typeCheck,
        unit: checks.unit,
        apiV2Unit: checks.apiV2Unit,
        security: checks.security,
        ...(plan.hasPrismaChanges
          ? { prismaMigrations: yield* Job.execute(CheckPrismaMigrations, {}) }
          : {})
      })

      // pr.yml's e2e half only runs with the ready-for-e2e label; the same
      // decision comes through the event input here. setup-db and the three
      // builds precede the tests, exactly as in the workflow file.
      if (event.readyForE2e === true) {
        yield* Job.execute(SetupDb, {})
        const builds = yield* Effect.all(
          {
            web: Job.execute(BuildWeb, {}),
            apiV2: Job.execute(BuildApiV2, {}),
            atoms: Job.execute(BuildAtoms, {})
          },
          { concurrency: 1, mode: "result" }
        )
        const webShards = yield* Effect.all(
          webShardJobs.map((job) => Job.execute(job, {})),
          { concurrency: 1, mode: "result" }
        )
        const apiV2Shards = yield* Effect.all(
          apiV2ShardJobs.map((job) => Job.execute(job, {})),
          { concurrency: 1, mode: "result" }
        )
        const e2e = yield* Effect.all(
          {
            integration: Job.execute(IntegrationTests, {}),
            appStore: Job.execute(E2EAppStore, {}),
            embed: Job.execute(E2EEmbed, {}),
            embedReact: Job.execute(E2EEmbedReact, {}),
            analyze: Job.execute(Analyze, {})
          },
          { concurrency: 1, mode: "result" }
        )
        yield* Pipeline.requireAll({
          ...builds,
          ...Object.fromEntries(webShardJobs.map((job, index) => [job.name, webShards[index]!])),
          ...Object.fromEntries(apiV2ShardJobs.map((job, index) => [job.name, apiV2Shards[index]!])),
          ...e2e
        })
      }

      return {
        _tag: "Passed" as const,
        checks: ["lint", "type-check", "unit", "api-v2-unit", "security"]
      }
    })
})
