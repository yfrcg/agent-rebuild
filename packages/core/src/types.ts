export type BootstrapFile = {
  name: string;
  path: string;
  content: string;
  missing: boolean;
};

export type BootstrapContext = {
  bootstrapFiles: BootstrapFile[];
  todayMemoryPath: string;
};

export type TranscriptEntry = {
  id: string;
  parentId?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type SearchHit = {
  chunkId: string;
  filePath: string;
  section: string;
  content: string;
};