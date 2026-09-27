import { platformConfig } from "../../config.js";
import { NullImageUnderstanding } from "./ImageUnderstandingProvider.js";

// IMAGE_UNDERSTANDING_PROVIDER: "null" (default — images are stored as evidence, nothing is read) | "openai".
export async function createImageUnderstanding() {
  if (platformConfig.imageUnderstandingProvider === "openai" && platformConfig.openaiApiKey) {
    const { OpenAIImageUnderstanding } = await import("./OpenAIImageUnderstanding.js");
    return new OpenAIImageUnderstanding();
  }
  return new NullImageUnderstanding();
}
