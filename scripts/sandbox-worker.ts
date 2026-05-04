import { createSandboxWorkerServer } from "../packages/sandbox/src/server";

async function main(): Promise<void> {
  const port = readPort(process.env.SANDBOX_PORT) ?? 8765;
  const server = createSandboxWorkerServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });

  console.log(`[sandbox-worker] listening on http://127.0.0.1:${port}`);
}

function readPort(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

main().catch((error) => {
  console.error(
    "[sandbox-worker] failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
