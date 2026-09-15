import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"

const Parameters = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
})

export const EvidenceCompleteTool = Tool.define(
  "evidence_complete",
  Effect.succeed({
    description:
      "Signal that Code-mode evidence gathering is sufficient to answer the user's request. Call this only when the requested claims are sufficiently supported, no concrete unresolved question necessary to the answer remains, and no material contradiction remains unresolved. After calling this tool, synthesize the final response from the evidence already gathered instead of performing further reconnaissance.",
    parameters: Parameters,
    execute: (input: Schema.Schema.Type<typeof Parameters>) =>
      Effect.succeed({
        title: "Evidence complete",
        output:
          "Evidence completion recorded for this turn. Give the final response using the evidence already gathered without further reconnaissance.",
        metadata: { reason: input.reason },
      }),
  }),
)
