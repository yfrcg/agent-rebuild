import { loadBootstrapContext } from "../core/src/bootstrap";

export function printBootstrapStatus(): void {
  const ctx = loadBootstrapContext();

  console.log("\n[bootstrap loaded]");
  for (const file of ctx.bootstrapFiles) {
    console.log(`- ${file.name}: ${file.missing ? "missing" : "ok"}`);
  }
  console.log("");
}