const { spawn } = require("node:child_process");

function main() {
  const payloadBase64 = process.argv[2];
  if (!payloadBase64) {
    console.error("[mcp-runner] missing payload");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf8"));
  } catch (error) {
    console.error(
      `[mcp-runner] invalid payload: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  if (!payload || typeof payload !== "object" || typeof payload.command !== "string") {
    console.error("[mcp-runner] payload.command must be a string");
    process.exit(1);
  }

  const child = spawn(payload.command, Array.isArray(payload.args) ? payload.args : [], {
    cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
    env: isStringRecord(payload.env) ? payload.env : process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on("error", (error) => {
    console.error(
      `[mcp-runner] child spawn failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  const forwardSignal = (signal) => {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  };

  forwardSignal("SIGINT");
  forwardSignal("SIGTERM");
}

function isStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}

main();
