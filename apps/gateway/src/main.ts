import { randomUUID } from "crypto";
import * as readline from "readline";

import { loadBootstrapContext } from "../../../packages/core/src/bootstrap";
import type { TranscriptEntry } from "../../../packages/core/src/types";
import { appendTranscript } from "../../../packages/session/src/transcript";
import { preCompactionFlush, postCompactionRecovery } from "../../../packages/session/src/compaction";
import { classifyMemory } from "../../../packages/memory/src/classifyMemory";
import { writeDailyMemory, writeLongTermMemory } from "../../../packages/memory/src/memoryWriter";
import { memoryGet } from "../../../packages/memory/src/memoryGet";
import { hybridSearch } from "../../../packages/memory/src/hybridSearch";
import { upsertFileIndex } from "../../../packages/memory/src/memoryIndex";
import { resolveWorkspacePath } from "../../../packages/core/src/config";

const sessionId = `session-${Date.now()}`;

function makeEntry(role: TranscriptEntry["role"], content: string): TranscriptEntry {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

function printBootstrap() {
  const ctx = loadBootstrapContext();
  console.log("\n[bootstrap loaded]");
  for (const file of ctx.bootstrapFiles) {
    console.log(`- ${file.name}: ${file.missing ? "missing" : "ok"}`);
  }
  console.log("");
}

function printHelp() {
  console.log(`
可用命令：
1. 记住：<内容>
2. 查记忆 <关键词>
3. 读文件 <相对路径>
4. flush
5. recover
6. help
7. exit
`);
}

async function main() {
  printBootstrap();
  printHelp();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask(question: string) {
    return new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
  }

  while (true) {
    const raw = (await ask(">>> ")).trim();
    if (!raw) continue;

    appendTranscript(sessionId, makeEntry("user", raw));

    if (raw === "exit") {
      console.log("Bye.");
      appendTranscript(sessionId, makeEntry("assistant", "Bye."));
      rl.close();
      break;
    }

    if (raw === "help") {
      printHelp();
      appendTranscript(sessionId, makeEntry("assistant", "Displayed help menu."));
      continue;
    }

    if (raw === "flush") {
      const res = preCompactionFlush(sessionId);
      upsertFileIndex(resolveWorkspacePath("MEMORY.md"));
      console.log("[pre-compaction flush]", res);
      appendTranscript(sessionId, makeEntry("tool", `[pre-compaction flush] ${res.message}`));
      continue;
    }

    if (raw === "recover") {
      const ctx = postCompactionRecovery();
      console.log("[post-compaction recovery]");
      for (const file of ctx.bootstrapFiles) {
        console.log(`- ${file.name}: ${file.missing ? "missing" : "ok"}`);
      }
      appendTranscript(sessionId, makeEntry("tool", "[post-compaction recovery] restored from flush."));
      continue;
    }

    if (raw.startsWith("记住：") || raw.startsWith("记住:") || raw.startsWith("记住 ")) {
      const text = raw.replace(/^记住[:： ]*/, "").trim();
      const kind = classifyMemory(text);

      if (kind === "long-term") {
        writeLongTermMemory(text);
        upsertFileIndex(resolveWorkspacePath("MEMORY.md"));
        console.log("[saved] MEMORY.md");
        appendTranscript(sessionId, makeEntry("assistant", "[saved] MEMORY.md"));
      } else {
        writeDailyMemory(text);
        upsertFileIndex(resolveWorkspacePath("memory", "2026-04-20.md"));
        console.log("[saved] daily memory");
        appendTranscript(sessionId, makeEntry("assistant", "[saved] daily memory"));
      }
      continue;
    }

    if (raw.startsWith("查记忆 ")) {
      const query = raw.replace(/^查记忆 /, "").trim();
      const hits = await hybridSearch(query, 5);

      if (hits.length === 0) {
        console.log("[search] no hits");
        appendTranscript(sessionId, makeEntry("assistant", "[search] no hits"));
        continue;
      }

      console.log("[search results]");
      hits.forEach((hit, idx) => {
        console.log(`\n#${idx + 1}`);
        console.log(`file: ${hit.filePath}`);
        console.log(`section: ${hit.section}`);
        console.log(hit.content.slice(0, 200));
      });

      const summary = hits.map((h, i) => `#${i + 1}: ${h.content.slice(0, 80)}`).join("\n");
      appendTranscript(sessionId, makeEntry("assistant", `[search results]\n${summary}`));
      continue;
    }

    if (raw.startsWith("读文件 ")) {
      const file = raw.replace(/^读文件 /, "").trim();
      try {
        const result = memoryGet(file);
        console.log("\n[file content]");
        console.log(result.text);
        appendTranscript(sessionId, makeEntry("assistant", `[file content]\n${result.text}`));
      } catch (err) {
        console.error(String(err));
        appendTranscript(sessionId, makeEntry("assistant", `[error] ${String(err)}`));
      }
      continue;
    }

    writeDailyMemory(`Conversation note: ${raw}`);
    upsertFileIndex(resolveWorkspacePath("memory", "2026-04-20.md"));
    console.log("[noted] written to daily memory");
    appendTranscript(sessionId, makeEntry("assistant", "[noted] written to daily memory"));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});