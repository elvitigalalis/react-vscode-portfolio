// Schema gate: resume.json matches src/data/resume.schema.json. The build checks this too
// (src/data/resume.ts); the gate reports it on its own line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

export async function schema({ root, resume }) {
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(readFileSync(join(root, "src/data/resume.schema.json"), "utf8")));
  return validate(resume) ? [] : validate.errors.map((e) => `resume.json ${e.instancePath || "/"} ${e.message}`);
}
