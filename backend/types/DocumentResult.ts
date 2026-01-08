export type DocumentResult = {
  description: string;
  url: string;
  type: "pdf" | "docx" | "unknown";
  ocrUsed: boolean;
  markdown: string | null;
};
