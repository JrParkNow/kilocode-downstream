import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

// kilocode_change start
function invalid(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) {
    throw new Error("expected tool execution to fail")
  }
  const die = exit.cause.reasons.find(Cause.isDieReason)
  const error = die?.defect
  expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
  return error as Tool.InvalidArgumentsError
}
// kilocode_change end

describe("Tool.define", () => {
  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }).pipe(withTmpdirInstance()),
  )

  // Regression for #28438: the wrap is the canonical "untyped → typed" boundary.
  // When the LLM emits a tool call with a payload that fails the parameter
  // schema, the wrap must surface a typed `Tool.InvalidArgumentsError` whose
  // `.message` is the actionable prose the AI SDK feeds back to the model.
  it.effect("invalid args surface as Tool.InvalidArgumentsError with friendly message and JSON path", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on the first questions[] entry.
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)
      const args = invalid(exit) // kilocode_change
      expect(args.tool).toBe("qtest")
      expect(args.message).toContain("qtest tool was called with invalid arguments")
      expect(args.message).toContain("Please rewrite the input")
      expect(args.message).toContain(`["questions"][0]["question"]`)
    }),
  )

  // kilocode_change start
  it.effect("invalid args explain missing required scalar fields without SchemaError jargon", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        pattern: Schema.String,
      })
      const info = yield* Tool.define(
        "grep",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const exit = yield* execute({}, makeCtx()).pipe(Effect.exit)
      const args = invalid(exit)
      expect(args.message).toContain("grep tool was called with invalid arguments")
      expect(args.message).toContain("Please rewrite the input")
      expect(args.detail).toContain(`["pattern"]`)
      expect(args.detail.toLowerCase()).toContain("missing")
      expect(args.detail.toLowerCase()).toContain("required")
      expect(args.message).not.toContain("SchemaError(")
    }),
  )

  it.effect("invalid args enumerate multiple failing fields", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        pattern: Schema.String,
        path: Schema.String,
      })
      const info = yield* Tool.define(
        "multi",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const exit = yield* execute({}, makeCtx()).pipe(Effect.exit)
      const args = invalid(exit)
      expect(args.detail).toContain(`["pattern"]`)
      expect(args.detail).toContain(`["path"]`)
    }),
  )
  // kilocode_change end
  // PERF-4B: `metadata.truncated` can describe semantic partial-result state
  // such as Read pagination or Grep match limits. Its presence alone must not
  // suppress the independent generic model-output safety bound.
  it.effect("semantic truncated metadata does not bypass generic output safety", () =>
    Effect.gen(function* () {
      const output = "x".repeat(Truncate.MAX_BYTES + 128)
      const info = yield* Tool.define(
        "semantic-partial",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({
              title: "test",
              output,
              metadata: { truncated: true },
              outputTruncationSuffix: "(Use offset=42 to continue.)",
            })
          },
        }),
      )

      const tool = yield* info.init()
      const result = yield* tool.execute(
        { input: "ok" },
        {
          ...makeCtx(),
          agent: "code",
        },
      )

      const metadata = result.metadata as {
        truncated?: boolean
        outputPath?: string
      }

      expect(metadata.truncated).toBe(true)
      expect(result.output).not.toBe(output)
      expect(result.output).toContain("The tool call succeeded but the output was truncated")
      expect(result.output).toEndWith("(Use offset=42 to continue.)")
      expect(metadata.outputPath).toBeDefined()
      expect("outputTruncationSuffix" in result).toBe(false)
    }).pipe(withTmpdirInstance()),
  )

  it.effect("explicit output truncation ownership bypasses generic truncation without leaking the marker", () =>
    Effect.gen(function* () {
      const output = "x".repeat(Truncate.MAX_BYTES + 128)
      const info = yield* Tool.define(
        "self-bounded",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({
              title: "test",
              output,
              metadata: { truncated: true, outputPath: "/already/bounded" },
              outputTruncationHandled: true as const,
            })
          },
        }),
      )

      const tool = yield* info.init()
      const result = yield* tool.execute(
        { input: "ok" },
        {
          ...makeCtx(),
          agent: "code",
        },
      )

      expect(result.output).toBe(output)
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.outputPath).toBe("/already/bounded")
      expect("outputTruncationHandled" in result).toBe(false)
    }),
  )

})
