import { mcpServiceCall, sealedInputRequired } from "@platform/contracts";
import { z } from "zod";

// The form that asks a person for input inside MCP clients that render MCP
// Apps but cannot show the question in a dialog of their own. Only the form
// calls the `answer` tool, which hosts hide from the model.
export const inputFormUri = "ui://widefleet/input-form.html";

// Tool results carry the form's question here; hosts pass `_meta` to the view
// but not to the model.
export const inputFormMetaKey = "widefleet/input";

export const inputFormQuestion = z.strictObject({
  call: mcpServiceCall,
  inputRequests: sealedInputRequired.shape.inputRequests,
  requestState: sealedInputRequired.shape.requestState,
});

export type InputFormQuestion = z.infer<typeof inputFormQuestion>;

// What the form needs to show a question and answer it.
export const inputFormMeta = (question: InputFormQuestion) => ({
  [inputFormMetaKey]: question,
});
