export type ExtractedPhoto = {
  s3Key: string;
  width: number;
  height: number;
  index: number;
  /** Source document description */
  sourceDocument?: string;
};

export type DocumentResult = {
  description: string;
  url: string;
  localUrl: string;
  type: "pdf" | "docx" | "unknown";
  ocrUsed: boolean;
  markdown: string | null;
};
