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
import { rebuildMemoryIndex } from "../../../packages/memory/src/memoryIndex";

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
      rl.close();
      break;
    }

    if (raw === "help") {
      printHelp();
      continue;
    }

    if (raw === "flush") {
      const res = preCompactionFlush(sessionId);
      rebuildMemoryIndex();
      console.log("[pre-compaction flush]", res);
      continue;
    }

    if (raw === "recover") {
      const ctx = postCompactionRecovery();
      console.log("[post-compaction recovery]");
      for (const file of ctx.bootstrapFiles) {
        console.log(`- ${file.name}: ${file.missing ? "missing" : "ok"}`);
      }
      continue;
    }

    if (raw.startsWith("记住：") || raw.startsWith("记住:") || raw.startsWith("记住 ")) {
      const text = raw.replace(/^记住[:： ]*/, "").trim();
      const kind = classifyMemory(text);

      if (kind === "long-term") {
        writeLongTermMemory(text);
        console.log("[saved] MEMORY.md");
      } else {
        writeDailyMemory(text);
        console.log("[saved] daily memory");
      }

      rebuildMemoryIndex();
      continue;
    }

    if (raw.startsWith("查记忆 ")) {
      const query = raw.replace(/^查记忆 /, "").trim();
      const hits = await hybridSearch(query, 5);

      if (hits.length === 0) {
        console.log("[search] no hits");
        continue;
      }

      console.log("[search results]");
      hits.forEach((hit, idx) => {
        console.log(`\n#${idx + 1}`);
        console.log(`file: ${hit.filePath}`);
        console.log(`section: ${hit.section}`);
        console.log(hit.content.slice(0, 200));
      });
      continue;
    }

    if (raw.startsWith("读文件 ")) {
      const file = raw.replace(/^读文件 /, "").trim();
      try {
        const result = memoryGet(file);
        console.log("\n[file content]");
        console.log(result.text);
      } catch (err) {
        console.error(String(err));
      }
      continue;
    }

    writeDailyMemory(`Conversation note: ${raw}`);
    rebuildMemoryIndex();
    console.log("[noted] written to daily memory");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});