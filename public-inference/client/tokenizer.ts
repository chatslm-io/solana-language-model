/** Client-side reference tokenizer for comparing on-chain tokenization results. */
import { createHash } from "node:crypto";
import { canonical } from "../../lib/model/manifest";
import {
  gpt2Tokenizer,
  type Gpt2Vocabulary,
} from "../../private-inference/reference/tokenizer";
import type { PublicModelPlan } from "../compiler/model";
export type PublicMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
export function publicTokenizer(
  plan: PublicModelPlan,
  vocabulary: Gpt2Vocabulary,
  template: string,
) {
  if (
    sha(canonical(vocabulary.tokens)) !== plan.tokenizer.vocabularySha256 ||
    sha(canonical(vocabulary.merges)) !== plan.tokenizer.mergesSha256 ||
    sha(template) !== plan.tokenizer.templateSha256
  )
    throw Error("public_tokenizer_identity");
  const tokenizer = gpt2Tokenizer(vocabulary);
  return {
    scope: "client-tokenization-public-inputs" as const,
    encodeMessages(
      messages: readonly PublicMessage[],
      generationTokens: number,
    ) {
      if (
        !Number.isInteger(generationTokens) ||
        generationTokens < 1 ||
        generationTokens > 16 ||
        messages.length < 1
      )
        throw Error("public_token_budget");
      const ids: number[] = [];
      for (const message of messages) {
        if (
          !["system", "user", "assistant"].includes(message.role) ||
          typeof message.content !== "string"
        )
          throw Error("public_message");
        ids.push(
          plan.tokenizer.special[message.role],
          ...tokenizer.encode(message.content),
          plan.tokenizer.special.end,
        );
      }
      ids.push(plan.tokenizer.special.assistant);
      if (ids.length + generationTokens > 16)
        throw Error("public_context_16_exceeded");
      return { tokens: ids, generationTokens };
    },
    decode(tokens: readonly number[]) {
      if (tokens.some((id) => !Number.isInteger(id) || id < 0 || id >= 8196))
        throw Error("public_token_id");
      return tokenizer.decode([...tokens]);
    },
  };
}
