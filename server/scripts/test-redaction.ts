import { redactSensitiveText, sanitizeRecord } from "../src/redaction.js";

const pat = "github_pat_1234567890abcdefghijklmnopqrstuvwxyz1234567890123";
const s = "ined an env-var fine-grained GITHUB_TOKEN (" + pat + ") on top of the prior keyring";
console.log("redactSensitiveText:", redactSensitiveText(s));
console.log("sanitizeRecord:", JSON.stringify(sanitizeRecord({ note: s })));
