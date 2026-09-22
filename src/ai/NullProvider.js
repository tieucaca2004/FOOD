import { AIProvider } from "./AIProvider.js";

// Default provider: no LLM calls at all. classify/polish both return null,
// so the deterministic rule engine and templates always drive behavior —
// used in tests and whenever no AI_PROVIDER/API key is configured.
export class NullProvider extends AIProvider {}
